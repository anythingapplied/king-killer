import { describe, it, expect } from 'vitest';
import { shouldRingTurnChime } from '../src/turnChime';

describe('shouldRingTurnChime', () => {
    it('rings when the turn arrives', () => {
        expect(shouldRingTurnChime(false, true, false)).toBe(true);
    });

    it('stays silent when the turn is handed away', () => {
        expect(shouldRingTurnChime(true, false, false)).toBe(false);
    });

    it('stays silent while nothing changes', () => {
        expect(shouldRingTurnChime(true, true, false)).toBe(false);
        expect(shouldRingTurnChime(false, false, false)).toBe(false);
    });

    it('stays silent on the first state, even if it is already our turn', () => {
        // Joining, resuming, or reconnecting into our own turn.
        expect(shouldRingTurnChime(null, true, false)).toBe(false);
    });

    it('never rings in solo play', () => {
        // The turn comes back after every action, so this would be constant.
        expect(shouldRingTurnChime(false, true, true)).toBe(false);
    });
});
