import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ActionErrorToastProps {
    error: { id: number; action: string; message: string } | null;
    onDismiss: () => void;
}

/** Turns the server's internal action label into what the player attempted. */
const ACTION_LABEL: Record<string, string> = {
    play_cards: 'Play',
    discard_cards: 'Discard',
    yield: 'Yield',
    choose_next_player: 'Choice',
    use_solo_jester: 'Jester',
    new_game: 'New game',
    reset: 'Reset',
    set_name: 'Rename',
    send_chat: 'Chat',
};

/**
 * A rejected action, shown only to the player who attempted it and only
 * briefly — this is "that didn't work", not a persistent status.
 *
 * Most rejections are already prevented client-side (illegal combos are
 * greyed out, Yield disables itself when it would be refused), so this is the
 * edge case: races, a stale selection, or a client/server rule drifting apart.
 */
const ActionErrorToast: React.FC<ActionErrorToastProps> = ({ error, onDismiss }) => (
    <AnimatePresence>
        {error && (
            <motion.div
                key={error.id}
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                onClick={onDismiss}
                data-testid="action-error-toast"
                role="alert"
                className="fixed left-1/2 -translate-x-1/2 z-[190] max-w-[90vw] sm:max-w-sm cursor-pointer"
                style={{ bottom: 'calc(var(--safe-b) + 6.5rem)' }}
            >
                <div className="bg-red-950/95 backdrop-blur-md border border-red-700 rounded-2xl shadow-2xl px-4 py-2.5 flex items-start gap-2">
                    <span className="text-lg leading-none flex-shrink-0">⚠️</span>
                    <div className="min-w-0">
                        <div className="t-micro font-black uppercase tracking-widest text-red-300">
                            {ACTION_LABEL[error.action] ?? error.action} failed
                        </div>
                        <div className="t-label text-red-100 break-words">{error.message}</div>
                    </div>
                </div>
            </motion.div>
        )}
    </AnimatePresence>
);

export default ActionErrorToast;
