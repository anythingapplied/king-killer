/**
 * Decides whether a newly-arrived state should ring the "you're up" chime.
 *
 * Pulled out of the hook so the rule is testable without a browser or an
 * AudioContext, the same way `reconnectLogic` is.
 *
 * @param previousWasMyTurn whether it was our turn in the last state we saw,
 *   or `null` if this is the first state of the session.
 * @param isMyTurn whether it is our turn in the state that just arrived.
 * @param isSolo whether this is a single-player table.
 */
export function shouldRingTurnChime(
    previousWasMyTurn: boolean | null,
    isMyTurn: boolean,
    isSolo: boolean,
): boolean {
    // Solo play hands the turn straight back after every action, so a chime
    // each time would be constant noise rather than a signal.
    if (isSolo) return false;
    // First state of the session: joining or resuming into a game where it is
    // already our turn should stay silent.
    if (previousWasMyTurn === null) return false;
    // Only the transition matters, not every state update.
    if (previousWasMyTurn === isMyTurn) return false;
    return isMyTurn;
}
