import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { GameState, GameAction, Card as CardType, CombatEffect, RoomSnapshot, RoomMember, ChatMessage } from '../types';
import { getAttackValue, getRankValue, isSelectionValid, calculateBlowDamage, isSuitImmune, suitOrder } from '../gameLogic';
import { decideBufferedActionsToReplay } from '../reconnectLogic';
import { installAudioUnlock, isMuted, playBellChime, setMuted } from '../sound';
import { shouldRingTurnChime } from '../turnChime';
import { newestSeen, unreadCount } from '../chatUnread';

const BASE_TITLE = 'King Killer';
const YOUR_TURN_TITLE = 'Your Turn! - King Killer';

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE = import.meta.env.VITE_API_BASE ?? (IS_LOCAL ? `http://${window.location.hostname}:3000` : '');
const WS_BASE = import.meta.env.VITE_WS_BASE ?? (IS_LOCAL ? `ws://${window.location.hostname}:3000` : '');

// Timings for the defeat flow (in ms). The card must be shown long enough for
// the killing blow to land before it flies off to its pile.
const DEFEAT_BLOW_MS = 450;
const DEFEAT_FLIGHT_MS = 650;

export interface FlightBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A seat restored from localStorage may be garbage (hand-edited, or left over
 * from a bigger table that has since been reset), and `players[NaN]` blows up
 * the whole board. Only ever adopt a seat that parses to a real index.
 */
const parseSeat = (raw: string | null): number | null => {
  if (raw === null) return null;
  const seat = Number.parseInt(raw, 10);
  return Number.isInteger(seat) && seat >= 0 ? seat : null;
};

export interface DefeatFlight {
    id: number; // uniquely identifies this defeat
    card: CardType;
    dest: 'tavern' | 'discard';
    flying: boolean; // true once the card can fly (from/to measured)
    from?: FlightBox; // screen rect of the defeated enemy
    to?: FlightBox; // screen rect the card lands on
}

export const useGameLogic = () => {
  const [gameId, setGameId] = useState<string | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null);
  const [roster, setRoster] = useState<RoomMember[]>([]);
  const [localGameState, setLocalGameState] = useState<GameState | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showGameOver, setShowGameOver] = useState(true);
  const [activeEffects, setActiveEffects] = useState<CombatEffect[]>([]);
  const [defeatFlight, setDefeatFlight] = useState<DefeatFlight | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const gameConnectedRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectingRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferedActionsRef = useRef<GameAction[]>([]);
  const backoffRef = useRef(500);
  const lastGameStateJsonRef = useRef<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [muted, setMutedState] = useState<boolean>(() => isMuted());
  const [chat, setChat] = useState<ChatMessage[]>([]);
  // Timestamp of the newest message already seen, so the HUD can badge unread
  // ones without the panel being mounted.
  //
  // Deliberately not a count: the server caps history at 100, so once that cap
  // is reached `chat.length` stops growing and a count-based badge would freeze
  // and never report another unread message for the rest of the session.
  const [chatSeenAt, setChatSeenAt] = useState(0);
  // Games whose join request is currently in flight. Joining claims a seat on
  // the server, so a duplicate (React StrictMode double-invokes the URL-join
  // effect, and a user can press Enter twice) must never fire two join calls.
  const joiningRef = useRef<Set<string>>(new Set());
  // Detects the transition into "my turn" so the chime only rings when the
  // turn actually arrives, not on the initial load (e.g. you created the game).
  const wasMyTurnRef = useRef<boolean | null>(null);
  // Pending activeEffects expiry timers, so they don't fire after unmount.
  const effectTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Combat-effect ids were Date.now() + 1..4, so two batches raised within a
  // few milliseconds of each other overlapped: duplicate React keys, and one
  // batch's expiry filter removing the other's effects. A counter can't collide.
  const effectIdRef = useRef(0);
  // The board's delayed mirror and the newest server state, mirrored into refs
  // because `applyServerState` runs from a socket event rather than a render:
  // a captured value would be stale by the time a frame arrives.
  const localStateRef = useRef<GameState | null>(null);
  const serverStateRef = useRef<GameState | null>(null);
  // Timers for an in-progress defeat transition, so a newer state can cancel it.
  const transitionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTransitionTimers = useCallback(() => {
    transitionTimersRef.current.forEach(clearTimeout);
    transitionTimersRef.current = [];
  }, []);

  /** Single place that advances the board, keeping state and ref in step. */
  const commitLocalState = useCallback((gs: GameState | null) => {
    localStateRef.current = gs;
    setLocalGameState(gs);
  }, []);

  useEffect(() => () => {
    effectTimersRef.current.forEach(clearTimeout);
    effectTimersRef.current = [];
    transitionTimersRef.current.forEach(clearTimeout);
    transitionTimersRef.current = [];
  }, []);

  const isMyTurn = localGameState?.current_player_index === myPlayerId;
  const isSolo = localGameState?.players.length === 1;
  // A member seated beyond the active game's player count watches the game.
  const isSpectator = localGameState !== null && myPlayerId !== null && myPlayerId >= localGameState.players.length;

  // Audio can only be started from a user gesture, and the chime fires from a
  // state update — never a gesture. Arm the context on the first interaction
  // with the page so the chime can actually sound later.
  useEffect(() => installAudioUnlock(), []);

  // Ring the bell when the turn arrives, so the next player knows they're up
  // without watching the screen. See `shouldRingTurnChime` for the rule.
  useEffect(() => {
    if (!localGameState || myPlayerId === null) return;
    const prev = wasMyTurnRef.current;
    wasMyTurnRef.current = isMyTurn;
    if (shouldRingTurnChime(prev, isMyTurn, isSolo)) playBellChime();
  }, [localGameState, myPlayerId, isMyTurn, isSolo]);

  // Flash the tab title while it's our turn and the tab is unfocused, so a
  // player in another tab notices. Stops as soon as the tab gets focus.
  useEffect(() => {
    if (!isMyTurn) {
      document.title = BASE_TITLE;
      return;
    }
    let flashing = false;
    const tick = () => {
      if (document.hasFocus()) {
        document.title = BASE_TITLE;
        return;
      }
      flashing = !flashing;
      document.title = flashing ? YOUR_TURN_TITLE : BASE_TITLE;
    };
    tick();
    const interval = setInterval(tick, 1000);
    const onFocus = () => { document.title = BASE_TITLE; };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.title = BASE_TITLE;
    };
  }, [isMyTurn]);

  // Commit the server state that a defeat's in-flight card just landed at.
  const finishDefeatFlight = useCallback((flightId?: number) => {
    setDefeatFlight(f => (flightId !== undefined && f?.id !== flightId ? f : null));
    const server = serverStateRef.current;
    if (server) commitLocalState(server);
    if (server?.status !== 'InProgress') setShowGameOver(true);
  }, [commitLocalState]);

  /**
   * Applies a freshly-received server state to the board.
   *
   * Called from the socket handler (and the REST responses that seed a session)
   * rather than from an effect watching server state. The trigger is genuinely an
   * external event, not a render, which is where React wants this work — and it
   * means the delayed mirror is no longer driven by a render cycle.
   *
   * `localGameState` deliberately lags the server so the board can keep showing
   * a defeated enemy while its card flies to a pile. Previous state is read from
   * a ref because this runs in an event, not a render, so a captured value would
   * be stale.
   */
  const applyServerState = useCallback((next: GameState) => {
    // A newer state supersedes any transition still in flight.
    clearTransitionTimers();
    const prev = localStateRef.current;
    if (prev) {
        if (next.seed !== prev.seed) {
            // A brand-new deal replaced this game (New Game / Play Again):
            // snap to the fresh board instead of animating a defeat flight.
            commitLocalState(next);
            setDefeatFlight(null);
            setSelectedIndices([]);
            if (next.status !== 'InProgress') setShowGameOver(true);
            return;
        }
        const effects: CombatEffect[] = [];
        const nextEffectId = () => ++effectIdRef.current;
        const enemyChanged = prev.active_enemy && next.active_enemy && prev.active_enemy.card.id !== next.active_enemy.card.id;
        if (enemyChanged && prev.active_enemy) {
            // An enemy was just defeated (a new one appeared). Show the killing blow
            // over the old enemy's health before it flies away.
            const blow = calculateBlowDamage(next.last_played ?? [], prev.active_enemy);
            if (blow > 0) effects.push({ id: nextEffectId(), suit: 'Clubs', value: `-${blow}`, type: 'damage' });
        } else if (next.active_enemy && prev.active_enemy) {
            const damage = prev.active_enemy.current_health - next.active_enemy.current_health;
            if (damage > 0) effects.push({ id: nextEffectId(), suit: 'Clubs', value: `-${damage}`, type: 'damage' });
        }
        if (next.shield_value > prev.shield_value) {
            effects.push({ id: nextEffectId(), suit: 'Spades', value: `+${next.shield_value - prev.shield_value}`, type: 'shield' });
        }
        if (next.tavern_deck.length > prev.tavern_deck.length && next.discard_pile.length < prev.discard_pile.length) {
            effects.push({ id: nextEffectId(), suit: 'Hearts', value: `+${next.tavern_deck.length - prev.tavern_deck.length}`, type: 'heal' });
        }
        const isJester = next.last_played?.some(c => c.rank === 'Joker');
        const totalHand = (gs: GameState) => gs.players.reduce((sum, p) => sum + p.hand.length, 0);
        if (!isJester && totalHand(next) > totalHand(prev)) {
            effects.push({ id: nextEffectId(), suit: 'Diamonds', value: `+${totalHand(next) - totalHand(prev)}`, type: 'draw' });
        }
        if (effects.length > 0) {
            setActiveEffects(prevEffects => [...prevEffects, ...effects]);
            const timer = setTimeout(() => {
                setActiveEffects(prevEffects => prevEffects.filter(e => !effects.find(ne => ne.id === e.id)));
                effectTimersRef.current = effectTimersRef.current.filter(t => t !== timer);
            }, 1200);
            effectTimersRef.current.push(timer);
        }
    }
    
    const isDefeat = prev?.active_enemy && !next.active_enemy;
    const isEnemySwap = prev?.active_enemy && next.active_enemy && prev.active_enemy.card.id !== next.active_enemy.card.id;

    if (isDefeat) {
        // Win over the final king: no next enemy, so there is nothing to fly to.
        const timer = setTimeout(() => {
            commitLocalState(next);
            if (next.status !== 'InProgress') setShowGameOver(true);
        }, DEFEAT_BLOW_MS);
        transitionTimersRef.current.push(timer);
        return;
    }

    if (isEnemySwap) {
        // A defeat: hold the killing blow briefly, then let the defeated card
        // (rendered as a full-screen overlay in App) fly from the enemy's rect
        // to the destination pile's rect. The local state swap waits for the
        // card to land, so the board keeps showing the old (defeated) enemy
        // until the flight commits.
        const flight: DefeatFlight = {
            id: Date.now(),
            card: prev!.active_enemy!.card,
            dest: next.last_enemy_fate === 'Tavern' ? 'tavern' : 'discard',
            flying: false,
        };
        setDefeatFlight(flight);
        const swapTimer = setTimeout(() => {
            // The defeated enemy is still mounted right now, and the pile slots
            // are always present, so we can measure both and drive a plain
            // animated flight that does not depend on layoutId projection.
            const enemyEl = document.querySelector('[data-testid="enemy-card"]');
            const destEl = document.querySelector(flight.dest === 'tavern' ? '[data-testid="tavern-slot"]' : '[data-testid="discard-slot"]');
            const from = enemyEl?.getBoundingClientRect();
            const to = destEl?.getBoundingClientRect();
            setDefeatFlight(f => (f?.id === flight.id ? {
                ...f,
                flying: true,
                from: from ? { x: from.x, y: from.y, width: from.width, height: from.height } : undefined,
                to: to ? { x: to.x + to.width / 2 - 14, y: to.y + to.height / 2 - 20, width: 28, height: 40 } : undefined,
            } : f));
        }, DEFEAT_BLOW_MS);
        // Safety net: land the card even if the overlay's animation never
        // reports completion (e.g. element re-mounted mid-flight).
        const safetyTimer = setTimeout(() => finishDefeatFlight(flight.id), DEFEAT_BLOW_MS + DEFEAT_FLIGHT_MS + 250);
        transitionTimersRef.current.push(swapTimer, safetyTimer);
        return;
    }

    commitLocalState(next);
    if (next.status !== 'InProgress') setShowGameOver(true);
  }, [clearTransitionTimers, commitLocalState, finishDefeatFlight]);


  // connectWebSocket and scheduleReconnect call each other. Routing the back
  // edge through a ref lets scheduleReconnect be declared first, so it is no
  // longer used before it is declared — which previously only worked because
  // `onclose` happens to fire asynchronously, well after the declaration ran.
  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, backoffRef.current);
  }, []);

  const connectWebSocket = useCallback(() => {
    const id = gameId;
    if (!id || intentionalCloseRef.current) return;
    // The server treats this as the connection's identity (see WsParams in
    // main.rs): it authorizes host-only actions, acting as yourself, and
    // taking your own turn. Connecting without it means being unable to act,
    // so the connect callback depends on myPlayerId and reconnects once the
    // seat is known.
    const seatParam = myPlayerId !== null ? `?seat=${myPlayerId}` : '';
    const socket = new WebSocket(`${WS_BASE}/api/ws/${id}${seatParam}`);
    ws.current = socket;
    // A socket we have already moved on from can still deliver a frame that was
    // in flight when we closed it. Applying it overwrites the room we just
    // switched to with the one we left — which is exactly the "sucked back into
    // the game I just left" symptom. Ignore anything from a superseded socket.
    const isStale = () => ws.current !== socket;
    const onState = (payload: RoomSnapshot) => {
      gameConnectedRef.current = true;
      reconnectingRef.current = false;
      setReconnecting(false);
      backoffRef.current = 500;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const receivedJson = JSON.stringify(payload);
      // If the server was asleep, the state we just received is identical to
      // what we were already showing, so any buffered actions are still
      // valid — replay them. If another client played while we were away,
      // the state advanced and the stale buffer is discarded instead.
      const replay = decideBufferedActionsToReplay(
        bufferedActionsRef.current,
        receivedJson,
        lastGameStateJsonRef.current,
      );
      bufferedActionsRef.current = [];
      for (const action of replay) {
        ws.current?.send(JSON.stringify(action));
      }
      lastGameStateJsonRef.current = receivedJson;
      serverStateRef.current = payload.game;
      setRoster(payload.members);
      setChat(payload.chat ?? []);
      applyServerState(payload.game);
    };
    socket.onmessage = (event) => {
      if (isStale()) return;
      // A malformed frame must not take the handler (and the socket) down.
      let msg: unknown;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'State') {
        onState((msg as { payload: RoomSnapshot }).payload);
        return;
      }
      // Untagged frame: only accept it if it actually looks like a snapshot,
      // rather than casting whatever arrived straight into state.
      if (msg && typeof msg === 'object' && 'game' in msg && 'members' in msg) {
        onState(msg as RoomSnapshot);
      }
    };
    socket.onclose = () => {
      if (isStale() || intentionalCloseRef.current) return;
      // The server stopped itself (idle) or restarted. Resume invisibly:
      // retry with backoff; on success the server sends State and we continue.
      reconnectingRef.current = true;
      setReconnecting(true);
      backoffRef.current = Math.min(backoffRef.current * 1.5, 8000);
      scheduleReconnect();
    };
  }, [gameId, myPlayerId, scheduleReconnect, applyServerState]);

  useEffect(() => {
    connectRef.current = connectWebSocket;
  }, [connectWebSocket]);

  useEffect(() => {
    if (gameId) {
      gameConnectedRef.current = false;
      intentionalCloseRef.current = false;
      bufferedActionsRef.current = [];
      backoffRef.current = 500;
      lastGameStateJsonRef.current = null;
      wasMyTurnRef.current = null;
      connectWebSocket();
    }
    return () => {
      intentionalCloseRef.current = true;
      reconnectingRef.current = false;
      setReconnecting(false);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
    };
  }, [gameId, connectWebSocket]);

  useEffect(() => {
    if (!gameId) return;
    const interval = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN && gameConnectedRef.current) {
        ws.current.send(JSON.stringify({ type: 'Ping' }));
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [gameId]);

  const sortedHand = useMemo(() => {
    if (!localGameState || myPlayerId === null || !localGameState.players[myPlayerId]) return [];
    const handWithIndices = localGameState.players[myPlayerId].hand.map((card, index) => ({ card, originalIndex: index }));
    return handWithIndices.sort((a, b) => {
      const suitA = a.card.suit ? suitOrder.indexOf(a.card.suit) : -1;
      const suitB = b.card.suit ? suitOrder.indexOf(b.card.suit) : -1;
      if (suitA !== suitB) return suitA - suitB;
      return getRankValue(a.card.rank) - getRankValue(b.card.rank);
    });
  }, [localGameState, myPlayerId]);

  const currentTierEnemies = useMemo(() => {
    if (!localGameState?.active_enemy) return [];
    const currentRank = localGameState.active_enemy.card.rank;
    return localGameState.castle_deck.filter(c => JSON.stringify(c.rank) === JSON.stringify(currentRank)).sort((a, b) => {
        const suitA = a.suit ? suitOrder.indexOf(a.suit) : -1;
        const suitB = b.suit ? suitOrder.indexOf(b.suit) : -1;
        return suitA - suitB;
    });
  }, [localGameState]);

  const currentDiscardValue = useMemo(() => {
    if (myPlayerId === null || !localGameState || !localGameState.players[myPlayerId]) return 0;
    return selectedIndices.reduce((sum, idx) => {
        const card = localGameState.players[myPlayerId!].hand[idx];
        return sum + (card ? getAttackValue(card) : 0);
    }, 0);
  }, [selectedIndices, localGameState, myPlayerId]);

  const damageNeeded = useMemo(() => {
    if (typeof localGameState?.phase === 'object' && 'AwaitingDiscard' in localGameState.phase) {
        return localGameState.phase.AwaitingDiscard.damage_to_take;
    }
    return 0;
  }, [localGameState]);

  const discardRemaining = Math.max(0, damageNeeded - currentDiscardValue);

  // A seat that no longer exists on this table (e.g. a 4-player game was reset
  // to 2) must not be used to index into `players`.
  const seatedPlayer = (myPlayerId !== null && localGameState?.players[myPlayerId]) || null;

  // Whether this seat may start a new deal. Mirrors the server's own check
  // (Member.host) so the button reflects reality instead of firing a request
  // the server will silently drop. Defaults to false while the roster is still
  // loading, or for a server old enough not to send `host` at all.
  const isHost = useMemo(
    () => myPlayerId !== null && roster.some(m => m.seat === myPlayerId && m.host === true),
    [roster, myPlayerId]
  );

  /**
   * Rules: a player may not yield once [rules wording removed]. The server enforces it too, but it rejects silently, so
   * the button has to know.
   */
  const canYield = useMemo(() => {
    if (!localGameState) return false;
    const playerCount = localGameState.players.length;
    if (playerCount <= 1) return false;
    return (localGameState.consecutive_yields ?? 0) + 1 < playerCount;
  }, [localGameState]);

  const isImmuneWarning = useMemo(() => {
    if (!localGameState?.active_enemy || selectedIndices.length === 0) return false;
    const enemy = localGameState.active_enemy;
    return selectedIndices.some(idx => isSuitImmune(seatedPlayer?.hand[idx]?.suit, enemy));
  }, [selectedIndices, localGameState, seatedPlayer]);

  const createGame = async (numPlayers: number) => {
    const playerName = localStorage.getItem('kingkiller_player_name') || '';
    setChat([]); setChatSeenAt(0);
    const res = await fetch(`${API_BASE}/api/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_players: numPlayers, player_name: playerName || undefined }),
    });
    if (!res.ok) {
      // Without this the app set gameId to undefined and bounced back to the
      // menu with no explanation.
      alert('Could not start a game. Please try again.');
      return;
    }
    const data = await res.json();
    setGameId(data.id); setRoster(data.state.members); setMyPlayerId(0);
    serverStateRef.current = data.state.game;
    applyServerState(data.state.game);
    localStorage.setItem(`seat_${data.id}`, "0");
    setUrlGameId(data.id);
  };

  // pushState, not replaceState: entering and leaving a game each add a history
  // entry, so the browser Back button steps back into the game you just left
  // instead of navigating out of the app entirely.
  const setUrlGameId = (id: string, push = true) => {
    const url = new URL(window.location.href);
    url.searchParams.set('game', id);
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  };

  const clearUrlGameId = (push = true) => {
    const url = new URL(window.location.href);
    url.searchParams.delete('game');
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  };

  const joinGame = async (input: string, push = true) => {
    const cleanId = input.trim().toUpperCase();
    let id = cleanId;
    if (cleanId.startsWith('HTTP')) {
      const params = new URLSearchParams(new URL(cleanId).search);
      id = params.get('game')?.toUpperCase() ?? '';
    }
    if (!id) return;
    if (joiningRef.current.has(id)) return; // already claiming a seat for this game
    joiningRef.current.add(id);
    try {
      const res = await fetch(`${API_BASE}/api/game/${id}`);
      if (!res.ok) {
        alert("Game not found");
        return;
      }
      const snap = await res.json() as RoomSnapshot;

      // A seat from an earlier session (resume case) skips the join call.
      const savedSeat = parseSeat(localStorage.getItem(`seat_${id}`));
      if (savedSeat !== null) {
        setChat([]); setChatSeenAt(0);
        setGameId(id);
        serverStateRef.current = snap.game;
        applyServerState(snap.game);
        setRoster(snap.members);
        setMyPlayerId(savedSeat);
        setUrlGameId(id, push);
        return;
      }

      const playerName = localStorage.getItem('kingkiller_player_name') || '';
      const joinRes = await fetch(`${API_BASE}/api/game/${id}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playerName || undefined }),
      });
      if (joinRes.ok) {
        const data = await joinRes.json();
        setChat([]); setChatSeenAt(0);
        setGameId(id);
        serverStateRef.current = snap.game;
        applyServerState(snap.game);
        setRoster(snap.members);
        setMyPlayerId(data.seat_index);
        localStorage.setItem(`seat_${id}`, data.seat_index.toString());
        setUrlGameId(id, push);
      } else {
        alert("Could not join the game. Please try again.");
      }
    } finally {
      joiningRef.current.delete(id);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gameParam = params.get('game')?.toUpperCase();
    if (gameParam) joinGame(gameParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the live game id readable from the popstate listener without making
  // the listener depend on it (it is installed once).
  const gameIdRef = useRef<string | null>(null);
  useEffect(() => { gameIdRef.current = gameId; }, [gameId]);

  /** Actions that leave the board alone, so they must not discard a selection
   *  the player is still building. Sending a chat message or renaming yourself
   *  used to silently clear the cards you had just picked out. */
  const KEEPS_SELECTION: GameAction['type'][] = ['SendChat', 'SetName'];

  const sendAction = (action: GameAction) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(action));
    } else {
      // Socket is down (server asleep/restarting). Queue until the reconnect
      // arrives; the onState handler replays the buffer if nothing moved.
      bufferedActionsRef.current.push(action);
    }
    if (!KEEPS_SELECTION.includes(action.type)) setSelectedIndices([]);
  };

  // Persist the player's name locally AND broadcast it to the table, so
  // everyone (including a player who only joined a game) can pick a name.
  const renamePlayer = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem('kingkiller_player_name', trimmed);
    if (myPlayerId !== null) sendAction({ type: 'SetName', payload: { seat: myPlayerId, name: trimmed } });
  };

  const sendChat = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendAction({ type: 'SendChat', payload: { text: trimmed } });
  };

  const toggleMute = useCallback(() => {
    const next = !isMuted();
    setMuted(next);
    setMutedState(next);
    // Unmuting happens inside a click, which is a real user gesture: ring once
    // so the player hears the level and the audio context is armed at the same
    // moment, rather than on some later turn change.
    if (!next) playBellChime();
  }, []);

  const chooseNextPlayer = (index: number) => {
    sendAction({ type: 'ChooseNextPlayer', payload: { index } });
  };

  const toggleCard = (originalIndex: number) => {
    if (!localGameState || myPlayerId === null) return;
    if (localGameState.phase === 'AwaitingNextPlayer') return;
    const card = localGameState.players[myPlayerId].hand[originalIndex];
    if (!card) return;
    if (selectedIndices.includes(originalIndex)) {
      setSelectedIndices(prev => prev.filter(i => i !== originalIndex));
    } else {
      const cSel = selectedIndices.map(idx => localGameState.players[myPlayerId!].hand[idx]).filter(Boolean) as CardType[];
      if (isSelectionValid(card, cSel, localGameState.phase)) setSelectedIndices(prev => [...prev, originalIndex]);
    }
  };

  const copyId = () => {
    if (gameId) {
      navigator.clipboard.writeText(`${window.location.origin}?game=${gameId}`);
      setCopySuccess(true); setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  // `push` is false when the browser itself navigated (popstate) — the history
  // entry already exists and pushing another would break Forward.
  const exitToMenu = (push = true) => {
    intentionalCloseRef.current = true;
    reconnectingRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    bufferedActionsRef.current = [];
    backoffRef.current = 500;
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    clearUrlGameId(push);
    clearTransitionTimers();
    serverStateRef.current = null;
    commitLocalState(null);
    setGameId(null); setRoster([]); setMyPlayerId(null); setSelectedIndices([]);
    setDefeatFlight(null);
    setReconnecting(false);
    // Without this the next room shows the previous room's conversation until
    // its first snapshot lands, and the seen-marker carries over with it.
    setChat([]); setChatSeenAt(0);
  };

  useEffect(() => {
    const onPop = () => {
      const param = new URLSearchParams(window.location.search).get('game')?.toUpperCase() || null;
      if (param && param !== gameIdRef.current) void joinGame(param, false);
      else if (!param && gameIdRef.current) exitToMenu(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restartTable = () => { sendAction({ type: 'Reset' }); setShowGameOver(false); };

  const startNewGame = (numPlayers: number) => {
    sendAction({ type: 'NewGame', payload: { num_players: numPlayers } });
    setShowGameOver(false);
  };

  return {
    gameId, myPlayerId, roster, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
    defeatFlight, finishDefeatFlight, reconnecting, seatedPlayer, canYield, muted, toggleMute, isHost,
    chat, sendChat,
    unreadChat: unreadCount(chat, chatSeenAt),
    markChatRead: () => setChatSeenAt(newestSeen(chat, chatSeenAt)),
    sortedHand, currentTierEnemies, currentDiscardValue, damageNeeded, isMyTurn, isSolo, isSpectator, discardRemaining, isImmuneWarning,
    createGame, joinGame, sendAction, toggleCard, chooseNextPlayer, copyId, exitToMenu, restartTable, startNewGame, renamePlayer
  };
};
