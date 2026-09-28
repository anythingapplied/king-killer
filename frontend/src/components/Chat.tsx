import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import Modal from './Modal';
import { NO_AUTOFILL } from '../noAutofill';

interface ChatProps {
    chat: ChatMessage[];
    /** null for an observer, who owns none of the messages. */
    myPlayerId: number | null;
    onSend: (text: string) => void;
    onClose: () => void;
    /** Beside the board rather than over it; see Modal. */
    docked?: boolean;
}

/** Server caps messages at 300 chars; mirror it so the limit is visible. */
const MAX_LEN = 300;

const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const Chat: React.FC<ChatProps> = ({ chat, myPlayerId, onSend, onClose, docked }) => {
    const [draft, setDraft] = useState('');
    const endRef = useRef<HTMLDivElement>(null);

    // Stick to the newest message as it arrives. `nearest` scrolls only the
    // message list: `end` also scrolls every scrollable ancestor, which for a
    // docked panel means the page itself.
    useEffect(() => {
        endRef.current?.scrollIntoView({ block: 'nearest' });
    }, [chat.length]);

    const submit = () => {
        const text = draft.trim();
        if (!text) return;
        onSend(text);
        setDraft('');
    };

    return (
        <Modal
            title="Chat"
            onClose={onClose}
            testId="chat-panel"
            docked={docked}
            footer={
                <div className="flex gap-2 px-4 py-3 border-t border-slate-700 flex-shrink-0">
                    <input
                        autoFocus
                        {...NO_AUTOFILL}
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
            }
        >
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
        </Modal>
    );
};

export default Chat;
