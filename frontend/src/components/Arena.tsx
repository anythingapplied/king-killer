import React from 'react';
import type { GameState, CombatEffect } from '../types';
import Card from '../Card';
import { motion, AnimatePresence } from 'framer-motion';

interface ArenaProps {
    gameState: GameState;
    activeEffects: CombatEffect[];
    isImmuneWarning: boolean;
    isDiscarding: boolean;
}

const Arena: React.FC<ArenaProps> = ({ gameState, activeEffects, isImmuneWarning, isDiscarding }) => {
    // Only show warning if not in discard phase
    const showWarning = isImmuneWarning && !isDiscarding;

    return (
        <div className="min-h-0 flex flex-row items-stretch justify-center gap-2 sm:gap-4 lg:gap-12 relative py-2 sm:py-4 w-full max-w-6xl mx-auto px-2 sm:px-4 overflow-hidden">
            {/* Left: In Play. Kept as a flex sibling (not an overlay) at every
                width so it can never cover the board; it just gets narrower. */}
            <div className="flex flex-col items-center justify-center gap-2 sm:gap-3 flex-shrink-0 w-12 sm:w-16 md:w-28">
                <AnimatePresence>
                    {gameState.played_cards.length > 0 && (
                        <motion.div 
                            initial={{ x: -50, opacity: 0 }} 
                            animate={{ x: 0, opacity: 1 }} 
                            exit={{ x: -50, opacity: 0 }}
                            data-testid="in-play-area" 
                            className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-1.5 md:p-3 rounded-xl md:rounded-2xl flex flex-col items-center shadow-xl w-full"
                        >
                            <span className="t-micro font-black text-blue-400 uppercase tracking-widest mb-0.5 md:mb-1 text-center leading-tight">In Play</span>
                            <div className="flex flex-col items-center">
                                <span className="t-stat font-black text-white leading-none">{gameState.played_cards.length}</span>
                                <span className="t-micro opacity-50 uppercase font-bold hidden md:block">Cards</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* What the last player threw away to soak the enemy's hit.
                    The core has tracked this all along (and clears it when a
                    Hearts shuffle invalidates it) but nothing ever showed it. */}
                <AnimatePresence>
                    {gameState.last_discarded && gameState.last_discarded.length > 0 && (
                        <motion.div
                            initial={{ x: -50, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: -50, opacity: 0 }}
                            data-testid="last-discarded-area"
                            className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-1.5 md:p-2 rounded-xl md:rounded-2xl flex flex-col items-center shadow-xl w-full"
                        >
                            <span className="t-micro font-black text-slate-400 uppercase tracking-widest mb-1 text-center leading-tight">Discarded</span>
                            <div className="flex gap-0.5 md:gap-1 flex-wrap justify-center w-full">
                                {gameState.last_discarded.slice(0, 4).map((c) => <Card key={c.id} card={c} className="thumb-card shadow-lg" />)}
                            </div>
                            {gameState.last_discarded.length > 4 && (
                                <span className="t-micro font-black text-slate-500 mt-0.5">+{gameState.last_discarded.length - 4}</span>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Center: Active Enemy. The card region is a flex child with
                min-h-0, so the card is sized by whatever height this row
                actually got rather than by a guessed vh fraction. */}
            <div data-testid="enemy-area" className="flex flex-col items-center justify-center gap-2 sm:gap-3 flex-1 min-w-0 min-h-0 relative pt-5 sm:pt-7">
                {gameState.active_enemy ? (
                    <>
                        <motion.div 
                            key={gameState.active_enemy.card.id} 
                            initial={{ opacity: 0, y: -40, scale: 0.96 }} 
                            animate={{ opacity: 1, y: 0, scale: 1 }} 
                            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                            data-testid="enemy-card"
                            className="relative flex-1 min-h-0 flex items-center justify-center w-full group"
                        >
                            <div className="absolute inset-0 bg-red-500/20 blur-[60px] rounded-full scale-150 -z-10 group-hover:bg-red-500/30 transition-colors duration-500"></div>
                            
                            {/* object-contain inside means a narrow column letterboxes
                                the art instead of stretching it. */}
                            <Card card={gameState.active_enemy.card} className="h-full w-auto max-w-full relative z-10 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)] border border-white/10" />
                            
                            {/* Immunity Warning - Anchored to Card */}
                            {showWarning && (
                                <motion.div 
                                    animate={{ scale: [1, 1.2, 1], rotate: [0, 5, -5, 0] }} 
                                    transition={{ repeat: Infinity, duration: 2 }} 
                                    className="absolute -top-1 left-1/2 -translate-x-1/2 bg-red-600 text-white font-black rounded-full w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center border-4 border-slate-900 z-[60] shadow-2xl t-stat leading-none"
                                >
                                    !
                                </motion.div>
                            )}
                            
                            {gameState.active_enemy.is_jester_active && (
                                <motion.div 
                                    initial={{ opacity: 0, y: 10 }} 
                                    animate={{ opacity: 1, y: 0 }}
                                    className="absolute bottom-0 left-1/2 -translate-x-1/2 bg-purple-600 px-2 sm:px-4 py-0.5 sm:py-1 rounded-full t-micro font-black border-2 border-purple-400 shadow-2xl z-50 whitespace-nowrap"
                                >
                                    IMMUNITY CLEARED
                                </motion.div>
                            )}
                        </motion.div>
                        
                        <div className="flex justify-center gap-3 sm:gap-8 relative z-20 flex-shrink-0 w-full">
                            <div className="bg-slate-900/80 backdrop-blur-md px-3 sm:px-6 py-1 sm:py-2 rounded-xl sm:rounded-2xl border border-red-500/30 flex flex-col items-center min-w-[4.5rem] sm:min-w-[100px] shadow-2xl relative">
                                <span className="t-micro text-red-400 font-black uppercase tracking-tighter">Health</span>
                                <span className="t-stat font-black text-white leading-none">{gameState.active_enemy.current_health}</span>
                                <AnimatePresence mode="popLayout">
                                    {activeEffects.filter(e => e.type === 'damage').map(e => (
                                        <motion.div 
                                            key={e.id} 
                                            initial={{ x: 10, opacity: 0 }} 
                                            animate={{ x: 30, opacity: 1 }} 
                                            exit={{ x: 45, opacity: 0 }} 
                                            className="absolute left-full top-1/2 -translate-y-1/2 ml-1 pointer-events-none"
                                        >
                                            <span className="t-stat font-black text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)] whitespace-nowrap">
                                                {e.value} ❤️
                                            </span>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </div>

                            <div className="bg-slate-900/80 backdrop-blur-md px-3 sm:px-6 py-1 sm:py-2 rounded-xl sm:rounded-2xl border border-orange-500/30 flex flex-col items-center min-w-[4.5rem] sm:min-w-[100px] shadow-2xl relative">
                                <span className="t-micro text-orange-400 font-black uppercase tracking-tighter">Attack</span>
                                <div className="flex items-baseline gap-1.5">
                                  {gameState.shield_value > 0 && (
                                    <span className="t-label line-through opacity-40 decoration-2 text-white">{gameState.active_enemy.base_attack}</span>
                                  )}
                                  <span className="t-stat font-black text-white leading-none">{Math.max(0, gameState.active_enemy.base_attack - gameState.shield_value)}</span>
                                </div>
                                <AnimatePresence mode="popLayout">
                                    {activeEffects.filter(e => e.type === 'shield').map(e => (
                                        <motion.div 
                                            key={e.id} 
                                            initial={{ x: 10, opacity: 0 }} 
                                            animate={{ x: 30, opacity: 1 }} 
                                            exit={{ x: 45, opacity: 0 }} 
                                            className="absolute left-full top-1/2 -translate-y-1/2 ml-1 pointer-events-none"
                                        >
                                            <span className="t-stat font-black text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)] whitespace-nowrap">
                                                {e.value} 🛡️
                                            </span>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </div>
                        </div>
                    </>
                ) : (
                    <motion.div 
                        initial={{ scale: 0.8, opacity: 0 }} 
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-[clamp(2rem,9vw,4rem)] font-black text-green-500 italic drop-shadow-[0_0_40px_rgba(34,197,94,0.4)] uppercase tracking-tighter"
                    >
                        Victory!
                    </motion.div>
                )}
            </div>

            {/* Right: Last Play Sidebar */}
            <div className="flex flex-col items-center justify-center gap-4 flex-shrink-0 w-12 sm:w-16 md:w-28">
                <AnimatePresence>
                    {gameState.last_played && gameState.last_played.length > 0 && (
                        <motion.div 
                            initial={{ x: 50, opacity: 0 }} 
                            animate={{ x: 0, opacity: 1 }} 
                            exit={{ x: 50, opacity: 0 }}
                            data-testid="previous-play-area" 
                            className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-1.5 md:p-2 rounded-xl md:rounded-2xl flex flex-col items-center shadow-xl w-full"
                        >
                            <span className="t-micro font-black text-slate-400 uppercase tracking-widest mb-1 text-center leading-tight">Last Play</span>
                            <div className="flex gap-0.5 md:gap-1 flex-wrap justify-center w-full">
                                {gameState.last_played.map((c) => <Card key={c.id} card={c} className="thumb-card shadow-lg" />)}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};

export default Arena;
