import { describe, it, expect } from 'vitest';
import { spectatorNumber } from '../src/spectatorLabel';

const roster = (...seats: number[]) => seats.map(seat => ({ seat }));

describe('spectatorNumber', () => {
    it('numbers the first watcher of a 2-player game as 1, not 3', () => {
        // The reported bug: seat 2 rendered as "Spectator 3".
        expect(spectatorNumber(2, roster(0, 1, 2), 2)).toBe(1);
    });

    it('numbers multiple watchers in seat order', () => {
        const r = roster(0, 1, 2, 3, 4);
        expect(spectatorNumber(2, r, 2)).toBe(1);
        expect(spectatorNumber(3, r, 2)).toBe(2);
        expect(spectatorNumber(4, r, 2)).toBe(3);
    });

    it('renumbers after a re-deal grows the player count', () => {
        // 2p -> 4p: seats 2 and 3 become players, so seat 4 is now the first
        // watcher rather than the third.
        expect(spectatorNumber(4, roster(0, 1, 2, 3, 4), 4)).toBe(1);
    });

    it('stays correct if seats are ever non-contiguous', () => {
        const r = roster(0, 1, 2, 5, 9);
        expect(spectatorNumber(5, r, 2)).toBe(2);
        expect(spectatorNumber(9, r, 2)).toBe(3);
    });

    it('never returns 0 for a seat missing from the roster', () => {
        expect(spectatorNumber(2, roster(0, 1), 2)).toBe(1);
    });
});
