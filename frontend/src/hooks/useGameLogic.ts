import { useState, useEffect, useRef, useMemo } from 'react';
import type { GameState, GameAction, Card as CardType, CombatEffect } from '../types';
import { getAttackValue, getRankValue, isSelectionValid, calculateBlowDamage, suitOrder } from '../gameLogic';

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE = import.meta.env.VITE_API_BASE ?? (IS_LOCAL ? `http://${window.location.hostname}:3000` : '');
const WS_BASE = import.meta.env.VITE_WS_BASE ?? (IS_LOCAL ? `ws://${window.location.hostname}:3000` : '');

// Timings for the defeat flow (in ms). The card must be shown long enough for
// the killing blow to land before it flies off to its pile.
const DEFEAT_BLOW_MS = 450;
const DEFEAT_FLIGHT_MS = 650;

export interface DefeatFlight {
    id: number; // also used as the framer-motion layoutId shared with the HUD target
    card: CardType;
    dest: 'tavern' | 'discard';
    flying: boolean; // true once the swap has committed and the card can fly
}

export const useGameLogic = () => {
  const [gameId, setGameId] = useState<string | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [localGameState, setLocalGameState] = useState<GameState | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showGameOver, setShowGameOver] = useState(true);
  const [activeEffects, setActiveEffects] = useState<CombatEffect[]>([]);
  const [defeatFlight, setDefeatFlight] = useState<DefeatFlight | null>(null);
  const [disconnectNotice, setDisconnectNotice] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const gameConnectedRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const shuttingDownRef = useRef(false);

  const persistNotice = (message: string) => {
    setDisconnectNotice(message);
    sessionStorage.setItem('kingkiller_disconnect_notice', message);
  };

  const dismissNotice = () => {
    setDisconnectNotice(null);
    sessionStorage.removeItem('kingkiller_disconnect_notice');
  };

  useEffect(() => {
    const saved = sessionStorage.getItem('kingkiller_disconnect_notice');
    if (saved) setDisconnectNotice(saved);
  }, []);

  useEffect(() => {
    if (!gameState) return;
    const prev = localGameState;
    if (prev) {
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
        // A defeat: hold the killing blow briefly, swap states, then let the
        // defeated card (now mounted in the HUD as a mini placeholder with the
        // same layoutId) fly to its pile.
        const flight: DefeatFlight = {
            id: Date.now(),
            card: prev!.active_enemy!.card,
            dest: gameState.last_enemy_fate === 'Tavern' ? 'tavern' : 'discard',
            flying: false,
        };
        setDefeatFlight(flight);
        const swapTimer = setTimeout(() => {
            setLocalGameState(gameState);
            setDefeatFlight(f => (f?.id === flight.id ? { ...f, flying: true } : f));
            if (gameState.status !== 'InProgress') setShowGameOver(true);
        }, DEFEAT_BLOW_MS);
        const clearTimer = setTimeout(() => {
            setDefeatFlight(f => (f?.id === flight.id ? null : f));
        }, DEFEAT_BLOW_MS + DEFEAT_FLIGHT_MS);
        return () => {
            clearTimeout(swapTimer);
            clearTimeout(clearTimer);
        };
    }

    setLocalGameState(gameState);
    if (gameState.status !== 'InProgress') setShowGameOver(true);
  }, [gameState]);

  useEffect(() => {
    if (gameId && myPlayerId === null) {
      const savedSeat = localStorage.getItem(`seat_${gameId}`);
      if (savedSeat !== null) setMyPlayerId(parseInt(savedSeat));
      else {
        fetch(`${API_BASE}/api/game/${gameId}/join`, { method: 'POST' }).then(res => res.json()).then(data => {
            setMyPlayerId(data.seat_index);
            localStorage.setItem(`seat_${gameId}`, data.seat_index.toString());
        });
      }
    }
  }, [gameId, myPlayerId]);

  useEffect(() => {
    if (gameId) {
      gameConnectedRef.current = false;
      intentionalCloseRef.current = false;
      shuttingDownRef.current = false;
      const socket = new WebSocket(`${WS_BASE}/api/ws/${gameId}`);
      ws.current = socket;
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === 'Shutdown') {
          shuttingDownRef.current = true;
          persistNotice(msg.payload?.reason ?? 'The server went to sleep. Start a new game to play again.');
          socket.close();
          exitToMenu();
          return;
        }
        if (msg && msg.type === 'State') {
          gameConnectedRef.current = true;
          setGameState(msg.payload);
          return;
        }
        setGameState(msg);
      };
      socket.onclose = () => {
        if (!intentionalCloseRef.current && !shuttingDownRef.current) {
          persistNotice('Connection lost. The server is asleep or restarting. Start a new game to play again.');
          exitToMenu();
        }
      };
      return () => {
        intentionalCloseRef.current = true;
        socket.close();
        if (ws.current === socket) ws.current = null;
      };
    }
  }, [gameId]);

  useEffect(() => {
    if (!gameId) return;
    const interval = setInterval(() => {
      if (shuttingDownRef.current) return;
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

  const isMyTurn = localGameState?.current_player_index === myPlayerId;
  const isSolo = localGameState?.players.length === 1;
  const discardRemaining = Math.max(0, damageNeeded - currentDiscardValue);

  const isImmuneWarning = useMemo(() => {
    if (!localGameState?.active_enemy || selectedIndices.length === 0) return false;
    const enemySuit = localGameState.active_enemy.card.suit;
    if (!enemySuit || localGameState.active_enemy.is_jester_active) return false;
    return selectedIndices.some(idx => localGameState.players[myPlayerId!].hand[idx]?.suit === enemySuit);
  }, [selectedIndices, localGameState, myPlayerId]);

  const createGame = async (numPlayers: number) => {
    dismissNotice();
    const res = await fetch(`${API_BASE}/api/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_players: numPlayers }),
    });
    const data = await res.json();
    setGameId(data.id); setGameState(data.state); setMyPlayerId(0);
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
    const res = await fetch(`${API_BASE}/api/game/${id}`);
    if (res.ok) {
      dismissNotice();
      setGameId(id);
      setUrlGameId(id);
    } else {
      alert("Game not found");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gameParam = params.get('game')?.toUpperCase();
    if (gameParam) joinGame(gameParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendAction = (action: GameAction) => {
    ws.current?.send(JSON.stringify(action));
    setSelectedIndices([]);
  };

  const toggleCard = (originalIndex: number) => {
    if (!localGameState || myPlayerId === null) return;
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
    clearUrlGameId();
    setGameId(null); setGameState(null); setLocalGameState(null); setMyPlayerId(null); setSelectedIndices([]);
    setDefeatFlight(null);
  };

  const restartTable = () => { sendAction({ type: 'Reset' }); setShowGameOver(false); };

  return {
    gameId, myPlayerId, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
    defeatFlight, disconnectNotice, dismissNotice,
    sortedHand, currentTierEnemies, currentDiscardValue, damageNeeded, isMyTurn, isSolo, discardRemaining, isImmuneWarning,
    createGame, joinGame, sendAction, toggleCard, copyId, exitToMenu, restartTable
  };
};
