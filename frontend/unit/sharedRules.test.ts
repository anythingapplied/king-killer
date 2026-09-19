import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Card, Suit } from '../src/types';
import { getAttackValue, isSelectionValid, calculateBlowDamage } from '../src/gameLogic';

/**
 * The other half of `king-killer-core/tests/shared_rules.rs`.
 *
 * This file re-implements the server's rules so the UI can grey out illegal
 * selections. The server is authoritative and rejects invalid actions
 * *silently*, so a divergence between the two shows up as a button that does
 * nothing rather than an error. Both suites read the same fixture, so a case
 * added in one place has to hold in both.
 */
const fixtures = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../shared/rule-fixtures.json', import.meta.url)), 'utf8'),
) as {
    attackValues: { why: string; card: Omit<Card, 'id'>; expected: number }[];
    combos: { why: string; cards: Omit<Card, 'id'>[]; valid: boolean }[];
    damage: {
        why: string;
        cards: Omit<Card, 'id'>[];
        enemySuit: Suit;
        jesterActive: boolean;
        expected: number;
    }[];
};

/** Ids carry no rule meaning, so the fixture omits them. */
const build = (cards: Omit<Card, 'id'>[]): Card[] =>
    cards.map((c, i) => ({ ...c, id: 9000 + i }) as Card);

/**
 * Whether the UI would let you assemble this whole selection.
 *
 * `isSelectionValid` answers "may I add this one card to what's already
 * picked?", while the server's `is_valid_combo` judges a finished set. The
 * equivalent question is whether every card can be added in turn — which is
 * exactly what a player does by clicking them one at a time.
 */
const selectionAccepted = (cards: Card[]): boolean => {
    const picked: Card[] = [];
    for (const card of cards) {
        if (!isSelectionValid(card, picked, 'AwaitingPlay')) return false;
        picked.push(card);
    }
    return true;
};

describe('shared rule fixtures', () => {
    it('has cases to check', () => {
        expect(fixtures.attackValues.length).toBeGreaterThan(0);
        expect(fixtures.combos.length).toBeGreaterThan(0);
        expect(fixtures.damage.length).toBeGreaterThan(0);
    });

    it.each(fixtures.attackValues)('attack value: $why', ({ card, expected }) => {
        expect(getAttackValue(build([card])[0])).toBe(expected);
    });

    it.each(fixtures.combos)('combo: $why', ({ cards, valid }) => {
        expect(selectionAccepted(build(cards))).toBe(valid);
    });

    it.each(fixtures.damage)('damage: $why', ({ cards, enemySuit, jesterActive, expected }) => {
        const enemy = {
            card: { id: 1, suit: enemySuit, rank: 'Jack' } as Card,
            is_jester_active: jesterActive,
        };
        expect(calculateBlowDamage(build(cards), enemy)).toBe(expected);
    });
});
