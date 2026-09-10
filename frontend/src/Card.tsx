import React from 'react';
import type { Card as CardType } from './types';
import { motion } from 'framer-motion';

interface CardProps {
    card?: CardType;
    isBack?: boolean;
    isEmpty?: boolean;
    onClick?: () => void;
    selected?: boolean;
    className?: string;
    layoutId?: string;
}

export const getCardFileName = (card: CardType): string => {
    if (card.rank === 'Joker') {
        return 'Joker.svg'; 
    }

    let rankStr = '';
    if (typeof card.rank === 'object') {
        rankStr = card.rank.Number.toString();
    } else {
        switch (card.rank) {
            case 'Ace': rankStr = 'A'; break;
            case 'Jack': rankStr = 'J'; break;
            case 'Queen': rankStr = 'Q'; break;
            case 'King': rankStr = 'K'; break;
        }
    }

    const suitStr = card.suit ? card.suit[0] : ''; // H, D, C, S
    
    return `${rankStr}${suitStr}.svg`;
};

const Card: React.FC<CardProps> = ({ card, isBack, isEmpty, onClick, selected, className, layoutId }) => {
    if (isEmpty) {
        return (
            <div className={`aspect-[5/7] border-2 border-slate-800/30 bg-slate-950/20 flex-shrink-0 ${className}`} />
        );
    }

    const fileName = isBack ? 'RED_BACK.svg' : (card ? getCardFileName(card) : 'RED_BACK.svg');
    const src = `/cards/${fileName}`;

    return (
        <motion.div 
            layoutId={layoutId}
            onClick={onClick}
            // Standardize rising levels
            animate={{ 
                y: selected ? -24 : 0,
                scale: 1,
                opacity: 1
            }}
            whileHover={onClick && !selected ? { y: -8 } : {}}
            whileTap={onClick ? { scale: 0.95 } : {}}
            // Selection should be instant, no "normal delay" getting there
            transition={selected ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 20 }}
            className={`transition-shadow aspect-[5/7] flex-shrink-0
                ${selected ? 'ring-4 ring-blue-500 shadow-[0_40px_60px_-10px_rgba(59,130,246,0.5)] z-50' : 'shadow-md'} 
                ${onClick ? 'cursor-pointer' : ''}
                ${className}`}
        >
            <img 
                src={src} 
                alt={isBack ? 'Card Back' : fileName} 
                className="w-full h-full object-contain"
                draggable={false}
            />
        </motion.div>
    );
};

export default Card;
