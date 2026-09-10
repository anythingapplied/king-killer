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
        <div className="flex-1 flex flex-row items-center justify-center gap-4 lg:gap-12 relative min-h-0 py-4 w-full max-w-6xl mx-auto px-4 overflow-hidden">
            {/* Left: In Play Sidebar */}
            <div className="hidden md:flex flex-col items-center gap-4 flex-shrink-0 w-28">
                <AnimatePresence>
                    {gameState.played_cards.length > 0 && (
                        <motion.div 
                            initial={{ x: -50, opacity: 0 }} 
                            animate={{ x: 0, opacity: 1 }} 
                            exit={{ x: -50, opacity: 0 }}
                            data-testid="in-play-area" 
                            className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-3 rounded-2xl flex flex-col items-center shadow-xl"
                        >
                            <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">In Play</span>
                            <div className="flex flex-col items-center">
                                <span className="text-2xl font-black text-white">{gameState.played_cards.length}</span>
                                <span className="text-[8px] opacity-50 uppercase font-bold">Cards</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Center: Active Enemy */}
            {/* Increased pt to 8 to prevent ! clipping */}
            <div data-testid="enemy-area" className="flex flex-col items-center justify-center gap-4 flex-1 h-full max-h-[50vh] relative pt-8">
                {gameState.active_enemy ? (
                    <>
                        <motion.div 
                            key={gameState.active_enemy.card.id} 
                            initial={{ scale: 0.9, y: 20, opacity: 0 }} 
                            animate={{ scale: 1, y: 0, opacity: 1 }} 
                            exit={{ x: 500, opacity: 0, rotate: 10 }} 
                            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
                            className="relative h-[70%] max-h-[40vh] group"
                        >
                            <div className="absolute inset-0 bg-red-500/20 blur-[60px] rounded-full scale-150 -z-10 group-hover:bg-red-500/30 transition-colors duration-500"></div>
                            
                            <Card card={gameState.active_enemy.card} className="h-full w-auto aspect-[5/7] max-h-full relative z-10 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)] border border-white/10" />
                            
                            {/* Immunity Warning - Anchored to Card */}
                            {showWarning && (
                                <motion.div 
                                    animate={{ scale: [1, 1.2, 1], rotate: [0, 5, -5, 0] }} 
                                    transition={{ repeat: Infinity, duration: 2 }} 
                                    className="absolute -top-6 left-1/2 -translate-x-1/2 bg-red-600 text-white font-black rounded-full w-10 h-10 flex items-center justify-center border-4 border-slate-900 z-[60] shadow-2xl text-2xl"
                                >
                                    !
                                </motion.div>
                            )}
                            
                            {gameState.active_enemy.is_jester_active && (
                                <motion.div 
                                    initial={{ opacity: 0, y: 10 }} 
                                    animate={{ opacity: 1, y: 0 }}
                                    className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-purple-600 px-4 py-1 rounded-full text-[10px] font-black border-2 border-purple-400 shadow-2xl z-50 whitespace-nowrap"
                                >
                                    IMMUNITY CLEARED
                                </motion.div>
                            )}
                        </motion.div>
                        
                        <div className="flex justify-center gap-8 relative z-20 flex-shrink-0 h-16 w-full">
                            <div className="bg-slate-900/80 backdrop-blur-md px-6 py-2 rounded-2xl border border-red-500/30 flex flex-col items-center min-w-[100px] shadow-2xl relative">
                                <span className="text-[10px] text-red-400 font-black uppercase tracking-tighter mb-0.5">Health</span>
                                <span className="text-2xl font-black text-white">{gameState.active_enemy.current_health}</span>
                                <AnimatePresence mode="popLayout">
                                    {activeEffects.filter(e => e.type === 'damage').map(e => (
                                        <motion.div 
                                            key={e.id} 
                                            initial={{ x: 20, opacity: 0 }} 
                                            animate={{ x: 60, opacity: 1 }} 
                                            exit={{ x: 80, opacity: 0 }} 
                                            className="absolute left-full top-1/2 -translate-y-1/2 ml-2 pointer-events-none"
                                        >
                                            <span className="text-3xl font-black text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)] whitespace-nowrap">
                                                {e.value} ❤️
                                            </span>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </div>

                            <div className="bg-slate-900/80 backdrop-blur-md px-6 py-2 rounded-2xl border border-orange-500/30 flex flex-col items-center min-w-[100px] shadow-2xl relative">
                                <span className="text-[10px] text-orange-400 font-black uppercase tracking-tighter mb-0.5">Attack</span>
                                <div className="flex items-baseline gap-2">
                                  {gameState.shield_value > 0 && (
                                    <span className="text-sm line-through opacity-40 decoration-2 text-white">{gameState.active_enemy.base_attack}</span>
                                  )}
                                  <span className="text-2xl font-black text-white">{Math.max(0, gameState.active_enemy.base_attack - gameState.shield_value)}</span>
                                </div>
                                <AnimatePresence mode="popLayout">
                                    {activeEffects.filter(e => e.type === 'shield').map(e => (
                                        <motion.div 
                                            key={e.id} 
                                            initial={{ x: 20, opacity: 0 }} 
                                            animate={{ x: 60, opacity: 1 }} 
                                            exit={{ x: 80, opacity: 0 }} 
                                            className="absolute left-full top-1/2 -translate-y-1/2 ml-2 pointer-events-none"
                                        >
                                            <span className="text-3xl font-black text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)] whitespace-nowrap">
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
                        className="text-6xl font-black text-green-500 italic drop-shadow-[0_0_40px_rgba(34,197,94,0.4)] uppercase tracking-tighter"
                    >
                        Victory!
                    </motion.div>
                )}
            </div>

            {/* Right: Last Play Sidebar */}
            <div className="hidden md:flex flex-col items-center gap-4 flex-shrink-0 w-28">
                <AnimatePresence>
                    {gameState.last_played && (
                        <motion.div 
                            initial={{ x: 50, opacity: 0 }} 
                            animate={{ x: 0, opacity: 1 }} 
                            exit={{ x: 50, opacity: 0 }}
                            data-testid="previous-play-area" 
                            className="bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 p-2 rounded-2xl flex flex-col items-center shadow-xl"
                        >
                            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2 text-center">Last Play</span>
                            <div className="flex gap-1 flex-wrap justify-center max-w-[80px]">
                                {gameState.last_played.map((c) => <Card key={c.id} card={c} className="w-8 h-11 shadow-lg" />)}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};

export default Arena;
