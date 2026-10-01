import type { GameState } from './types';

/**
 * Whether `next` is the state an undo just restored.
 *
 * The server logs an `Undone` entry on the restored state, so that is the
 * marker. It has to be *new*, though: after an undo the next action may add
 * no log entry of its own (a Jester choice), and that state must not be
 * mistaken for a second undo. An undo always changes the log's length -
 * the restored log is the older one plus the new entry - except in the rare
 * case where the 200-entry cap hides it, which only costs a stray effect.
 */
export function arrivedByUndo(prev: GameState, next: GameState): boolean {
    const log = next.game_log ?? [];
    if (log.at(-1)?.kind !== 'Undone') return false;
    const prevLog = prev.game_log ?? [];
    return prevLog.length !== log.length || prevLog.at(-1)?.kind !== 'Undone';
}

/** The seat whose undo produced this state, if it was an undo. */
export function undoneBy(state: GameState): number | null {
    const last = state.game_log?.at(-1);
    return last?.kind === 'Undone' ? last.player : null;
}
