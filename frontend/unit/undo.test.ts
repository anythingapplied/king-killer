import { describe, expect, it } from 'vitest';
import { arrivedByUndo, undoneBy } from '../src/undo';
import type { GameState, LogEntry, LogKind } from '../src/types';

const entry = (kind: LogKind, player: number | null = 0): LogEntry => ({ kind, player, cards: [] });
const state = (...log: LogEntry[]) => ({ game_log: log }) as unknown as GameState;

describe('arrivedByUndo', () => {
    it('spots the state an undo restored', () => {
        const before = state(entry('EnemyRevealed', null), entry('Played'));
        const restored = state(entry('EnemyRevealed', null), entry('Undone'));
        expect(arrivedByUndo(before, restored)).toBe(true);
    });

    it('is false for an ordinary move', () => {
        expect(arrivedByUndo(state(entry('Played')), state(entry('Played'), entry('Discarded')))).toBe(false);
    });

    it('does not count the same undo twice when the next action logs nothing', () => {
        // After an undo, a Jester choice adds no log entry: the log still ends
        // in the same Undone, and that must not replay the undo notice.
        const afterUndo = state(entry('EnemyRevealed', null), entry('Undone'));
        expect(arrivedByUndo(afterUndo, state(entry('EnemyRevealed', null), entry('Undone')))).toBe(false);
    });

    it('spots a second undo in a row', () => {
        const first = state(entry('EnemyRevealed', null), entry('Yielded'), entry('Undone'));
        const second = state(entry('EnemyRevealed', null), entry('Undone'));
        expect(arrivedByUndo(first, second)).toBe(true);
    });
});

describe('undoneBy', () => {
    it('names the player whose undo made this state', () => {
        expect(undoneBy(state(entry('Played', 1), entry('Undone', 2)))).toBe(2);
        expect(undoneBy(state(entry('Undone', 2), entry('Played', 1)))).toBeNull();
        expect(undoneBy(state())).toBeNull();
    });
});
