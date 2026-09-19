import { describe, it, expect } from 'vitest';
import { isWatching, canRenderBoard } from '../src/seatState';

describe('seat state', () => {
    it('is not watching before any snapshot has arrived', () => {
        expect(isWatching(false, null, 2)).toBe(false);
        expect(canRenderBoard(false, null, false, 2)).toBe(false);
    });

    it('treats a seatless connection as an observer once a snapshot lands', () => {
        // The server sends `you: null` when a token doesn't resolve. Reading
        // that as "still loading" left such a connection on the spinner.
        expect(isWatching(true, null, 2)).toBe(true);
        expect(canRenderBoard(true, null, false, 2)).toBe(true);
    });

    it('treats a seat beyond the table as an observer', () => {
        expect(isWatching(true, 3, 2)).toBe(true);
        expect(canRenderBoard(true, 3, false, 2)).toBe(true);
    });

    it('renders the board for a seated player', () => {
        expect(isWatching(true, 1, 2)).toBe(false);
        expect(canRenderBoard(true, 1, true, 2)).toBe(true);
    });

    it('waits if seated but the player record has not arrived', () => {
        expect(canRenderBoard(true, 1, false, 2)).toBe(false);
    });
});
