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

export type LogKind = 'Played' | 'Yielded' | 'Discarded' | 'Jester' | 'EnemyDefeated' | 'EnemyRevealed';

/** One event in the running game log. `player` is null for table events. */
export interface LogEntry {
    player: number | null;
    kind: LogKind;
    cards: Card[];
}

/** One turn's play against the current enemy. Empty `cards` means a yield. */
export interface PlayRecord {
    player: number;
    cards: Card[];
}

export interface Player {
    id: number;
    name: string;
    hand: Card[];
}

/** A person attached to a room. Seats below the active game's player count
 * are that game's players; seats at or above it are spectators watching. */
export interface RoomMember {
    seat: number;
    name: string;
}

/** The state broadcast by the server: the shared game plus the full room
 * roster so spectators are visible to everyone. */
export interface RoomSnapshot {
    id: string;
    game: GameState;
    members: RoomMember[];
}

export type TurnPhase = 
    | 'AwaitingPlay'
    | 'AwaitingNextPlayer'
    | { AwaitingDiscard: { damage_to_take: number } };

export type GameStatus = 
    | 'InProgress'
    | 'Won'
    | { Lost: string };

/** How the last defeated enemy card was resolved (serialized from the Rust enum). */
export type EnemyFate = 'Tavern' | 'Discard';

export interface GameState {
    version: number;
    seed: number;
    rng: { state: number };
    players: Player[];
    current_player_index: number;
    tavern_deck: Card[];
    castle_deck: Card[];
    discard_pile: Card[];
    played_cards: Card[];
    /** Each play against the current enemy, still grouped as it was played.
     *  Optional so a snapshot from an older server still type-checks. */
    play_log?: PlayRecord[];
    /** Whole-game history, oldest first. Optional for older snapshots. */
    game_log?: LogEntry[];
    last_played: Card[] | null;
    last_discarded: Card[] | null;
    active_enemy: Enemy | null;
    status: GameStatus;
    shield_value: number;
    phase: TurnPhase;
    solo_jesters: number;
    max_hand_size: number;
    last_enemy_fate: EnemyFate | null;
    /** Yields taken in a row since the last card was played. Optional so a
     *  snapshot written by an older server still type-checks. */
    consecutive_yields?: number;
}

export type GameAction = 
    | { type: 'PlayCards', payload: { indices: number[] } }
    | { type: 'Yield' }
    | { type: 'DiscardCards', payload: { indices: number[] } }
    | { type: 'ChooseNextPlayer', payload: { index: number } }
    | { type: 'UseSoloJester' }
    | { type: 'Reset' }
    | { type: 'NewGame', payload: { num_players: number } }
    | { type: 'SetName', payload: { seat: number, name: string } };
