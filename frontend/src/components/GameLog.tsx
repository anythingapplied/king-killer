import React from 'react';
import type { GameState, LogEntry } from '../types';
import Card from '../Card';
import Modal from './Modal';

interface GameLogProps {
    gameState: GameState;
    onClose: () => void;
}

/** Verb and colour for each kind of entry. */
const STYLES: Record<LogEntry['kind'], { verb: string; tone: string }> = {
    Played: { verb: 'played', tone: 'text-blue-300' },
    Yielded: { verb: 'yielded', tone: 'text-amber-400' },
    Discarded: { verb: 'discarded', tone: 'text-red-300' },
    Jester: { verb: 'burned a Jester', tone: 'text-purple-300' },
    EnemyDefeated: { verb: 'Enemy defeated', tone: 'text-green-400' },
    EnemyRevealed: { verb: 'Enemy revealed', tone: 'text-slate-400' },
};

const GameLog: React.FC<GameLogProps> = ({ gameState, onClose }) => {
    const log = gameState.game_log ?? [];
    const name = (i: number | null) =>
        i === null ? null : gameState.players[i]?.name || `Player ${i + 1}`;

    return (
        <Modal title="Game Log" onClose={onClose} testId="game-log">
            {log.length === 0 ? (
                <p className="t-label text-slate-500 text-center py-6">Nothing has happened yet.</p>
            ) : (
                log.slice().reverse().map((entry, i) => {
                    const style = STYLES[entry.kind];
                    const who = name(entry.player);
                    return (
                        <div key={log.length - 1 - i} className="flex items-center gap-2 border-b border-white/5 pb-2 last:border-0">
                            <span className="t-micro text-slate-600 font-mono w-6 shrink-0 text-right">{log.length - i}</span>
                            <span className={`t-label font-black ${style.tone} min-w-0`}>
                                {who ? <span className="text-slate-300">{who} </span> : null}
                                {style.verb}
                            </span>
                            {entry.cards.length > 0 && (
                                <div className="flex gap-0.5 flex-wrap ml-auto">
                                    {entry.cards.map(c => <Card key={c.id} card={c} className="w-5 sm:w-6 shadow" />)}
                                </div>
                            )}
                        </div>
                    );
                })
            )}
        </Modal>
    );
};

export default GameLog;
