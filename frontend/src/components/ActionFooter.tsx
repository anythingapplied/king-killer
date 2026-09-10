import React from 'react';

interface ActionFooterProps {
    isMyTurn: boolean;
    selectedIndicesCount: number;
    damageNeeded: number;
    discardRemaining: number;
    currentDiscardValue: number;
    isSolo: boolean;
    isImmuneWarning: boolean;
    onAttackClick: () => void;
    onYieldClick: () => void;
}

const ActionFooter: React.FC<ActionFooterProps> = ({
    isMyTurn, selectedIndicesCount, damageNeeded,
    currentDiscardValue, isSolo, isImmuneWarning, onAttackClick, onYieldClick
}) => {
    const isDiscarding = damageNeeded > 0;
    const showWarning = isImmuneWarning && !isDiscarding;

    return (
        <div className="flex-shrink-0 flex flex-col gap-2 pb-4 pt-1 bg-slate-900/80 backdrop-blur-md z-[100]">
            <div className="grid grid-cols-2 gap-4 max-w-md mx-auto w-full px-4 pb-1">
                {damageNeeded === 0 ? (
                    <>
                        <button 
                            disabled={!isMyTurn || selectedIndicesCount === 0} 
                            onClick={onAttackClick} 
                            className={`${isSolo ? 'col-span-2' : ''} bg-blue-600 border-blue-800 relative disabled:opacity-20 hover:brightness-110 text-white font-black py-3.5 rounded-2xl shadow-xl transition-all active:translate-y-1 border-b-4 uppercase text-[10px] tracking-widest`}
                        >
                            Attack
                            {showWarning && (
                                <span className="absolute -top-3 -right-3 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm font-black border-2 border-white shadow-xl animate-bounce">
                                    !
                                </span>
                            )}
                        </button>
                        {!isSolo && (
                            <button 
                                disabled={!isMyTurn} 
                                onClick={onYieldClick} 
                                className="bg-slate-700 border-slate-900 disabled:opacity-20 hover:bg-slate-600 text-white font-black py-3.5 rounded-2xl shadow-xl transition-all active:translate-y-1 border-b-4 uppercase text-[10px] tracking-widest"
                            >
                                Yield
                            </button>
                        )}
                    </>
                ) : (
                    <button 
                        disabled={!isMyTurn || currentDiscardValue < damageNeeded} 
                        onClick={onAttackClick} 
                        className="col-span-2 bg-red-600 border-red-800 disabled:opacity-20 hover:bg-red-500 text-white font-black py-3.5 rounded-2xl shadow-xl transition-all active:translate-y-1 border-b-4 uppercase text-[10px] tracking-widest text-center"
                    >
                        Confirm Discard
                    </button>
                )}
            </div>
        </div>
    );
};

export default ActionFooter;
