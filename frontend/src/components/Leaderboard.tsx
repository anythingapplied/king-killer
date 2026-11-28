/**
 * Leaderboard.tsx - the standings, one tab per table size. Multiplayer tabs
 * show the best players and the best teams (the same people, whatever seats
 * they sat in).
 *
 * Shows loading, error and empty states, and cancels its request if it
 * closes first (Standards 16.4).
 *
 * Changes:
 * - 2026-11-27: Created.
 */
import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import { fetchLeaderboard, record, scorePercent, type Board, type Standing } from '../leaderboard';

interface LeaderboardProps {
    onClose: () => void;
    /** The tab to open on, e.g. the size of the game just played. */
    initialPlayerCount?: number;
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; boards: Board[] };

const StandingList: React.FC<{ title: string; rows: Standing[]; testId: string; empty: string }> = ({ title, rows, testId, empty }) => (
    <section data-testid={testId} className="flex flex-col gap-1">
        <h3 className="t-micro font-black uppercase tracking-widest text-slate-400">{title}</h3>
        {rows.length === 0 ? (
            <p className="t-label text-slate-500 py-2">{empty}</p>
        ) : (
            <ol className="flex flex-col gap-1">
                {rows.map((row, i) => (
                    <li key={row.names.join('+')} className="flex items-center gap-2 bg-slate-800/60 rounded-xl px-3 py-1.5">
                        <span className="t-micro font-mono text-slate-500 w-5 text-right shrink-0">{i + 1}</span>
                        <span className="t-label font-black text-slate-200 min-w-0 flex-1 truncate">{row.names.join(' + ')}</span>
                        <span className="t-micro text-slate-400 shrink-0" title={`${row.wins} won, ${row.games - row.wins} lost`}>{record(row)}</span>
                        <span className="t-label font-black text-amber-300 w-10 text-right shrink-0" title="Win rate, at least (95% confidence)">{scorePercent(row)}</span>
                    </li>
                ))}
            </ol>
        )}
    </section>
);

const Leaderboard: React.FC<LeaderboardProps> = ({ onClose, initialPlayerCount = 1 }) => {
    const [load, setLoad] = useState<Load>({ state: 'loading' });
    const [playerCount, setPlayerCount] = useState(initialPlayerCount);

    useEffect(() => {
        const controller = new AbortController();
        fetchLeaderboard(controller.signal)
            .then(boards => setLoad({ state: 'ready', boards }))
            .catch((error: unknown) => {
                // Closing the board cancels the request; that isn't an error.
                if (controller.signal.aborted) return;
                setLoad({ state: 'error', message: error instanceof Error ? error.message : 'Could not load the leaderboard.' });
            });
        return () => controller.abort();
    }, []);

    const board = load.state === 'ready' ? load.boards.find(b => b.player_count === playerCount) : undefined;

    return (
        <Modal title="Leaderboard" onClose={onClose} testId="leaderboard">
            <div role="tablist" aria-label="Table size" className="grid grid-cols-4 gap-1">
                {[1, 2, 3, 4].map(n => (
                    <button
                        key={n}
                        role="tab"
                        aria-selected={playerCount === n}
                        onClick={() => setPlayerCount(n)}
                        className={`t-micro font-black uppercase rounded-full py-1.5 border ${playerCount === n ? 'bg-blue-600 border-blue-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'}`}
                    >
                        {n === 1 ? 'Solo' : `${n} players`}
                    </button>
                ))}
            </div>

            {load.state === 'loading' && <p className="t-label text-slate-500 text-center py-6">Loading…</p>}
            {load.state === 'error' && (
                <p role="alert" className="t-label text-red-300 text-center py-6">{load.message}</p>
            )}
            {load.state === 'ready' && board && (
                <>
                    <StandingList
                        title={playerCount === 1 ? 'Players' : 'Best players'}
                        rows={board.players}
                        testId="leaderboard-players"
                        empty="No finished games at this size yet."
                    />
                    {playerCount > 1 && (
                        <StandingList title="Best teams" rows={board.teams} testId="leaderboard-teams" empty="No team has finished a game yet." />
                    )}
                </>
            )}

            <p className="t-micro text-slate-500 leading-relaxed">
                Ranked by the win rate each player or team has shown with 95% confidence, so a few lucky games
                can't top the board: one win from one game only shows at least 21%. Games count once they're won
                or lost.
            </p>
        </Modal>
    );
};

export default Leaderboard;
