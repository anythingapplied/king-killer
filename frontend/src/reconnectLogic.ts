import type { GameAction } from './types';

/**
 * Decides which buffered actions to replay after a seamless reconnect.
 *
 * The only safe moment to replay a buffered action is when the server reports
 * the exact state we last saw: the server was asleep (idle shutdown), so
 * nothing could have changed and the card indices captured in the buffered
 * actions are still valid.
 *
 * If the state advanced while our socket was down (another client played), the
 * buffer is stale and must be discarded — the fresh state then resyncs the UI.
 */
export function decideBufferedActionsToReplay(
    buffered: GameAction[],
    receivedStateJson: string,
    lastKnownStateJson: string | null,
): GameAction[] {
    if (buffered.length === 0) return [];
    if (lastKnownStateJson === null) return [];
    return receivedStateJson === lastKnownStateJson ? buffered : [];
}