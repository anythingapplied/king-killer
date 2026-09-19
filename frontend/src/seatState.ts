/**
 * Whether a connection is watching rather than playing.
 *
 * `myPlayerId` is null in two very different situations, and conflating them
 * is what once left an observer on the loading spinner forever:
 *   - no snapshot has arrived yet (genuinely still loading), or
 *   - a snapshot arrived and the server said this connection holds no seat.
 *
 * The presence of a snapshot is what tells them apart, since the server sends
 * `you` on every one.
 */
export function isWatching(hasSnapshot: boolean, myPlayerId: number | null, playerCount: number): boolean {
    if (!hasSnapshot) return false;
    return myPlayerId === null || myPlayerId >= playerCount;
}

/** Whether the board can render yet, as opposed to showing the loading state. */
export function canRenderBoard(
    hasSnapshot: boolean,
    myPlayerId: number | null,
    hasSeatedPlayer: boolean,
    playerCount: number,
): boolean {
    if (!hasSnapshot) return false;
    if (isWatching(hasSnapshot, myPlayerId, playerCount)) return true;
    return myPlayerId !== null && hasSeatedPlayer;
}
