/**
 * leaderboard.ts - reads the standings from `GET /api/leaderboard` and the
 * small helpers the leaderboard screen shows them with.
 *
 * The server ranks by the lower bound of the 95% Wilson score interval for
 * each win rate (king-killer-api/src/profiles.rs), so the client only shows
 * the order it is given.
 *
 * Changes:
 * - 2026-11-27: Created, for the leaderboard.
 */
import { apiFetch } from './api';

/** One row: a player (one name) or a team (several). */
export interface Standing {
    names: string[];
    games: number;
    wins: number;
    /** Lower bound of the win rate, 0 to 1. */
    score: number;
}

/** The board for one table size. Solo has no teams. */
export interface Board {
    player_count: number;
    players: Standing[];
    teams: Standing[];
}

/** Loads every board; rejects on a failed call or an unexpected answer. */
export const fetchLeaderboard = async (signal?: AbortSignal): Promise<Board[]> => {
    const res = await apiFetch('/api/leaderboard', { signal });
    if (!res.ok) throw new Error(`The leaderboard answered ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isBoard)) throw new Error('The leaderboard answered in an unexpected shape');
    return body;
};

// Checked before use (Standards 1.2), so a changed server shows an error
// rather than a broken table.
const isStanding = (value: unknown): value is Standing => {
    const row = value as Standing;
    return !!row && Array.isArray(row.names) && typeof row.games === 'number'
        && typeof row.wins === 'number' && typeof row.score === 'number';
};

const isBoard = (value: unknown): value is Board => {
    const board = value as Board;
    return !!board && typeof board.player_count === 'number'
        && Array.isArray(board.players) && board.players.every(isStanding)
        && Array.isArray(board.teams) && board.teams.every(isStanding);
};

/** "3-1" for 3 wins, 1 loss. */
export const record = (row: Standing): string => `${row.wins}-${row.games - row.wins}`;

/** The score as a whole percentage, e.g. 0.2065 -> "21%". */
export const scorePercent = (row: Standing): string => `${Math.round(row.score * 100)}%`;
