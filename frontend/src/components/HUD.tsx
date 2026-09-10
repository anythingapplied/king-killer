import React from 'react';
import type { GameState, CombatEffect } from '../types';
import type { DefeatFlight } from '../hooks/useGameLogic';
import Card from '../Card';
import { motion, AnimatePresence } from 'framer-motion';

interface HUDProps {
    gameId: string;
    myPlayerId: number;
    gameState: GameState;
    copySuccess: boolean;
    activeEffects: CombatEffect[];
    defeatFlight: DefeatFlight | null;
    onMenuClick: () => void;
    onCopyIdClick: () => void;
    onSoloJesterClick: () => void;
}

const HUD: React.FC<HUDProps> = ({ 
    myPlayerId, gameState, copySuccess, activeEffects, defeatFlight,
    onMenuClick, onCopyIdClick, onSoloJesterClick 
}) => {
    const isSolo = gameState.players.length === 1;
    const me = gameState.players[myPlayerId];
    const mustRefreshSolo = isSolo && me.hand.length === 0 && gameState.solo_jesters > 0;
    const isMyTurn = gameState.current_player_index === myPlayerId;

    const currentTierEnemies = gameState.active_enemy ? 
        gameState.castle_deck.filter(c => JSON.stringify(c.rank) === JSON.stringify(gameState.active_enemy?.card.rank))
        : [];

    // While the defeated card flies between the board and its pile, mount a
    // mini card at the destination carrying the same layoutId so framer-motion
    // animates the flight.
    const flyingTo = defeatFlight?.flying ? defeatFlight.dest : null;

    return (
        <div data-testid="hud" className="z-[100] bg-slate-800/90 p-2 rounded-xl shadow-2xl border border-slate-700/50 backdrop-blur-md relative max-w-2xl mx-auto w-full flex-shrink-0">
            <div className="flex justify-between items-center px-1 mb-1">
                <button onClick={onMenuClick} className="bg-slate-700 text-[8px] font-black px-3 py-1 rounded-full border border-slate-600 shadow uppercase hover:bg-slate-600">Menu</button>
                <div className="bg-blue-600 text-[9px] font-black px-4 py-1 rounded-full border-2 border-slate-900 shadow-xl uppercase tracking-widest whitespace-nowrap">Player {myPlayerId + 1}</div>
                <button onClick={onCopyIdClick} className={`flex items-center gap-1 px-3 py-1 rounded-full border text-[8px] font-mono transition-all ${copySuccess ? 'bg-green-900/40 border-green-500 text-green-300' : 'bg-slate-950 border-slate-800'}`}>
                    {copySuccess ? 'Copied!' : `🔗 Share`}
                </button>
            </div>

            <div className="flex justify-between items-center mb-1 px-2">
                <div className="text-center w-16 relative">
                    <div className="text-[7px] uppercase tracking-wider text-green-400 font-black">Tavern</div>
                    <div className="text-lg font-black leading-none">🍺 {gameState.tavern_deck.length}</div>
                    <AnimatePresence>
                        {flyingTo === 'tavern' && defeatFlight && (
                            <motion.div
                                initial={{ scale: 1, opacity: 1 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                layoutId={String(defeatFlight.id)}
                                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                className="pointer-events-none"
                            >
                                <Card card={defeatFlight.card} className="w-7 h-10 shadow-2xl" />
                            </motion.div>
                        )}
                        {activeEffects.filter(e => e.type === 'heal').map(e => (
                            <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -30, opacity: 0 }} exit={{ opacity: 0 }} className="absolute inset-x-0 -top-4 text-xs text-green-400 font-black">{e.value}</motion.span>
                        ))}
                    </AnimatePresence>
                </div>

                <div className="text-center flex-1 mx-4">
                    <div className="text-[7px] uppercase tracking-wider text-red-400 font-black mb-0.5">Tier</div>
                    <div className="flex justify-center gap-1.5 h-11">
                        {currentTierEnemies.map((c) => <Card key={c.id} card={c} className="w-8 h-11 border border-slate-600 shadow-lg" />)}
                    </div>
                </div>

                <div className="text-center w-16 relative">
                    <div className="text-[7px] uppercase tracking-wider text-slate-400 font-black">Discard</div>
                    <div className="text-xl font-black leading-none">🗑️ {gameState.discard_pile.length}</div>
                    <AnimatePresence>
                        {flyingTo === 'discard' && defeatFlight && (
                            <motion.div
                                initial={{ scale: 1, opacity: 1 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ opacity: 0, scale: 0.8 }}
                                layoutId={String(defeatFlight.id)}
                                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                className="pointer-events-none"
                            >
                                <Card card={defeatFlight.card} className="w-7 h-10 shadow-2xl" />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {isSolo && gameState.solo_jesters > 0 && (
                <div className="flex justify-center gap-4 py-1 border-t border-slate-700/20">
                    {[...Array(2)].map((_, i) => (
                        <button key={i} disabled={!isMyTurn} onClick={onSoloJesterClick} className={`w-7 h-9 rounded border flex items-center justify-center text-sm transition-all ${i < gameState.solo_jesters ? `border-purple-500 bg-purple-900/40 shadow-lg ${mustRefreshSolo ? 'animate-bounce border-purple-400' : ''}` : 'border-slate-800 bg-slate-900 opacity-20 grayscale cursor-not-allowed'}`}>🃏</button>
                    ))}
                </div>
            )}

            <div className="flex gap-2 justify-center flex-wrap border-t border-slate-700/30 pt-1.5">
                {gameState.players.map((p, i) => (
                    <div key={i} className={`px-2 py-0.5 rounded-full text-[8px] font-black border transition-all flex items-center gap-1 relative ${gameState.current_player_index === i ? 'bg-blue-600 border-blue-400 shadow-lg scale-105' : 'bg-slate-900/50 border-slate-700 opacity-50'}`}>
                        {myPlayerId === i && <span className="w-1 h-1 bg-green-400 rounded-full animate-pulse"></span>} P{i+1}: {p.hand.length}
                        <AnimatePresence>
                            {activeEffects.filter(e => e.type === 'draw' && (gameState.current_player_index + gameState.players.length) % gameState.players.length === i).map(e => (
                                <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -20, opacity: 0 }} exit={{ opacity: 0 }} className="absolute inset-x-0 -top-4 text-[10px] text-blue-400 font-black text-center">{e.value}</motion.span>
                            ))}
                        </AnimatePresence>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default HUD;
