import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { motion } from 'framer-motion';

interface ChatProps {
    chat: ChatMessage[];
    myPlayerId: number;
    onSend: (text: string) => void;
    onClose: () => void;
}

/** Server caps messages at 300 chars; mirror it so the limit is visible. */
const MAX_LEN = 300;

const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const Chat: React.FC<ChatProps> = ({ chat, myPlayerId, onSend, onClose }) => {
    const [draft, setDraft] = useState('');
    const endRef = useRef<HTMLDivElement>(null);

    // Stick to the newest message as it arrives.
    useEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
    }, [chat.length]);

    const submit = () => {
        const text = draft.trim();
        if (!text) return;
        onSend(text);
        setDraft('');
    };

    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            data-testid="chat-panel"
        >
            <motion.div
                initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl w-full max-w-md flex flex-col"
                style={{ maxHeight: 'min(80dvh, 40rem)' }}
            >
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 flex-shrink-0">
                    <h2 className="t-body font-black uppercase tracking-widest text-slate-300">Chat</h2>
                    <button onClick={onClose} className="t-micro bg-slate-700 hover:bg-slate-600 font-black px-3 py-1.5 rounded-full border border-slate-600 uppercase">Close</button>
                </div>

                <div className="overflow-y-auto px-4 py-3 flex flex-col gap-2 flex-1">
                    {chat.length === 0 ? (
                        <p className="t-label text-slate-500 text-center py-6">No messages yet.</p>
                    ) : (
                        chat.map((m, i) => {
                            const mine = m.seat === myPlayerId;
                            return (
                                <div key={`${m.at}-${m.seat}-${i}`} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                                    <div className="flex items-baseline gap-2">
                                        <span className={`t-micro font-black uppercase tracking-widest ${mine ? 'text-blue-300' : 'text-slate-400'}`}>
                                            {m.name || `Seat ${m.seat + 1}`}
                                        </span>
                                        <span className="t-micro text-slate-600">{time(m.at)}</span>
                                    </div>
                                    <div className={`t-label rounded-2xl px-3 py-1.5 max-w-[85%] break-words ${mine ? 'bg-blue-600/80 text-white' : 'bg-slate-800 text-slate-200'}`}>
                                        {m.text}
                                    </div>
                                </div>
                            );
                        })
                    )}
                    <div ref={endRef} />
                </div>

                <div className="flex gap-2 px-4 py-3 border-t border-slate-700 flex-shrink-0">
                    <input
                        autoFocus
                        value={draft}
                        maxLength={MAX_LEN}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                        placeholder="Say something…"
                        aria-label="Chat message"
                        className="t-label flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-full px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                        onClick={submit}
                        disabled={!draft.trim()}
                        className="t-micro bg-blue-600 hover:bg-blue-500 disabled:opacity-30 font-black px-4 py-2 rounded-full border border-blue-800 uppercase"
                    >
                        Send
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default Chat;
