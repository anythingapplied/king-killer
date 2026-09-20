import type { RoomMember } from './types';

/**
 * Spectator seats continue the player numbering — the first watcher in a
 * 2-player game sits at seat 2 — so showing a raw seat reads as "Spectator 3".
 * Number watchers by their position among the watchers instead.
 *
 * Extracted so the rule is testable without rendering the HUD, and so the
 * roster row and a player's own badge can't drift apart again (they previously
 * used two different formulas, only one of which was right).
 */
export function spectatorNumber(
    seat: number,
    roster: Pick<RoomMember, 'seat'>[],
    playerCount: number,
): number {
    const watching = roster
        .filter(m => m.seat >= playerCount)
        .sort((a, b) => a.seat - b.seat);
    const idx = watching.findIndex(m => m.seat === seat);
    // Not in the roster yet (mid-join): fall back to the offset from the last
    // player seat rather than showing "Spectator 0".
    return idx >= 0 ? idx + 1 : Math.max(1, seat - playerCount + 1);
}
