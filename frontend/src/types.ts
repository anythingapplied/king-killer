export type Suit = 'Hearts' | 'Diamonds' | 'Clubs' | 'Spades';
export type SuitType = Suit;

export type Rank = 
    | { Number: number }
    | 'Ace'
    | 'Jack'
    | 'Queen'
    | 'King'
    | 'Joker';

export type RankType = Rank;

export interface Card {
    suit: Suit | null;
    rank: Rank;
    id: number;
}

export interface CombatEffect {
    id: number;
    suit: Suit;
    value: number | string;
    type: 'damage' | 'shield' | 'heal' | 'draw';
}

export interface Enemy {
    card: Card;
    current_health: number;
    max_health: number;
    base_attack: number;
    is_jester_active: boolean;
}

export interface Player {
    id: number;
    hand: Card[];
}

export type TurnPhase = 
    | 'AwaitingPlay'
    | { AwaitingDiscard: { damage_to_take: number } };

export type GameStatus = 
    | 'InProgress'
    | 'Won'
    | { Lost: string };

export interface GameState {
    players: Player[];
    current_player_index: number;
    tavern_deck: Card[];
    castle_deck: Card[];
    discard_pile: Card[];
    played_cards: Card[];
    last_played: Card[] | null;
    last_discarded: Card[] | null;
    active_enemy: Enemy | null;
    status: GameStatus;
    shield_value: number;
    phase: TurnPhase;
    solo_jesters: number;
    max_hand_size: number;
}

export type GameAction = 
    | { type: 'PlayCards', payload: { indices: number[] } }
    | { type: 'Yield' }
    | { type: 'DiscardCards', payload: { indices: number[] } }
    | { type: 'UseSoloJester' }
    | { type: 'Reset' };
