import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLeaderboard, record, scorePercent, type Standing } from '../src/leaderboard';

const row = (wins: number, games: number, score: number): Standing => ({ names: ['Ann'], wins, games, score });

describe('leaderboard display', () => {
    it('shows wins-losses and a whole-number score', () => {
        expect(record(row(3, 4, 0.3))).toBe('3-1');
        expect(record(row(0, 0, 0))).toBe('0-0');
        expect(scorePercent(row(1, 1, 0.2065))).toBe('21%');
        expect(scorePercent(row(0, 3, 0))).toBe('0%');
    });
});

describe('fetchLeaderboard', () => {
    afterEach(() => vi.unstubAllGlobals());

    const answer = (body: unknown, status = 200) =>
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

    it('returns well-formed boards', async () => {
        const boards = [{ player_count: 1, players: [{ names: ['Ann'], games: 1, wins: 1, score: 0.2 }], teams: [] }];
        answer(boards);
        expect(await fetchLeaderboard()).toEqual(boards);
    });

    it('rejects an error status or an unexpected shape rather than showing a broken table', async () => {
        answer({ message: 'down' }, 500);
        await expect(fetchLeaderboard()).rejects.toThrow('500');
        answer({ boards: [] });
        await expect(fetchLeaderboard()).rejects.toThrow('unexpected shape');
        answer([{ player_count: 2, players: [{ names: 'Ann', games: 1, wins: 1, score: 0.2 }], teams: [] }]);
        await expect(fetchLeaderboard()).rejects.toThrow('unexpected shape');
    });
});
