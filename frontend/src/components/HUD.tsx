import React, { useState, useRef } from 'react';
import type { GameState, CombatEffect, RoomMember } from '../types';
import Card from '../Card';
import { motion, AnimatePresence } from 'framer-motion';
import { spectatorNumber } from '../spectatorLabel';
import { NO_AUTOFILL } from '../noAutofill';

interface HUDProps {
    gameId: string;
    /** null when this connection holds no seat (an observer). */
    myPlayerId: number | null;
    gameState: GameState;
    roster: RoomMember[];
    isSpectator: boolean;
    copySuccess: boolean;
    activeEffects: CombatEffect[];
    reconnecting: boolean;
    muted: boolean;
    currentTierEnemies: GameState['castle_deck'];
    onMenuClick: () => void;
    onToggleMute: () => void;
    onLogClick: () => void;
    onChatClick: () => void;
    unreadChat: number;
    onCopyIdClick: () => void;
    onSoloJesterClick: () => void;
    /** Only the room's host may start a new deal; the server enforces this
     *  independently, so this just keeps the button honest about what it can
     *  actually do rather than firing a request that gets silently dropped. */
    isHost: boolean;
    onNewGameClick: () => void;
    onRename: (name: string) => void;
}

/** Solo play always starts with two Jesters, so the row always shows two slots. */
const SOLO_JESTER_SLOTS = 2;

const HUD: React.FC<HUDProps> = ({ 
    myPlayerId, gameState, roster, isSpectator, copySuccess, activeEffects, reconnecting, currentTierEnemies, muted, isHost, unreadChat,
    onMenuClick, onToggleMute, onLogClick, onChatClick, onCopyIdClick, onSoloJesterClick, onNewGameClick, onRename 
}) => {
    const isSolo = gameState.players.length === 1;
    const me = isSpectator || myPlayerId === null ? undefined : gameState.players[myPlayerId];
    const mustRefreshSolo = isSolo && !!me && me.hand.length === 0 && gameState.solo_jesters > 0;
    const isMyTurn = gameState.current_player_index === myPlayerId;
    // Spectator seats continue the player numbering - the first watcher in a
    // 2-player game is seat 2 - so rendering a raw seat reads as "Spectator 3".
    // Number them by position among the watchers instead. That also stays
    // correct when a re-deal changes the player count and shifts who is
    // watching, which arithmetic on seat numbers only happens to get right
    // while seats stay contiguous.
    const watching = roster
        .filter(m => m.seat >= gameState.players.length)
        .sort((a, b) => a.seat - b.seat);
    const spectatorLabel = (seat: number) => spectatorNumber(seat, roster, gameState.players.length);

    const [editingName, setEditingName] = useState(false);
    const [draftName, setDraftName] = useState('');
    const nameCancelledRef = useRef(false);

    const fallbackMyName = isSpectator
        ? (myPlayerId === null ? 'Watching' : `Spectator ${spectatorLabel(myPlayerId)}`)
        : `Player ${(myPlayerId ?? 0) + 1}`;
    const displayMyName = me?.name || roster.find(m => m.seat === myPlayerId)?.name || fallbackMyName;

    const startEditName = () => {
        setDraftName(me?.name || roster.find(m => m.seat === myPlayerId)?.name || '');
        setEditingName(true);
        nameCancelledRef.current = false;
    };
    const submitName = () => {
        if (nameCancelledRef.current) return; // Enter or Escape already settled it
        nameCancelledRef.current = true; // the input unmount blur must not re-fire
        setEditingName(false);
        const name = draftName.trim();
        if (name && name !== displayMyName) onRename(name);
    };
    const cancelName = () => {
        nameCancelledRef.current = true;
        setEditingName(false);
    };

    return (
        <div data-testid="hud" className="z-[100] bg-slate-800/90 p-1.5 sm:p-2 rounded-xl shadow-2xl border border-slate-700/50 backdrop-blur-md relative max-w-2xl mx-auto w-full flex-shrink-0">
            <div className="flex justify-between items-center gap-1 px-1 mb-1">
                <div className="flex gap-1 flex-shrink-0">
                    <button onClick={onMenuClick} title="Leave this room and return to the main menu" className="t-micro bg-slate-700 font-black px-2 sm:px-3 py-1 rounded-full border border-slate-600 shadow uppercase hover:bg-slate-600">Exit</button>
                    {isHost && (
                        <button onClick={onNewGameClick} className="t-micro bg-amber-700 font-black px-2 sm:px-3 py-1 rounded-full border border-amber-600 shadow uppercase hover:bg-amber-600" title="Start a new game in this room">New</button>
                    )}
                    <button onClick={onLogClick} title="Show the game log" aria-label="Show the game log" data-testid="log-toggle" className="t-micro bg-slate-700 font-black px-2 py-1 rounded-full border border-slate-600 shadow hover:bg-slate-600 leading-none">📜</button>
                    <button onClick={onChatClick} title="Open chat" aria-label={unreadChat > 0 ? `Open chat, ${unreadChat} unread` : 'Open chat'} data-testid="chat-toggle" className="t-micro bg-slate-700 font-black px-2 py-1 rounded-full border border-slate-600 shadow hover:bg-slate-600 leading-none relative">
                        💬
                        {unreadChat > 0 && (
                            <span className="absolute -top-1 -right-1 bg-blue-500 text-white rounded-full min-w-4 h-4 px-1 flex items-center justify-center t-micro font-black border border-slate-900">
                                {unreadChat > 9 ? '9+' : unreadChat}
                            </span>
                        )}
                    </button>
                    {/* Solo never chimes (the turn comes straight back), so the
                        control would be dead weight on the tightest layout. */}
                    {!isSolo && (
                        <button
                            onClick={onToggleMute}
                            aria-pressed={muted}
                            aria-label={muted ? 'Turn the turn chime on' : 'Mute the turn chime'}
                            title={muted ? 'Turn chime muted — click to unmute' : 'Turn chime on — click to mute'}
                            data-testid="mute-toggle"
                            className="t-micro bg-slate-700 font-black px-2 py-1 rounded-full border border-slate-600 shadow hover:bg-slate-600 leading-none"
                        >
                            {muted ? '🔕' : '🔔'}
                        </button>
                    )}
                </div>
                {editingName ? (
                    <input
                        autoFocus
                        {...NO_AUTOFILL}
                        maxLength={20}
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onBlur={submitName}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') cancelName(); }}
                        className="t-label bg-blue-500 font-black px-3 sm:px-4 py-1 rounded-full border-2 border-slate-900 shadow-xl tracking-widest whitespace-nowrap min-w-0 w-28 sm:w-32 text-center outline-none"
                        aria-label="Your name"
                    />
                ) : (
                    <button onClick={startEditName} title="Click to change your name" className="t-label bg-blue-600 font-black px-3 sm:px-4 py-1 rounded-full border-2 border-slate-900 shadow-xl tracking-widest whitespace-nowrap truncate min-w-0 hover:bg-blue-500 transition-colors cursor-pointer">
                        {isSpectator ? '👁 ' : ''}{displayMyName}
                    </button>
                )}
                <button onClick={onCopyIdClick} className={`t-micro flex items-center gap-1 px-2 sm:px-3 py-1 rounded-full border font-mono whitespace-nowrap flex-shrink-0 transition-all ${copySuccess ? 'bg-green-900/40 border-green-500 text-green-300' : 'bg-slate-950 border-slate-800'}`}>
                    {copySuccess ? 'Copied!' : `🔗 Share`}
                </button>
                {reconnecting && (
                    <div className="flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 animate-pulse flex-shrink-0" data-testid="reconnecting-indicator">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                        <span className="t-micro font-black uppercase tracking-widest text-amber-300 hidden sm:inline">Reconnecting…</span>
                    </div>
                )}
            </div>

            <div className="flex justify-between items-center mb-1 px-1 sm:px-2 gap-2">
                <div className="text-center w-12 sm:w-16 relative flex-shrink-0" data-testid="tavern-slot">
                    <div className="t-micro uppercase tracking-wider text-green-400 font-black">Tavern</div>
                    <div className="t-body font-black leading-none whitespace-nowrap">🍺 {gameState.tavern_deck.length}</div>
                    <AnimatePresence>
                        {activeEffects.filter(e => e.type === 'heal').map(e => (
                            <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -30, opacity: 0 }} exit={{ opacity: 0 }} className="t-label absolute inset-x-0 -top-4 text-green-400 font-black">{e.value}</motion.span>
                        ))}
                    </AnimatePresence>
                </div>

                <div className="text-center flex-1 min-w-0">
                    <div className="t-micro uppercase tracking-wider text-red-400 font-black mb-0.5">Tier</div>
                    <div className="flex justify-center gap-1 sm:gap-1.5 items-end" style={{ minHeight: 'calc(var(--thumb-w) * 7 / 5)' }}>
                        {currentTierEnemies.map((c) => <Card key={c.id} card={c} className="thumb-card border border-slate-600 shadow-lg" />)}
                    </div>
                </div>

                <div className="text-center w-12 sm:w-16 relative flex-shrink-0" data-testid="discard-slot">
                    <div className="t-micro uppercase tracking-wider text-slate-400 font-black">Discard</div>
                    <div className="t-body font-black leading-none whitespace-nowrap">🗑️ {gameState.discard_pile.length}</div>
                </div>
            </div>

            {isSolo && gameState.solo_jesters > 0 && (
                <div className="flex justify-center gap-4 py-1 border-t border-slate-700/20">
                    {[...Array(SOLO_JESTER_SLOTS)].map((_, i) => {
                        const available = i < gameState.solo_jesters;
                        return (
                            <button
                                key={i}
                                // A spent Jester looked disabled but was still clickable.
                                disabled={!isMyTurn || !available}
                                onClick={onSoloJesterClick}
                                aria-label={available ? 'Discard your hand and refill' : 'Jester already used'}
                                className={`w-6 h-8 sm:w-7 sm:h-9 rounded border flex items-center justify-center t-body transition-all ${available ? `border-purple-500 bg-purple-900/40 shadow-lg ${mustRefreshSolo ? 'animate-bounce border-purple-400' : ''}` : 'border-slate-800 bg-slate-900 opacity-20 grayscale cursor-not-allowed'}`}
                            >
                                🃏
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="flex gap-1.5 sm:gap-2 justify-center flex-wrap border-t border-slate-700/30 pt-1.5">
                {gameState.players.map((p, i) => {
                    const displayName = p.name || `P${i + 1}`;
                    // Diamonds draw starts with the current player, so that's
                    // where the +N floats. (This used to compute the current
                    // index the long way round and compare it to itself.)
                    const isDrawer = gameState.current_player_index === i;
                    return (
                        <div key={i} className={`t-label px-2 py-0.5 rounded-full font-black border transition-all flex items-center gap-1 relative max-w-[8rem] ${gameState.current_player_index === i ? 'bg-blue-600 border-blue-400 shadow-lg scale-105' : 'bg-slate-900/50 border-slate-700 opacity-50'}`}>
                            {myPlayerId === i && <span className="w-1 h-1 bg-green-400 rounded-full animate-pulse flex-shrink-0"></span>}
                            <span className="truncate">{displayName}</span>: {p.hand.length}
                            <AnimatePresence>
                                {isDrawer && activeEffects.filter(e => e.type === 'draw').map(e => (
                                    <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -20, opacity: 0 }} exit={{ opacity: 0 }} className="t-label absolute inset-x-0 -top-4 text-blue-400 font-black text-center">{e.value}</motion.span>
                                ))}
                            </AnimatePresence>
                        </div>
                    );
                })}
            </div>

            {watching.length > 0 && (
                <div data-testid="watching-row" className="flex gap-1.5 justify-center flex-wrap items-center border-t border-slate-700/30 pt-1.5 mt-1.5">
                    <span className="t-micro font-black uppercase tracking-widest text-slate-500">Watching</span>
                    {watching.map(m => {
                        const isMe = m.seat === myPlayerId;
                        return (
                            <span key={m.seat} className={`px-2 py-0.5 rounded-full t-micro font-black border ${isMe ? 'border-amber-400 bg-amber-900/40 text-amber-200' : 'bg-slate-900/40 border-slate-700 text-slate-400'}`}>
                                {m.name || (isMe ? 'You' : `Spectator ${spectatorLabel(m.seat)}`)}
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default HUD;
