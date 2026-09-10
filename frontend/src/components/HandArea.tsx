import React from 'react';
import type { Card as CardType, Suit, TurnPhase } from '../types';
import { isSelectionValid } from '../gameLogic';
import Card from '../Card';
import { motion, AnimatePresence } from 'framer-motion';

interface HandAreaProps {
    sortedHand: { card: CardType, originalIndex: number }[];
    maxHandSize: number;
    isMyTurn: boolean;
    selectedIndices: number[];
    damageNeeded: number;
    currentDiscardValue: number;
    phase: TurnPhase;
    enemySuit: Suit | null;
    isJesterActive: boolean;
    onCardClick: (index: number) => void;
    actualHand: CardType[];
    currentPlayerIndex: number;
    discardRemaining: number;
}

const HandArea: React.FC<HandAreaProps> = ({ 
    sortedHand, maxHandSize, isMyTurn, selectedIndices, 
    damageNeeded, currentDiscardValue, phase, enemySuit, isJesterActive,
    onCardClick, actualHand, currentPlayerIndex, discardRemaining
}) => {
    const currentSelection = selectedIndices.map(idx => actualHand[idx]).filter(Boolean) as CardType[];
    const isDiscarding = damageNeeded > 0;

    return (
        <div data-testid="hand-area" className="flex flex-col items-center relative px-4 pb-2">
            {/* Status Indicator Above Hand */}
            <div className="flex items-center justify-center h-10 mb-2">
                <div className={`px-10 py-1.5 rounded-full font-black border shadow-xl text-[10px] transition-all duration-300 ${isDiscarding ? 'bg-red-600 border-red-400 text-white animate-pulse' : isMyTurn ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-800 border-slate-700 text-slate-500 opacity-60'}`}>
                    {isDiscarding ? (isMyTurn ? `DISCARD ${discardRemaining} REMAINING` : `P${currentPlayerIndex + 1} DISCARDING...`) : (isMyTurn ? "YOUR TURN" : `WAITING FOR P${currentPlayerIndex + 1}...`)}
                </div>
            </div>

            <div className="flex flex-row justify-center gap-2 lg:gap-4 max-w-full overflow-visible h-32 lg:h-44 items-end">
                <AnimatePresence mode="popLayout" initial={false}>
                    {[...Array(maxHandSize)].map((_, i) => {
                        const item = sortedHand[i];
                        if (item) {
                            const isSel = selectedIndices.includes(item.originalIndex);
                            const isImmune = enemySuit === item.card.suit && !isJesterActive;
                            const showWarning = isImmune && isSel && !isDiscarding;
                            
                            const shouldGrey = isMyTurn && !isSel && (
                                !isSelectionValid(item.card, currentSelection, phase) || 
                                (damageNeeded > 0 && currentDiscardValue >= damageNeeded)
                            );

                            return (
                                <motion.div 
                                    key={item.card.id} 
                                    layoutId={`hand-slot-${item.card.id}`}
                                    initial={{ y: -350, x: -120, opacity: 0, scale: 0.7 }} 
                                    animate={{ y: 0, x: 0, opacity: 1, scale: 1 }} 
                                    exit={{ y: 100, opacity: 0, scale: 0.8 }}
                                    transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                                    className="relative flex-shrink-0 h-full flex items-end"
                                >
                                    <Card 
                                        card={item.card} 
                                        selected={isSel} 
                                        onClick={() => isMyTurn && onCardClick(item.originalIndex)} 
                                        className={`w-[11vw] max-w-[95px] transition-all duration-300 ${!isMyTurn ? 'opacity-40 grayscale-[0.4] pointer-events-none' : ''} ${shouldGrey ? 'opacity-10 grayscale brightness-[0.2]' : ''}`} 
                                    />
                                    {showWarning && (
                                        <motion.div 
                                            initial={{ scale: 0 }} animate={{ scale: 1 }}
                                            className="absolute -top-3 -right-3 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-black border-2 border-white z-[110] shadow-xl"
                                        >
                                            !
                                        </motion.div>
                                    )}
                                </motion.div>
                            );
                        } else return (
                            <motion.div key={`empty-${i}`} layout className="flex-shrink-0 h-full flex items-end">
                                <Card isEmpty className="w-[11vw] max-w-[95px]" />
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        </div>
    );
};

export default HandArea;
