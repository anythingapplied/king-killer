import React, { useState, useEffect } from 'react';
import { useGameLogic, type DefeatFlight } from './hooks/useGameLogic';
import HUD from './components/HUD';
import Arena from './components/Arena';
import HandArea from './components/HandArea';
import ActionFooter from './components/ActionFooter';
import Card from './Card';
import { motion, AnimatePresence } from 'framer-motion';

// Flies the defeated enemy card from its board rect to the tavern/discard pile
// rect as a plain full-screen overlay (fixed positioning, pointer-transparent).
// Deliberately NOT a layoutId project: framer-motion 12 does not animate
// layoutId handoffs between separate DOM subtrees, so we animate coordinates
// deterministically instead.
const FlightOverlay: React.FC<{ flight: DefeatFlight; onDone: () => void }> = ({ flight, onDone }) => {
    if (!flight.flying || !flight.from || !flight.to) return null;
    return (
        <motion.div
            initial={{ left: flight.from.x, top: flight.from.y, width: flight.from.width, height: flight.from.height, opacity: 1 }}
            animate={{ left: flight.to.x, top: flight.to.y, width: flight.to.width, height: flight.to.height, opacity: 1 }}
            transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
            onAnimationComplete={onDone}
            className="fixed z-[150] pointer-events-none"
            style={{ willChange: 'left, top, width, height' }}
            data-testid="flight-overlay"
        >
            <Card card={flight.card} className="w-full h-full shadow-2xl" />
        </motion.div>
    );
};

const App: React.FC = () => {
    const {
        gameId, myPlayerId, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
        defeatFlight, finishDefeatFlight, reconnecting,
        sortedHand, currentDiscardValue, damageNeeded, isMyTurn, isSolo, discardRemaining, isImmuneWarning,
        createGame, joinGame, sendAction, toggleCard, chooseNextPlayer, copyId, exitToMenu, restartTable, renamePlayer
    } = useGameLogic();

    const [playerName, setPlayerName] = useState(() => localStorage.getItem('kingkiller_player_name') || '');

    useEffect(() => {
        if (playerName) localStorage.setItem('kingkiller_player_name', playerName);
    }, [playerName]);

    if (!gameId) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white p-4 text-center overflow-hidden">
                <motion.h1 
                    initial={{ y: -50, opacity: 0 }} 
                    animate={{ y: 0, opacity: 1 }}
                    className="text-6xl font-black mb-12 italic uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-br from-blue-400 to-purple-600"
                >
                    KING KILLER
                </motion.h1>
                <div className="bg-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-md border border-slate-700">
                    <h2 className="text-xl font-bold mb-6 text-slate-300">New Game</h2>
                    <input 
                        type="text" 
                        placeholder="YOUR NAME" 
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-2xl py-3 px-4 text-center font-bold focus:ring-2 focus:ring-blue-500 outline-none text-sm mb-6" 
                        maxLength={20}
                    />
                    <div className="grid grid-cols-2 gap-4 mb-10">
                        {[1, 2, 3, 4].map(n => (
                            <button key={n} onClick={() => createGame(n)} className="bg-blue-600 hover:bg-blue-500 text-white font-black py-5 rounded-2xl shadow-lg active:scale-95 transition-all text-lg">
                                {n} Player{n > 1 ? 's' : ''}
                            </button>
                        ))}
                    </div>
                    <div className="relative mb-6">
                        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-700"></div></div>
                        <div className="relative flex justify-center text-sm"><span className="px-3 bg-slate-800 text-slate-500 font-bold uppercase tracking-widest">or join room</span></div>
                    </div>
                    <input 
                        type="text" 
                        placeholder="PASTE GAME LINK" 
                        className="w-full bg-slate-900 border border-slate-700 rounded-2xl py-5 px-4 text-center font-mono focus:ring-2 focus:ring-blue-500 outline-none uppercase text-lg" 
                        onKeyDown={(e) => { if (e.key === 'Enter') joinGame(e.currentTarget.value.trim()); }} 
                    />
                </div>
            </div>
        );
    }

    if (!localGameState || myPlayerId === null) return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-white p-4">
            <div className="animate-pulse flex flex-col items-center">
                <div className="text-6xl mb-6">⚔️</div>
                <div className="text-sm font-black uppercase tracking-widest text-slate-500 text-center leading-loose">Entering the Castle...</div>
            </div>
        </div>
    );

    const isDiscarding = damageNeeded > 0;

    return (
        <div className="fixed inset-0 bg-slate-950 text-slate-100 grid grid-rows-[auto_1fr_auto] overflow-hidden max-w-6xl mx-auto font-sans">
            {/* HUD Row */}
            <HUD 
                gameId={gameId}
                myPlayerId={myPlayerId}
                gameState={localGameState}
                copySuccess={copySuccess}
                activeEffects={activeEffects}
                reconnecting={reconnecting}
                onMenuClick={exitToMenu}
                onCopyIdClick={copyId}
                onSoloJesterClick={() => sendAction({ type: 'UseSoloJester' })}
                onRename={renamePlayer}
            />

            {/* Arena Row */}
            <Arena 
                gameState={localGameState}
                activeEffects={activeEffects}
                isImmuneWarning={isImmuneWarning}
                isDiscarding={isDiscarding}
            />

            {/* Controls Row */}
            <div className="flex flex-col bg-slate-900/60 backdrop-blur-xl border-t border-white/5 z-[90]">
                <HandArea 
                    sortedHand={sortedHand}
                    maxHandSize={localGameState.max_hand_size}
                    isMyTurn={isMyTurn}
                    selectedIndices={selectedIndices}
                    damageNeeded={damageNeeded}
                    currentDiscardValue={currentDiscardValue}
                    phase={localGameState.phase}
                    enemySuit={localGameState.active_enemy?.card.suit || null}
                    isJesterActive={localGameState.active_enemy?.is_jester_active || false}
                    onCardClick={toggleCard}
                    actualHand={localGameState.players[myPlayerId].hand}
                    currentPlayerIndex={localGameState.current_player_index}
                    discardRemaining={discardRemaining}
                />

                <ActionFooter 
                    isMyTurn={isMyTurn}
                    selectedIndicesCount={selectedIndices.length}
                    damageNeeded={damageNeeded}
                    discardRemaining={discardRemaining}
                    currentDiscardValue={currentDiscardValue}
                    isSolo={isSolo}
                    isImmuneWarning={isImmuneWarning}
                    phase={localGameState.phase}
                    players={localGameState.players}
                    myPlayerId={myPlayerId}
                    onAttackClick={() => sendAction({ type: damageNeeded > 0 ? 'DiscardCards' : 'PlayCards', payload: { indices: selectedIndices } })}
                    onYieldClick={() => sendAction({ type: 'Yield' })}
                    onChooseNextPlayer={chooseNextPlayer}
                />
            </div>

            {/* Defeated enemy flying to its pile */}
            {defeatFlight && (
                <FlightOverlay flight={defeatFlight} onDone={() => finishDefeatFlight(defeatFlight.id)} />
            )}

            {/* Global Overlays */}
            <AnimatePresence>
                {localGameState.status !== 'InProgress' && showGameOver && (
                    <motion.div 
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-slate-950/80 flex items-center justify-center p-8 z-[200] backdrop-blur-sm text-center"
                    >
                        <motion.div 
                            initial={{ scale: 0.9, y: 50 }} animate={{ scale: 1, y: 0 }}
                            className="bg-slate-800/95 p-12 rounded-[3rem] shadow-[0_0_100px_rgba(0,0,0,0.8)] border border-slate-700 w-full max-w-sm relative"
                        >
                            <button onClick={() => setShowGameOver(false)} className="absolute -top-4 -right-4 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-black px-6 py-2.5 rounded-full border border-slate-600 shadow-xl uppercase">View Board</button>
                            <div className="text-8xl mb-8 animate-bounce">{localGameState.status === 'Won' ? '🏆' : '💀'}</div>
                            <h2 className="text-5xl font-black mb-4 tracking-tighter italic uppercase text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
                                {localGameState.status === 'Won' ? 'Victory' : 'Defeated'}
                            </h2>
                            {typeof localGameState.status === 'object' && 'Lost' in localGameState.status && (
                                <p className="text-slate-300 mb-10 font-bold bg-black/30 p-5 rounded-2xl text-sm leading-relaxed border border-white/5">
                                    {(localGameState.status as any).Lost}
                                </p>
                            )}
                            <button onClick={restartTable} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-6 rounded-[2rem] shadow-2xl transition-all active:scale-95 border-b-4 border-blue-800 uppercase tracking-widest text-xs mb-4">Play Again</button>
                            <button onClick={exitToMenu} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-black py-6 rounded-[2rem] shadow-2xl transition-all active:scale-95 border-b-4 border-slate-900 uppercase tracking-widest text-xs">Main Menu</button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {localGameState.status !== 'InProgress' && !showGameOver && (
                <motion.button 
                    initial={{ y: 100 }} animate={{ y: 0 }}
                    onClick={() => setShowGameOver(true)} 
                    className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white font-black px-10 py-5 rounded-full shadow-2xl z-[110] border-b-4 border-blue-800 uppercase text-xs tracking-widest animate-pulse"
                >
                    Show Result
                </motion.button>
            )}
        </div>
    );
};

export default App;
