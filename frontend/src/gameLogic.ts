import type { Card as CardType, Rank as RankType, Suit as SuitType, TurnPhase } from './types';

export const suitOrder: SuitType[] = ['Clubs', 'Hearts', 'Spades', 'Diamonds'];

/** Ordering value used to sort cards by suit then rank. */
export const getRankValue = (rank: RankType): number => {
    if (typeof rank === 'object') return rank.Number;
    if (rank === 'Ace') return 1;
    if (rank === 'Jack') return 11;
    if (rank === 'Queen') return 12;
    if (rank === 'King') return 13;
    if (rank === 'Joker') return 0;
    return 0;
};

/** Damage dealt (and value when discarding to suffer damage). */
export const getAttackValue = (card: CardType): number => {
    const rank = card.rank;
    if (typeof rank === 'object') return rank.Number;
    if (rank === 'Ace') return 1;
    if (rank === 'Jack') return 10;
    if (rank === 'Queen') return 15;
    if (rank === 'King') return 20;
    return 0;
};

/** Approximates the damage a set of played cards deals (clubs double unless immune). */
export const calculateBlowDamage = (cards: CardType[], enemy: { card: CardType; is_jester_active: boolean }): number => {
    const dmg = cards.reduce((sum, c) => sum + getAttackValue(c), 0);
    const clubsDoubled = cards.some(c => c.suit === 'Clubs');
    const clubsBlocked = enemy.card.suit === 'Clubs' && !enemy.is_jester_active;
    return clubsDoubled && !clubsBlocked ? dmg * 2 : dmg;
};

/** Whether adding `newCard` to the current selection is a legal play/discard. */
export const isSelectionValid = (newCard: CardType, currentSelection: CardType[], phase: TurnPhase): boolean => {
    const isJoker = (c: CardType) => c.rank === 'Joker';
    const isAce = (c: CardType) => c.rank === 'Ace';
    if (typeof phase === 'object' && 'AwaitingDiscard' in phase) {
        return currentSelection.reduce((sum, c) => sum + getAttackValue(c), 0) < (phase as { AwaitingDiscard: { damage_to_take: number } }).AwaitingDiscard.damage_to_take;
    }
    if (currentSelection.length === 0) return true;
    if (isJoker(newCard) || currentSelection.some(isJoker)) return false;
    if (currentSelection.some(isAce) || isAce(newCard)) return currentSelection.length === 1;
    // Rank is a nested object (e.g. { Number: 5 }) so compare by value.
    const allSameRank = currentSelection.every(c => getRankValue(c.rank) === getRankValue(newCard.rank));
    if (allSameRank) {
        const newTotal = currentSelection.reduce((sum, c) => sum + getAttackValue(c), 0) + getAttackValue(newCard);
        return newTotal <= 10 && currentSelection.length < 4;
    }
    return false;
};