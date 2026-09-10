import { describe, it, expect } from 'vitest';
import { getAttackValue, getRankValue, isSelectionValid, calculateBlowDamage } from '../src/gameLogic';
import type { Card as CardType, Suit, Rank as RankType, TurnPhase } from '../src/types';

const card = (suit: Suit | null, rank: RankType, id = 0): CardType => ({ suit, rank, id });
const n = (suit: Suit, num: number) => card(suit, { Number: num });
const playPhase: TurnPhase = 'AwaitingPlay';
const discardPhase = (need: number): TurnPhase => ({ AwaitingDiscard: { damage_to_take: need } });

describe('getAttackValue', () => {
    it('maps each rank to its attack value', () => {
        expect(getAttackValue(n('Clubs', 7))).toBe(7);
        expect(getAttackValue(card('Hearts', 'Ace'))).toBe(1);
        expect(getAttackValue(card('Hearts', 'Jack'))).toBe(10);
        expect(getAttackValue(card('Hearts', 'Queen'))).toBe(15);
        expect(getAttackValue(card('Hearts', 'King'))).toBe(20);
        expect(getAttackValue(card(null, 'Joker'))).toBe(0);
    });
});

describe('getRankValue', () => {
    it('returns a stable ordering key for each rank', () => {
        expect(getRankValue(n('Clubs', 2).rank)).toBe(2);
        expect(getRankValue(card('Hearts', 'Ace').rank)).toBe(1);
        expect(getRankValue(card('Hearts', 'Jack').rank)).toBe(11);
        expect(getRankValue(card('Hearts', 'Queen').rank)).toBe(12);
        expect(getRankValue(card('Hearts', 'King').rank)).toBe(13);
        expect(getRankValue(card(null, 'Joker').rank)).toBe(0);
    });
});

describe('calculateBlowDamage', () => {
    const enemy = (suit: Suit) => ({ card: card(suit, 'Jack'), is_jester_active: false });

    it('sums attack values without clubs', () => {
        expect(calculateBlowDamage([n('Hearts', 5), n('Spades', 3)], enemy('Hearts'))).toBe(8);
    });

    it('doubles when clubs are played against a non-clubs enemy', () => {
        expect(calculateBlowDamage([n('Clubs', 5), n('Hearts', 2)], enemy('Hearts'))).toBe(14);
    });

    it('does not double clubs against a clubs-immunity enemy', () => {
        expect(calculateBlowDamage([n('Clubs', 5)], enemy('Clubs'))).toBe(5);
    });

    it('doubles clubs against a clubs enemy once the Jester clears immunity', () => {
        const jesterAware = { card: card('Clubs', 'Jack'), is_jester_active: true };
        expect(calculateBlowDamage([n('Clubs', 5)], jesterAware)).toBe(10);
    });
});

describe('isSelectionValid', () => {
    it('allows any single card in play phase', () => {
        expect(isSelectionValid(n('Hearts', 10), [], playPhase)).toBe(true);
        expect(isSelectionValid(card(null, 'Joker'), [], playPhase)).toBe(true);
    });

    it('forbids combining a Joker with other cards', () => {
        expect(isSelectionValid(n('Hearts', 3), [card(null, 'Joker')], playPhase)).toBe(false);
        expect(isSelectionValid(card(null, 'Joker'), [n('Hearts', 3)], playPhase)).toBe(false);
    });

    it('allows an Ace paired with exactly one card', () => {
        const ace = card('Hearts', 'Ace');
        expect(isSelectionValid(n('Clubs', 8), [ace], playPhase)).toBe(true);
        expect(isSelectionValid(n('Clubs', 8), [ace, n('Diamonds', 2)], playPhase)).toBe(false);
    });

    it('enforces set value limits (total <= 10, up to 4 cards)', () => {
        expect(isSelectionValid(n('Clubs', 5), [n('Hearts', 5)], playPhase)).toBe(true);
        expect(isSelectionValid(n('Clubs', 3), [n('Hearts', 3), n('Spades', 3)], playPhase)).toBe(true);
        expect(isSelectionValid(n('Clubs', 4), [n('Hearts', 4), n('Spades', 4)], playPhase)).toBe(false);
        expect(isSelectionValid(n('Clubs', 2), [n('Hearts', 2), n('Spades', 2), n('Diamonds', 2)], playPhase)).toBe(true);
        expect(isSelectionValid(n('Clubs', 5), [n('Hearts', 5), n('Spades', 5), n('Diamonds', 5)], playPhase)).toBe(false);
    });

    it('forbids mixed ranks', () => {
        expect(isSelectionValid(n('Clubs', 6), [n('Hearts', 5)], playPhase)).toBe(false);
    });

    it('lets you add cards while the discard value is still below the damage', () => {
        const need = discardPhase(10);
        expect(isSelectionValid(n('Clubs', 4), [], need)).toBe(true);
        expect(isSelectionValid(n('Clubs', 4), [n('Hearts', 4)], need)).toBe(true); // 4 < 10, still allowed
        expect(isSelectionValid(n('Clubs', 8), [n('Hearts', 4)], need)).toBe(true); // 4 < 10, still allowed
        expect(isSelectionValid(n('Clubs', 6), [n('Hearts', 5), n('Spades', 5)], need)).toBe(false); // 10 >= 10, blocked
    });
});