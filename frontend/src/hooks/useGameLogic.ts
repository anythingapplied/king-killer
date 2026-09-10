import { useState, useEffect, useRef, useMemo } from 'react';
import type { GameState, GameAction, Card as CardType, Rank as RankType, Suit as SuitType, CombatEffect } from '../types';

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE = import.meta.env.VITE_API_BASE ?? (IS_LOCAL ? `http://${window.location.hostname}:3000` : '');
const WS_BASE = import.meta.env.VITE_WS_BASE ?? (IS_LOCAL ? `ws://${window.location.hostname}:3000` : '');

const suitOrder: SuitType[] = ['Clubs', 'Hearts', 'Spades', 'Diamonds'];

const getRankValue = (rank: RankType): number => {
    if (typeof rank === 'object') return rank.Number;
    if (rank === 'Ace') return 1;
    if (rank === 'Jack') return 11;
    if (rank === 'Queen') return 12;
    if (rank === 'King') return 13;
    if (rank === 'Joker') return 0;
    return 0;
};

const getAttackValue = (card: CardType): number => {
    const rank = card.rank;
    if (typeof rank === 'object') return rank.Number;
    if (rank === 'Ace') return 1;
    if (rank === 'Jack') return 10;
    if (rank === 'Queen') return 15;
    if (rank === 'King') return 20;
    return 0;
};

export const useGameLogic = () => {
  const [gameId, setGameId] = useState<string | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [localGameState, setLocalGameState] = useState<GameState | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showGameOver, setShowGameOver] = useState(true);
  const [activeEffects, setActiveEffects] = useState<CombatEffect[]>([]);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!gameState) return;
    if (localGameState) {
        const effects: CombatEffect[] = [];
        const ts = Date.now();
        if (gameState.active_enemy && localGameState.active_enemy) {
            const damage = localGameState.active_enemy.current_health - gameState.active_enemy.current_health;
            if (damage > 0) effects.push({ id: ts + 1, suit: 'Clubs', value: `-${damage}`, type: 'damage' });
        }
        if (gameState.shield_value > localGameState.shield_value) {
            effects.push({ id: ts + 2, suit: 'Spades', value: `+${gameState.shield_value - localGameState.shield_value}`, type: 'shield' });
        }
        if (gameState.tavern_deck.length > localGameState.tavern_deck.length && gameState.discard_pile.length < localGameState.discard_pile.length) {
            effects.push({ id: ts + 3, suit: 'Hearts', value: `+${gameState.tavern_deck.length - localGameState.tavern_deck.length}`, type: 'heal' });
        }
        const isJester = gameState.last_played?.some(c => c.rank === 'Joker');
        const totalHand = (gs: GameState) => gs.players.reduce((sum, p) => sum + p.hand.length, 0);
        if (!isJester && totalHand(gameState) > totalHand(localGameState)) {
            effects.push({ id: ts + 4, suit: 'Diamonds', value: `+${totalHand(gameState) - totalHand(localGameState)}`, type: 'draw' });
        }
        if (effects.length > 0) {
            setActiveEffects(prev => [...prev, ...effects]);
            setTimeout(() => setActiveEffects(prev => prev.filter(e => !effects.find(ne => ne.id === e.id))), 1200);
        }
    }
    const isDefeat = localGameState?.active_enemy && !gameState.active_enemy;
    const isNext = localGameState?.active_enemy && gameState.active_enemy && JSON.stringify(localGameState.active_enemy.card) !== JSON.stringify(gameState.active_enemy.card);
    if (isDefeat || isNext) {
        const timer = setTimeout(() => setLocalGameState(gameState), 1200);
        return () => clearTimeout(timer);
    } else {
        setLocalGameState(gameState);
        if (gameState.status !== 'InProgress') setShowGameOver(true);
    }
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
      ws.current = new WebSocket(`${WS_BASE}/api/ws/${gameId}`);
      ws.current.onmessage = (event) => setGameState(JSON.parse(event.data));
      return () => ws.current?.close();
    }
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
    const res = await fetch(`${API_BASE}/api/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_players: numPlayers }),
    });
    const data = await res.json();
    setGameId(data.id); setGameState(data.state); setMyPlayerId(0);
    localStorage.setItem(`seat_${data.id}`, "0");
  };

  const joinGame = async (id: string) => {
    const cleanId = id.trim().toLowerCase();
    const res = await fetch(`${API_BASE}/api/game/${cleanId}`);
    if (res.ok) setGameId(cleanId); else alert("Game not found");
  };

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

  const isSelectionValid = (newCard: CardType, currentSelection: CardType[], phase: string | object): boolean => {
    const isJoker = (c: CardType) => c.rank === 'Joker';
    const isAce = (c: CardType) => c.rank === 'Ace';
    if (typeof phase === 'object' && 'AwaitingDiscard' in phase) {
        return currentSelection.reduce((sum, c) => sum + getAttackValue(c), 0) < (phase as any).AwaitingDiscard.damage_to_take;
    }
    if (currentSelection.length === 0) return true;
    if (isJoker(newCard) || currentSelection.some(isJoker)) return false;
    if (currentSelection.some(isAce) || isAce(newCard)) return currentSelection.length === 1;
    const allSameRank = currentSelection.every(c => JSON.stringify(c.rank) === JSON.stringify(newCard.rank));
    if (allSameRank) {
        const newTotal = currentSelection.reduce((sum, c) => sum + getAttackValue(c), 0) + getAttackValue(newCard);
        return newTotal <= 10 && currentSelection.length < 4;
    }
    return false;
  };

  const copyId = () => {
    if (gameId) {
      navigator.clipboard.writeText(gameId);
      setCopySuccess(true); setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const exitToMenu = () => {
    setGameId(null); setGameState(null); setLocalGameState(null); setMyPlayerId(null); setSelectedIndices([]);
  };

  const restartTable = () => { sendAction({ type: 'Reset' }); setShowGameOver(false); };

  return {
    gameId, myPlayerId, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
    sortedHand, currentTierEnemies, currentDiscardValue, damageNeeded, isMyTurn, isSolo, discardRemaining, isImmuneWarning,
    createGame, joinGame, sendAction, toggleCard, copyId, exitToMenu, restartTable
  };
};
