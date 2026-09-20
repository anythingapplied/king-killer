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
    playerNames: string[];
}

const HandArea: React.FC<HandAreaProps> = ({
    sortedHand, maxHandSize, isMyTurn, selectedIndices,
    damageNeeded, currentDiscardValue, phase, enemySuit, isJesterActive,
    onCardClick, actualHand, currentPlayerIndex, discardRemaining, playerNames
}) => {
    const currentSelection = selectedIndices.map(idx => actualHand[idx]).filter(Boolean) as CardType[];
    const isDiscarding = damageNeeded > 0;
    const isChoosing = phase === 'AwaitingNextPlayer';
    const canInteract = isMyTurn && !isChoosing;

    // The hand can briefly hold more than the limit is not possible, but a
    // stale/short max_hand_size must never clip real cards off the row.
    const slotCount = Math.max(maxHandSize, sortedHand.length, 1);
    const waitingOn = playerNames[currentPlayerIndex] || `P${currentPlayerIndex + 1}`;

    const statusText = isChoosing
        ? (isMyTurn ? 'CHOOSE NEXT PLAYER' : 'JESTER CHOOSING…')
        : isDiscarding
            ? (isMyTurn ? `DISCARD ${discardRemaining} REMAINING` : `${waitingOn} DISCARDING…`)
            : (isMyTurn ? 'YOUR TURN' : `WAITING FOR ${waitingOn}…`);

    return (
        <div data-testid="hand-area" className="flex flex-col items-center relative px-2 sm:px-4 pb-1.5">
            {/* Status Indicator Above Hand */}
            <div className="flex items-center justify-center py-1.5 sm:py-2">
                <div className={`t-label px-4 sm:px-10 py-1 sm:py-1.5 rounded-full font-black border shadow-xl text-center max-w-full truncate transition-all duration-300 ${isChoosing ? 'bg-purple-600 border-purple-400 text-white' : isDiscarding ? 'bg-red-600 border-red-400 text-white animate-pulse' : isMyTurn ? 'bg-blue-600 border-blue-400 text-white shadow-lg' : 'bg-slate-800 border-slate-700 text-slate-500 opacity-60'}`}>
                    {statusText}
                </div>
            </div>

            {/* Slots are flex-basis:0 so 5 and 8 card hands both fit the width,
                and each is capped at the width implied by the row height. */}
            <div className="hand-row max-w-5xl">
                <AnimatePresence mode="popLayout" initial={false}>
                    {[...Array(slotCount)].map((_, i) => {
                        const item = sortedHand[i];
                        if (item) {
                            const isSel = selectedIndices.includes(item.originalIndex);
                            const isImmune = enemySuit === item.card.suit && !isJesterActive;
                            const showWarning = isImmune && isSel && !isDiscarding;

                            const shouldGrey = canInteract && !isSel && (
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
                                    className="hand-slot relative"
                                >
                                    <Card
                                        card={item.card}
                                        selected={isSel}
                                        onClick={canInteract ? () => onCardClick(item.originalIndex) : undefined}
                                        className={`hand-card transition-all duration-300 ${!canInteract ? 'opacity-40 grayscale-[0.4] pointer-events-none' : ''} ${shouldGrey ? 'opacity-10 grayscale brightness-[0.2]' : ''}`}
                                    />
                                    {showWarning && (
                                        <motion.div
                                            initial={{ scale: 0 }} animate={{ scale: 1 }}
                                            className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center t-body font-black border-2 border-white z-[110] shadow-xl"
                                        >
                                            !
                                        </motion.div>
                                    )}
                                </motion.div>
                            );
                        } else return (
                            <motion.div key={`empty-${i}`} layout className="hand-slot">
                                <Card isEmpty className="hand-card rounded-md" />
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        </div>
    );
};

export default HandArea;
