import { describe, it, expect } from 'vitest';
import { unreadCount, newestSeen } from '../src/chatUnread';

const msgs = (...at: number[]) => at.map(a => ({ at: a }));

describe('chat unread', () => {
    it('counts only messages newer than the seen marker', () => {
        expect(unreadCount(msgs(10, 20, 30), 20)).toBe(1);
        expect(unreadCount(msgs(10, 20, 30), 0)).toBe(3);
        expect(unreadCount(msgs(10, 20, 30), 30)).toBe(0);
    });

    it('keeps counting once history is capped and length stops growing', () => {
        // The server keeps the newest 100: length is pinned at 100 while the
        // timestamps keep advancing. A length-based badge freezes here.
        const capped = msgs(...Array.from({ length: 100 }, (_, i) => 1000 + i));
        const seen = newestSeen(capped, 0);
        const afterCap = msgs(...Array.from({ length: 100 }, (_, i) => 1050 + i));
        expect(afterCap.length).toBe(capped.length);
        expect(unreadCount(afterCap, seen)).toBe(50);
    });

    it('never goes negative when history is trimmed away', () => {
        expect(unreadCount(msgs(5), 999)).toBe(0);
    });

    it('newestSeen does not move backwards', () => {
        expect(newestSeen(msgs(1, 2), 99)).toBe(99);
        expect(newestSeen([], 42)).toBe(42);
    });
});
