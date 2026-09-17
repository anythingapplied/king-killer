import React, { useState, useRef } from 'react';
import type { GameState, CombatEffect, RoomMember } from '../types';
import Card from '../Card';
import { motion, AnimatePresence } from 'framer-motion';

interface HUDProps {
    gameId: string;
    myPlayerId: number;
    gameState: GameState;
    roster: RoomMember[];
    isSpectator: boolean;
    copySuccess: boolean;
    activeEffects: CombatEffect[];
    reconnecting: boolean;
    onMenuClick: () => void;
    onCopyIdClick: () => void;
    onSoloJesterClick: () => void;
    onNewGameClick: () => void;
    onRename: (name: string) => void;
}

const HUD: React.FC<HUDProps> = ({ 
    myPlayerId, gameState, roster, isSpectator, copySuccess, activeEffects, reconnecting,
    onMenuClick, onCopyIdClick, onSoloJesterClick, onNewGameClick, onRename 
}) => {
    const isSolo = gameState.players.length === 1;
    const me = isSpectator ? undefined : gameState.players[myPlayerId];
    const mustRefreshSolo = isSolo && !!me && me.hand.length === 0 && gameState.solo_jesters > 0;
    const isMyTurn = gameState.current_player_index === myPlayerId;
    const watching = roster.filter(m => m.seat >= gameState.players.length);

    const [editingName, setEditingName] = useState(false);
    const [draftName, setDraftName] = useState('');
    const nameCancelledRef = useRef(false);

    const displayMyName = me?.name || roster.find(m => m.seat === myPlayerId)?.name || `${isSpectator ? 'Spectator' : 'Player'} ${myPlayerId + 1}`;

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

    const currentTierEnemies = gameState.active_enemy ? 
        gameState.castle_deck.filter(c => JSON.stringify(c.rank) === JSON.stringify(gameState.active_enemy?.card.rank))
        : [];

    return (
        <div data-testid="hud" className="z-[100] bg-slate-800/90 p-2 rounded-xl shadow-2xl border border-slate-700/50 backdrop-blur-md relative max-w-2xl mx-auto w-full flex-shrink-0">
            <div className="flex justify-between items-center px-1 mb-1">
                <div className="flex gap-1">
                    <button onClick={onMenuClick} className="bg-slate-700 text-[8px] font-black px-3 py-1 rounded-full border border-slate-600 shadow uppercase hover:bg-slate-600">Menu</button>
                    <button onClick={onNewGameClick} className="bg-amber-700 text-[8px] font-black px-3 py-1 rounded-full border border-amber-600 shadow uppercase hover:bg-amber-600" title="Start a new game in this room">New</button>
                </div>
                {editingName ? (
                    <input
                        autoFocus
                        maxLength={20}
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onBlur={submitName}
                        onKeyDown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') cancelName(); }}
                        className="bg-blue-500 text-[9px] font-black px-4 py-1 rounded-full border-2 border-slate-900 shadow-xl tracking-widest whitespace-nowrap w-32 text-center outline-none"
                        aria-label="Your name"
                    />
                ) : (
                    <button onClick={startEditName} title="Click to change your name" className="bg-blue-600 text-[9px] font-black px-4 py-1 rounded-full border-2 border-slate-900 shadow-xl tracking-widest whitespace-nowrap hover:bg-blue-500 transition-colors cursor-pointer">
                        {isSpectator ? '👁 ' : ''}{displayMyName}
                    </button>
                )}
                <button onClick={onCopyIdClick} className={`flex items-center gap-1 px-3 py-1 rounded-full border text-[8px] font-mono transition-all ${copySuccess ? 'bg-green-900/40 border-green-500 text-green-300' : 'bg-slate-950 border-slate-800'}`}>
                    {copySuccess ? 'Copied!' : `🔗 Share`}
                </button>
                {reconnecting && (
                    <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 animate-pulse" data-testid="reconnecting-indicator">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                        <span className="text-[8px] font-black uppercase tracking-widest text-amber-300">Reconnecting…</span>
                    </div>
                )}
            </div>

            <div className="flex justify-between items-center mb-1 px-2">
                <div className="text-center w-16 relative" data-testid="tavern-slot">
                    <div className="text-[7px] uppercase tracking-wider text-green-400 font-black">Tavern</div>
                    <div className="text-lg font-black leading-none">🍺 {gameState.tavern_deck.length}</div>
                    <AnimatePresence>
                        {activeEffects.filter(e => e.type === 'heal').map(e => (
                            <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -30, opacity: 0 }} exit={{ opacity: 0 }} className="absolute inset-x-0 -top-4 text-xs text-green-400 font-black">{e.value}</motion.span>
                        ))}
                    </AnimatePresence>
                </div>

                <div className="text-center flex-1 mx-4">
                    <div className="text-[7px] uppercase tracking-wider text-red-400 font-black mb-0.5">Tier</div>
                    <div className="flex justify-center gap-1.5 h-11">
                        {currentTierEnemies.map((c) => <Card key={c.id} card={c} className="w-8 h-11 border border-slate-600 shadow-lg" />)}
                    </div>
                </div>

                <div className="text-center w-16 relative" data-testid="discard-slot">
                    <div className="text-[7px] uppercase tracking-wider text-slate-400 font-black">Discard</div>
                    <div className="text-xl font-black leading-none">🗑️ {gameState.discard_pile.length}</div>
                </div>
            </div>

            {isSolo && gameState.solo_jesters > 0 && (
                <div className="flex justify-center gap-4 py-1 border-t border-slate-700/20">
                    {[...Array(2)].map((_, i) => (
                        <button key={i} disabled={!isMyTurn} onClick={onSoloJesterClick} className={`w-7 h-9 rounded border flex items-center justify-center text-sm transition-all ${i < gameState.solo_jesters ? `border-purple-500 bg-purple-900/40 shadow-lg ${mustRefreshSolo ? 'animate-bounce border-purple-400' : ''}` : 'border-slate-800 bg-slate-900 opacity-20 grayscale cursor-not-allowed'}`}>🃏</button>
                    ))}
                </div>
            )}

            <div className="flex gap-2 justify-center flex-wrap border-t border-slate-700/30 pt-1.5">
                {gameState.players.map((p, i) => {
                    const displayName = p.name || `P${i + 1}`;
                    return (
                        <div key={i} className={`px-2 py-0.5 rounded-full text-[8px] font-black border transition-all flex items-center gap-1 relative ${gameState.current_player_index === i ? 'bg-blue-600 border-blue-400 shadow-lg scale-105' : 'bg-slate-900/50 border-slate-700 opacity-50'}`}>
                            {myPlayerId === i && <span className="w-1 h-1 bg-green-400 rounded-full animate-pulse"></span>} {displayName}: {p.hand.length}
                            <AnimatePresence>
                                {activeEffects.filter(e => e.type === 'draw' && (gameState.current_player_index + gameState.players.length) % gameState.players.length === i).map(e => (
                                    <motion.span key={e.id} initial={{ y: 0, opacity: 1 }} animate={{ y: -20, opacity: 0 }} exit={{ opacity: 0 }} className="absolute inset-x-0 -top-4 text-[10px] text-blue-400 font-black text-center">{e.value}</motion.span>
                                ))}
                            </AnimatePresence>
                        </div>
                    );
                })}
            </div>

            {watching.length > 0 && (
                <div data-testid="watching-row" className="flex gap-1.5 justify-center flex-wrap items-center border-t border-slate-700/30 pt-1.5 mt-1.5">
                    <span className="text-[7px] font-black uppercase tracking-widest text-slate-500">Watching</span>
                    {watching.map(m => {
                        const isMe = m.seat === myPlayerId;
                        return (
                            <span key={m.seat} className={`px-2 py-0.5 rounded-full text-[8px] font-black border ${isMe ? 'border-amber-400 bg-amber-900/40 text-amber-200' : 'bg-slate-900/40 border-slate-700 text-slate-400'}`}>
                                {m.name || (isMe ? 'You' : `Spectator ${m.seat - gameState.players.length + 1}`)}
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default HUD;
