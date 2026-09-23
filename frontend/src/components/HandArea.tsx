import React, { useEffect, useLayoutEffect, useRef } from 'react';
import type { Card as CardType, Suit, TurnPhase } from '../types';
import { isSelectionValid } from '../gameLogic';
import Card from '../Card';
import { motion, AnimatePresence, animate, useMotionValue } from 'framer-motion';

const DRAW_SPRING = { type: 'spring', stiffness: 260, damping: 30 } as const;

/**
 * A hand slot that, when it mounts after the hand is already on screen, flies
 * its card in from the Tavern deck to wherever sorting placed it.
 *
 * The offset can't be a static `initial` - it depends on where this slot ended
 * up in the sorted row and where the Tavern sits in the HUD, both of which are
 * only known after layout. A layout effect measures both before the browser
 * paints, parks the card over the deck, then springs it home, so the card is
 * never seen in its final slot first.
 *
 * `handMounted` is the parent's "past the first render" flag. Child layout
 * effects run before the parent's effects, so on the hand's first mount (the
 * initial deal, a reconnect) every slot still sees `false` and just appears -
 * the same behaviour `AnimatePresence initial={false}` gave before.
 */
const DrawnCardSlot = React.forwardRef<HTMLDivElement, {
    cardId: number;
    handMounted: React.RefObject<boolean>;
    children: React.ReactNode;
}>(({ cardId, handMounted, children }, forwardedRef) => {
    const slotRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const scale = useMotionValue(1);
    const opacity = useMotionValue(1);

    useLayoutEffect(() => {
        if (!handMounted.current || !slotRef.current || !cardRef.current) return;
        // The card's *resting* box, derived without reading its own rect: once
        // jump() below has run, that rect already sits over the deck, and in
        // dev StrictMode re-runs this effect - measuring it then gave an
        // offset of ~0 and the card barely moved. The outer slot is never
        // transformed on mount, the card is bottom-aligned in it (.hand-slot
        // is `align-items: flex-end`), and offsetWidth/Height ignore transforms.
        const outer = slotRef.current.getBoundingClientRect();
        const w = cardRef.current.offsetWidth;
        const h = cardRef.current.offsetHeight;
        const slot = { cx: outer.left + w / 2, cy: outer.bottom - h / 2, width: w };
        const tavern = document.querySelector('[data-testid="tavern-slot"]')?.getBoundingClientRect();
        if (!tavern || slot.width === 0) {
            // No deck on screen to fly from: a plain fade-in is still better
            // than a card that pops into place.
            opacity.jump(0);
            const fade = animate(opacity, 1, { duration: 0.25 });
            return () => fade.stop();
        }

        // jump(), not set(): set() from 0 to a few hundred px in one frame
        // reads to framer as an enormous velocity, which the spring then
        // inherits - the card shot past its slot and swung back. jump() places
        // the value and zeroes its velocity, and the springs start from rest.
        x.jump(tavern.left + tavern.width / 2 - slot.cx);
        y.jump(tavern.top + tavern.height / 2 - slot.cy);
        scale.jump(Math.min(1, Math.max(0.25, tavern.width / slot.width)));
        opacity.jump(0.6);
        const moves = [
            animate(x, 0, { ...DRAW_SPRING, velocity: 0 }),
            animate(y, 0, { ...DRAW_SPRING, velocity: 0 }),
            animate(scale, 1, { ...DRAW_SPRING, velocity: 0 }),
            animate(opacity, 1, { duration: 0.2 }),
        ];
        return () => moves.forEach(m => m.stop());
        // Only on mount: a card's flight is decided by the draw that created it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Two layers on purpose. The outer slot carries the layoutId, so framer's
    // layout projection owns its transform (sliding neighbours aside as the
    // sorted row changes); offsets set on that same element get overwritten
    // mid-flight. The flight lives on an inner wrapper the projection leaves
    // alone.
    return (
        <motion.div
            ref={(el: HTMLDivElement | null) => {
                slotRef.current = el;
                // AnimatePresence's popLayout needs the slot's node too.
                if (typeof forwardedRef === 'function') forwardedRef(el);
                else if (forwardedRef) forwardedRef.current = el;
            }}
            layoutId={`hand-slot-${cardId}`}
            exit={{ y: 100, opacity: 0, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            className="hand-slot relative"
        >
            <motion.div ref={cardRef} style={{ x, y, scale, opacity }} className="w-full relative">
                {children}
            </motion.div>
        </motion.div>
    );
});
DrawnCardSlot.displayName = 'DrawnCardSlot';

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
    // Flipped after the first render's child layout effects have run, so only
    // cards that arrive later fly in from the deck (see DrawnCardSlot).
    const handMounted = useRef(false);
    useEffect(() => {
        handMounted.current = true;
    }, []);

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
                                <DrawnCardSlot
                                    key={item.card.id}
                                    cardId={item.card.id}
                                    handMounted={handMounted}
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
                                </DrawnCardSlot>
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
