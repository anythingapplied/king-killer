import React from 'react';
import { motion } from 'framer-motion';

interface ModalProps {
    title: string;
    onClose: () => void;
    /** Rendered inside the scrolling body. */
    children: React.ReactNode;
    /** Pinned below the body and never scrolls — e.g. a chat composer. */
    footer?: React.ReactNode;
    testId?: string;
    /**
     * Render as a panel in the side column beside the board (wide screens)
     * instead of a full-screen overlay, so the game stays playable and both
     * panels can be open at once. It shares the column's height with any
     * other open panel.
     */
    docked?: boolean;
}

/**
 * Shared shell for the game log and chat panels.
 *
 * Both had their own copy of the backdrop, the click-outside-to-close wiring,
 * the stopPropagation guard, the header, and the dvh-capped height — so a fix
 * to one silently didn't apply to the other.
 */
const Modal: React.FC<ModalProps> = ({ title, onClose, children, footer, testId, docked }) => {
    const body = (
        <>
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 flex-shrink-0">
                <h2 className="t-body font-black uppercase tracking-widest text-slate-300">{title}</h2>
                <button onClick={onClose} className="t-micro bg-slate-700 hover:bg-slate-600 font-black px-3 py-1.5 rounded-full border border-slate-600 uppercase">Close</button>
            </div>
            <div className="overflow-y-auto px-4 py-3 flex flex-col gap-2 flex-1 min-h-0">
                {children}
            </div>
            {footer}
        </>
    );

    if (docked) {
        return (
            <motion.section
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
                aria-label={title}
                className="bg-slate-900 border border-slate-700 rounded-2xl shadow-xl flex flex-col flex-1 min-h-0"
                data-testid={testId}
                data-docked="true"
            >
                {body}
            </motion.section>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            data-testid={testId}
        >
            <motion.div
                initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl w-full max-w-md flex flex-col"
                style={{ maxHeight: 'min(80dvh, 40rem)' }}
            >
                {body}
            </motion.div>
        </motion.div>
    );
};

export default Modal;
