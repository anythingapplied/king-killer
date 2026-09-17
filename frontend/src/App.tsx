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
        gameId, myPlayerId, roster, localGameState, selectedIndices, copySuccess, showGameOver, setShowGameOver, activeEffects,
        defeatFlight, finishDefeatFlight, reconnecting, seatedPlayer, canYield, currentTierEnemies, muted, toggleMute, isSpectator,
        sortedHand, currentDiscardValue, damageNeeded, isMyTurn, isSolo, discardRemaining, isImmuneWarning,
        createGame, joinGame, sendAction, toggleCard, chooseNextPlayer, copyId, exitToMenu, restartTable, startNewGame, renamePlayer
    } = useGameLogic();

    const [playerName, setPlayerName] = useState(() => localStorage.getItem('kingkiller_player_name') || '');
    const [showNewGame, setShowNewGame] = useState(false);

    useEffect(() => {
        if (playerName) localStorage.setItem('kingkiller_player_name', playerName);
    }, [playerName]);

    if (!gameId) {
        return (
            <div className="board-shell flex flex-col items-center justify-center bg-slate-900 text-white p-4 text-center overflow-y-auto">
                <motion.h1 
                    initial={{ y: -50, opacity: 0 }} 
                    animate={{ y: 0, opacity: 1 }}
                    className="text-[clamp(2.25rem,11vw,4.5rem)] font-black mb-6 sm:mb-12 italic uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-br from-blue-400 to-purple-600"
                >
                    KING KILLER
                </motion.h1>
                <div className="bg-slate-800 p-5 sm:p-8 rounded-3xl shadow-2xl w-full max-w-md border border-slate-700">
                    <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 text-slate-300">New Game</h2>
                    <input 
                        type="text" 
                        placeholder="YOUR NAME" 
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-2xl py-3 px-4 text-center font-bold focus:ring-2 focus:ring-blue-500 outline-none t-body mb-4 sm:mb-6" 
                        maxLength={20}
                    />
                    <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-6 sm:mb-10">
                        {[1, 2, 3, 4].map(n => (
                            <button key={n} onClick={() => createGame(n)} className="bg-blue-600 hover:bg-blue-500 text-white font-black py-4 sm:py-5 rounded-2xl shadow-lg active:scale-95 transition-all text-base sm:text-lg">
                                {n} Player{n > 1 ? 's' : ''}
                            </button>
                        ))}
                    </div>
                    <div className="relative mb-4 sm:mb-6">
                        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-700"></div></div>
                        <div className="relative flex justify-center"><span className="t-label px-3 bg-slate-800 text-slate-500 font-bold uppercase tracking-widest">or join room</span></div>
                    </div>
                    <input 
                        type="text" 
                        placeholder="PASTE GAME LINK" 
                        className="w-full bg-slate-900 border border-slate-700 rounded-2xl py-4 sm:py-5 px-4 text-center font-mono focus:ring-2 focus:ring-blue-500 outline-none uppercase text-base sm:text-lg" 
                        onKeyDown={(e) => { if (e.key === 'Enter') joinGame(e.currentTarget.value.trim()); }} 
                    />
                </div>
            </div>
        );
    }

    // `seatedPlayer` is null while the state is still arriving AND whenever the
    // stored seat no longer exists on this table, which used to crash the board
    // on `players[myPlayerId].hand`.
    if (!localGameState || myPlayerId === null || (!isSpectator && !seatedPlayer)) return (
        <div className="board-shell flex flex-col items-center justify-center bg-slate-900 text-white p-4">
            <div className="animate-pulse flex flex-col items-center">
                <div className="text-6xl mb-6">⚔️</div>
                <div className="t-label font-black uppercase tracking-widest text-slate-500 text-center leading-loose">Entering the Castle...</div>
            </div>
        </div>
    );

    const isDiscarding = damageNeeded > 0;

    return (
        <div className="board-shell bg-slate-950 text-slate-100 grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden max-w-6xl mx-auto font-sans">
            {/* HUD Row */}
            <HUD 
                gameId={gameId}
                myPlayerId={myPlayerId}
                gameState={localGameState}
                roster={roster}
                isSpectator={isSpectator}
                copySuccess={copySuccess}
                activeEffects={activeEffects}
                reconnecting={reconnecting}
                currentTierEnemies={currentTierEnemies}
                muted={muted}
                onMenuClick={exitToMenu}
                onToggleMute={toggleMute}
                onCopyIdClick={copyId}
                onSoloJesterClick={() => sendAction({ type: 'UseSoloJester' })}
                onNewGameClick={() => setShowNewGame(true)}
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
                {isSpectator ? (
                    <div data-testid="spectator-bar" className="flex items-center justify-center gap-2 py-6 text-slate-400">
                        <span className="text-lg">👁</span>
                        <span className="t-micro font-black uppercase tracking-widest text-center px-4">You're watching — new games can be started from the HUD</span>
                    </div>
                ) : (
                    <>
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
                            actualHand={seatedPlayer?.hand ?? []}
                            currentPlayerIndex={localGameState.current_player_index}
                            discardRemaining={discardRemaining}
                            playerNames={localGameState.players.map(p => p.name)}
                        />

                        <ActionFooter 
                            isMyTurn={isMyTurn}
                            selectedIndicesCount={selectedIndices.length}
                            damageNeeded={damageNeeded}
                            discardRemaining={discardRemaining}
                            currentDiscardValue={currentDiscardValue}
                            isSolo={isSolo}
                            canYield={canYield}
                            isImmuneWarning={isImmuneWarning}
                            phase={localGameState.phase}
                            players={localGameState.players}
                            myPlayerId={myPlayerId}
                            onAttackClick={() => sendAction({ type: damageNeeded > 0 ? 'DiscardCards' : 'PlayCards', payload: { indices: selectedIndices } })}
                            onYieldClick={() => sendAction({ type: 'Yield' })}
                            onChooseNextPlayer={chooseNextPlayer}
                        />
                    </>
                )}
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
                        className="fixed inset-0 bg-slate-950/80 flex items-center justify-center p-5 sm:p-8 z-[200] backdrop-blur-sm text-center overflow-y-auto"
                    >
                        <motion.div 
                            initial={{ scale: 0.9, y: 50 }} animate={{ scale: 1, y: 0 }}
                            className="bg-slate-800/95 p-6 sm:p-12 rounded-[2rem] sm:rounded-[3rem] shadow-[0_0_100px_rgba(0,0,0,0.8)] border border-slate-700 w-full max-w-sm relative my-auto"
                        >
                            <button onClick={() => setShowGameOver(false)} className="t-micro absolute -top-3 -right-2 sm:-top-4 sm:-right-4 bg-slate-700 hover:bg-slate-600 text-white font-black px-4 sm:px-6 py-2 sm:py-2.5 rounded-full border border-slate-600 shadow-xl uppercase">View Board</button>
                            <div className="text-[clamp(3rem,16vw,5rem)] mb-4 sm:mb-8 animate-bounce leading-none">{localGameState.status === 'Won' ? '🏆' : '💀'}</div>
                            <h2 className="text-[clamp(2rem,10vw,3rem)] font-black mb-4 tracking-tighter italic uppercase text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
                                {localGameState.status === 'Won' ? 'Victory' : 'Defeated'}
                            </h2>
                            {typeof localGameState.status === 'object' && 'Lost' in localGameState.status && (
                                <p className="t-body text-slate-300 mb-6 sm:mb-10 font-bold bg-black/30 p-4 sm:p-5 rounded-2xl leading-relaxed border border-white/5">
                                    {localGameState.status.Lost}
                                </p>
                            )}
                            <button onClick={restartTable} className="t-label w-full bg-blue-600 hover:bg-blue-500 text-white font-black py-4 sm:py-6 rounded-[1.5rem] sm:rounded-[2rem] shadow-2xl transition-all active:scale-95 border-b-4 border-blue-800 uppercase tracking-widest mb-3 sm:mb-4">Play Again</button>
                            <button onClick={() => setShowNewGame(true)} className="t-label w-full bg-amber-600 hover:bg-amber-500 text-white font-black py-4 sm:py-6 rounded-[1.5rem] sm:rounded-[2rem] shadow-2xl transition-all active:scale-95 border-b-4 border-amber-800 uppercase tracking-widest mb-3 sm:mb-4">New Game</button>
                            <button onClick={exitToMenu} className="t-label w-full bg-slate-700 hover:bg-slate-600 text-white font-black py-4 sm:py-6 rounded-[1.5rem] sm:rounded-[2rem] shadow-2xl transition-all active:scale-95 border-b-4 border-slate-900 uppercase tracking-widest">Main Menu</button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* New Game player-count modal (available mid-game and from Game Over) */}
            <AnimatePresence>
                {showNewGame && (
                    <motion.div 
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-slate-950/80 flex items-center justify-center p-8 z-[210] backdrop-blur-sm text-center"
                    >
                        <motion.div 
                            initial={{ scale: 0.9, y: 50 }} animate={{ scale: 1, y: 0 }}
                            className="bg-slate-800/95 p-12 rounded-[3rem] shadow-[0_0_100px_rgba(0,0,0,0.8)] border border-slate-700 w-full max-w-sm relative"
                        >
                            <button onClick={() => setShowNewGame(false)} className="absolute -top-4 -right-4 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-black px-6 py-2.5 rounded-full border border-slate-600 shadow-xl uppercase">Close</button>
                            <h2 className="text-3xl font-black mb-2 tracking-tighter italic uppercase text-transparent bg-clip-text bg-gradient-to-b from-amber-300 to-amber-600">New Game</h2>
                            <p className="text-slate-400 text-xs font-bold mb-8 leading-relaxed">Deal a fresh game in this room. Everyone keeps their seats; extra members watch.</p>
                            <div className="grid grid-cols-2 gap-4">
                                {[1, 2, 3, 4].map(n => (
                                    <button key={n} onClick={() => { setShowNewGame(false); startNewGame(n); }} data-testid={`new-game-${n}`} className="bg-blue-600 hover:bg-blue-500 text-white font-black py-6 rounded-2xl shadow-lg active:scale-95 transition-all text-lg">
                                        {n} Player{n > 1 ? 's' : ''}
                                    </button>
                                ))}
                            </div>
                            <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mt-8">Room ID: {gameId}</p>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {localGameState.status !== 'InProgress' && !showGameOver && (
                <motion.button 
                    initial={{ y: 100 }} animate={{ y: 0 }}
                    onClick={() => setShowGameOver(true)} 
                    className="t-label fixed left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white font-black px-8 sm:px-10 py-4 sm:py-5 rounded-full shadow-2xl z-[110] border-b-4 border-blue-800 uppercase tracking-widest animate-pulse"
                    style={{ bottom: 'calc(var(--safe-b) + 3rem)' }}
                >
                    Show Result
                </motion.button>
            )}
        </div>
    );
};

export default App;
