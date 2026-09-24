import { describe, it, expect } from 'vitest';
import { shouldNotifyTurn } from '../src/turnNotify';

describe('shouldNotifyTurn', () => {
    it('notifies when the turn arrives while the page is hidden', () => {
        expect(shouldNotifyTurn(true, true, true, 'granted')).toBe(true);
    });

    it('stays quiet when the page is visible', () => {
        // The board and the chime already have it covered.
        expect(shouldNotifyTurn(true, false, true, 'granted')).toBe(false);
    });

    it('only fires on the turn arriving, as the chime does', () => {
        // Covers every case the chime rule rejects: solo, the first state,
        // the turn leaving, or nothing changing.
        expect(shouldNotifyTurn(false, true, true, 'granted')).toBe(false);
    });

    it('respects the player switching it off', () => {
        expect(shouldNotifyTurn(true, true, false, 'granted')).toBe(false);
    });

    it('needs the browser permission, not just the setting', () => {
        expect(shouldNotifyTurn(true, true, true, 'default')).toBe(false);
        expect(shouldNotifyTurn(true, true, true, 'denied')).toBe(false);
        expect(shouldNotifyTurn(true, true, true, 'unsupported')).toBe(false);
    });
});
