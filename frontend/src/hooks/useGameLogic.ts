import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { GameState, GameAction, Card as CardType, CombatEffect, RoomSnapshot, RoomMember } from '../types';
import { getAttackValue, getRankValue, isSelectionValid, calculateBlowDamage, suitOrder } from '../gameLogic';
import { decideBufferedActionsToReplay } from '../reconnectLogic';
import { playBellChime } from '../sound';

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
  const [gameState, setGameState] = useState<GameState | null>(null);
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
  // Games whose join request is currently in flight. Joining claims a seat on
  // the server, so a duplicate (React StrictMode double-invokes the URL-join
  // effect, and a user can press Enter twice) must never fire two join calls.
  const joiningRef = useRef<Set<string>>(new Set());
  // Detects the transition into "my turn" so the chime only rings when the
  // turn actually arrives, not on the initial load (e.g. you created the game).
  const wasMyTurnRef = useRef<boolean | null>(null);

  const isMyTurn = localGameState?.current_player_index === myPlayerId;
  const isSolo = localGameState?.players.length === 1;
  const isChoosingNextPlayer = localGameState?.phase === 'AwaitingNextPlayer';
  // A member seated beyond the active game's player count watches the game.
  const isSpectator = localGameState !== null && myPlayerId !== null && myPlayerId >= localGameState.players.length;

  // Ring the bell only when a turn actually arrives mid-game. Solo play is
  // excluded: the turn returns to you after every action, so each return would
  // just be noise. prev === null (first state evaluation) is also skipped so
  // joining/resuming into a game where it's already our turn stays silent.
  useEffect(() => {
    if (isSolo || !localGameState || myPlayerId === null) return;
    const prev = wasMyTurnRef.current;
    wasMyTurnRef.current = isMyTurn;
    if (prev === null || prev === isMyTurn) return;
    if (isMyTurn) playBellChime();
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
  const finishDefeatFlight = (flightId?: number) => {
    setDefeatFlight(f => (flightId !== undefined && f?.id !== flightId ? f : null));
    if (gameState) setLocalGameState(gameState);
    if (gameState?.status !== 'InProgress') setShowGameOver(true);
  };

  useEffect(() => {
    if (!gameState) return;
    const prev = localGameState;
    if (prev) {
        if (gameState.seed !== prev.seed) {
            // A brand-new deal replaced this game (New Game / Play Again):
            // snap to the fresh board instead of animating a defeat flight.
            setLocalGameState(gameState);
            setDefeatFlight(null);
            setSelectedIndices([]);
            if (gameState.status !== 'InProgress') setShowGameOver(true);
            return;
        }
        const effects: CombatEffect[] = [];
        const ts = Date.now();
        const enemyChanged = prev.active_enemy && gameState.active_enemy && prev.active_enemy.card.id !== gameState.active_enemy.card.id;
        if (enemyChanged && prev.active_enemy) {
            // An enemy was just defeated (a new one appeared). Show the killing blow
            // over the old enemy's health before it flies away.
            const blow = calculateBlowDamage(gameState.last_played ?? [], prev.active_enemy);
            if (blow > 0) effects.push({ id: ts + 1, suit: 'Clubs', value: `-${blow}`, type: 'damage' });
        } else if (gameState.active_enemy && prev.active_enemy) {
            const damage = prev.active_enemy.current_health - gameState.active_enemy.current_health;
            if (damage > 0) effects.push({ id: ts + 1, suit: 'Clubs', value: `-${damage}`, type: 'damage' });
        }
        if (gameState.shield_value > prev.shield_value) {
            effects.push({ id: ts + 2, suit: 'Spades', value: `+${gameState.shield_value - prev.shield_value}`, type: 'shield' });
        }
        if (gameState.tavern_deck.length > prev.tavern_deck.length && gameState.discard_pile.length < prev.discard_pile.length) {
            effects.push({ id: ts + 3, suit: 'Hearts', value: `+${gameState.tavern_deck.length - prev.tavern_deck.length}`, type: 'heal' });
        }
        const isJester = gameState.last_played?.some(c => c.rank === 'Joker');
        const totalHand = (gs: GameState) => gs.players.reduce((sum, p) => sum + p.hand.length, 0);
        if (!isJester && totalHand(gameState) > totalHand(prev)) {
            effects.push({ id: ts + 4, suit: 'Diamonds', value: `+${totalHand(gameState) - totalHand(prev)}`, type: 'draw' });
        }
        if (effects.length > 0) {
            setActiveEffects(prevEffects => [...prevEffects, ...effects]);
            setTimeout(() => setActiveEffects(prevEffects => prevEffects.filter(e => !effects.find(ne => ne.id === e.id))), 1200);
        }
    }
    
    const isDefeat = prev?.active_enemy && !gameState.active_enemy;
    const isEnemySwap = prev?.active_enemy && gameState.active_enemy && prev.active_enemy.card.id !== gameState.active_enemy.card.id;

    if (isDefeat) {
        // Win over the final king: no next enemy, so there is nothing to fly to.
        const timer = setTimeout(() => {
            setLocalGameState(gameState);
            if (gameState.status !== 'InProgress') setShowGameOver(true);
        }, DEFEAT_BLOW_MS);
        return () => clearTimeout(timer);
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
            dest: gameState.last_enemy_fate === 'Tavern' ? 'tavern' : 'discard',
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
        return () => {
            clearTimeout(swapTimer);
            clearTimeout(safetyTimer);
        };
    }

    setLocalGameState(gameState);
    if (gameState.status !== 'InProgress') setShowGameOver(true);
    // finishDefeatFlight is a fresh closure per render; adding it (or
    // localGameState) to deps would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState]);

  // Restores a previously-saved seat (e.g. resuming after a server restart).
  // Seat claiming itself lives in `joinGame`/`createGame` so a player only ever
  // consumes one seat.
  useEffect(() => {
    if (!gameId || myPlayerId !== null) return;
    const savedSeat = localStorage.getItem(`seat_${gameId}`);
    if (savedSeat !== null) setMyPlayerId(parseInt(savedSeat));
  }, [gameId, myPlayerId]);

  const connectWebSocket = useCallback(() => {
    const id = gameId;
    if (!id || intentionalCloseRef.current) return;
    const socket = new WebSocket(`${WS_BASE}/api/ws/${id}`);
    ws.current = socket;
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
      setGameState(payload.game);
      setRoster(payload.members);
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg && msg.type === 'State') {
        onState(msg.payload);
        return;
      }
      setGameState(msg);
    };
    socket.onclose = () => {
      if (intentionalCloseRef.current) return;
      // The server stopped itself (idle) or restarted. Resume invisibly:
      // retry with backoff; on success the server sends State and we continue.
      reconnectingRef.current = true;
      setReconnecting(true);
      backoffRef.current = Math.min(backoffRef.current * 1.5, 8000);
      scheduleReconnect();
    };
  }, [gameId]);

  const scheduleReconnect = () => {
    if (intentionalCloseRef.current) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWebSocket();
    }, backoffRef.current);
  };

  useEffect(() => {
    if (gameId) {
      gameConnectedRef.current = false;
      intentionalCloseRef.current = false;
      bufferedActionsRef.current = [];
      backoffRef.current = 500;
      lastGameStateJsonRef.current = null;
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
        return (localGameState.phase as any).AwaitingDiscard.damage_to_take;
    }
    return 0;
  }, [localGameState]);

  const discardRemaining = Math.max(0, damageNeeded - currentDiscardValue);

  const isImmuneWarning = useMemo(() => {
    if (!localGameState?.active_enemy || selectedIndices.length === 0) return false;
    const enemySuit = localGameState.active_enemy.card.suit;
    if (!enemySuit || localGameState.active_enemy.is_jester_active) return false;
    return selectedIndices.some(idx => localGameState.players[myPlayerId!].hand[idx]?.suit === enemySuit);
  }, [selectedIndices, localGameState, myPlayerId]);

  const createGame = async (numPlayers: number) => {
    const playerName = localStorage.getItem('kingkiller_player_name') || '';
    const res = await fetch(`${API_BASE}/api/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_players: numPlayers, player_name: playerName || undefined }),
    });
    const data = await res.json();
    setGameId(data.id); setGameState(data.state.game); setRoster(data.state.members); setMyPlayerId(0);
    localStorage.setItem(`seat_${data.id}`, "0");
    setUrlGameId(data.id);
  };

  const setUrlGameId = (id: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('game', id);
    window.history.replaceState(null, '', url);
  };

  const clearUrlGameId = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('game');
    window.history.replaceState(null, '', url);
  };

  const joinGame = async (input: string) => {
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
      const savedSeat = localStorage.getItem(`seat_${id}`);
      if (savedSeat !== null) {
        setGameId(id);
        setGameState(snap.game);
        setRoster(snap.members);
        setMyPlayerId(parseInt(savedSeat));
        setUrlGameId(id);
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
        setGameId(id);
        setGameState(snap.game);
        setRoster(snap.members);
        setMyPlayerId(data.seat_index);
        localStorage.setItem(`seat_${id}`, data.seat_index.toString());
        setUrlGameId(id);
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

  const sendAction = (action: GameAction) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(action));
    } else {
      // Socket is down (server asleep/restarting). Queue until the reconnect
      // arrives; the onState handler replays the buffer if nothing moved.
      bufferedActionsRef.current.push(action);
    }
    setSelectedIndices([]);
  };

  // Persist the player's name locally AND broadcast it to the table, so
  // everyone (including a player who only joined a game) can pick a name.
  const renamePlayer = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem('kingkiller_player_name', trimmed);
    if (myPlayerId !== null) sendAction({ type: 'SetName', payload: { seat: myPlayerId, name: trimmed } });
  };

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

  const exitToMenu = () => {
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
    clearUrlGameId();
    setGameId(null); setGameState(null); setRoster([]); setLocalGameState(null); setMyPlayerId(null); setSelectedIndices([]);
    setDefeatFlight(null);
    setReconnecting(false);
  };

  const restartTable = () => { sendAction({ type: 'Reset' }); setShowGameOver(false); };

  const startNewGame = (numPlayers: number) => {
    sendAction({ type: 'NewGame', payload: { num_players: numPlayers } });
    setShowGameOver(false);
  };

  return {
    gameId, myPlayerId, roster, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
    defeatFlight, finishDefeatFlight, reconnecting,
    sortedHand, currentTierEnemies, currentDiscardValue, damageNeeded, isMyTurn, isSolo, isSpectator, discardRemaining, isImmuneWarning,
    isChoosingNextPlayer,
    createGame, joinGame, sendAction, toggleCard, chooseNextPlayer, copyId, exitToMenu, restartTable, startNewGame, renamePlayer
  };
};
