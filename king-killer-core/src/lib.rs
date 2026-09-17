use serde::{Deserialize, Serialize};

/// Bump whenever game rules OR the deterministic RNG algorithm change.
/// History replay and snapshot migration key off this value.
pub const RULES_VERSION: u32 = 2;

/// Deterministic, portable PRNG for all game randomness (SplitMix64).
///
/// Pure 64-bit wrapping integer math, so output is identical on every
/// platform/toolchain for the same seed — required for replaying `game_history`
/// from a stored seed. It is intentionally NOT a CSPRNG (irrelevant for a card
/// game). Changing this algorithm MUST bump [`RULES_VERSION`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameRng {
    state: u64,
}

impl Default for GameRng {
    fn default() -> Self {
        Self::new(0)
    }
}

impl GameRng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform index in `0..=max`. Mod-bias is negligible for the deck sizes
    /// used here (< 2^-40) and determinism is what matters.
    fn next_index(&mut self, max: usize) -> usize {
        (self.next_u64() % (max as u64 + 1)) as usize
    }
}

/// Fisher–Yates shuffle using [`GameRng`].
fn shuffle<T>(slice: &mut [T], rng: &mut GameRng) {
    for i in (1..slice.len()).rev() {
        let j = rng.next_index(i);
        slice.swap(i, j);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Suit {
    Hearts,
    Diamonds,
    Clubs,
    Spades,
}

impl Suit {
    pub fn all() -> [Suit; 4] {
        [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Rank {
    Number(u8),
    Ace, // Animal Companion
    Jack,
    Queen,
    King,
    Joker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    pub suit: Option<Suit>,
    pub rank: Rank,
    pub id: u32,
}

impl Card {
    pub fn new(suit: Suit, rank: Rank, id: u32) -> Self {
        Self {
            suit: Some(suit),
            rank,
            id,
        }
    }

    pub fn joker(id: u32) -> Self {
        Self {
            suit: None,
            rank: Rank::Joker,
            id,
        }
    }

    pub fn attack_value(&self) -> u32 {
        match self.rank {
            Rank::Number(n) => n as u32,
            Rank::Ace => 1,
            Rank::Jack => 10,
            Rank::Queen => 15,
            Rank::King => 20,
            Rank::Joker => 0,
        }
    }

    pub fn health_value(&self) -> u32 {
        self.attack_value()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Enemy {
    pub card: Card,
    pub current_health: i32,
    pub max_health: i32,
    pub base_attack: i32,
    pub is_jester_active: bool, // Jester negates immunity
}

impl Enemy {
    pub fn new(card: Card) -> Self {
        let (health, attack) = match card.rank {
            Rank::Jack => (20, 10),
            Rank::Queen => (30, 15),
            Rank::King => (40, 20),
            _ => panic!("Invalid enemy rank"),
        };

        Self {
            card,
            current_health: health,
            max_health: health,
            base_attack: attack,
            is_jester_active: false,
        }
    }

    pub fn is_immune(&self, suit: Suit) -> bool {
        if self.is_jester_active {
            return false;
        }
        self.card.suit == Some(suit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Player {
    pub id: u32,
    pub name: String,
    pub hand: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum TurnPhase {
    AwaitingPlay,
    AwaitingDiscard { damage_to_take: i32 },
    /// A Jester was just played in a 3+ player game. Step 3 and 4 are skipped
    /// and the player who played the Jester picks who takes the next turn.
    AwaitingNextPlayer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameStatus {
    InProgress,
    Won,
    Lost(String), // Reason for loss
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EnemyFate {
    /// Damage exactly equal to the enemy's health: card goes to the Tavern deck.
    Tavern,
    /// Overkill: card goes to the Discard pile.
    Discard,
}

fn current_rules_version() -> u32 {
    RULES_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameState {
    /// Rules version that produced this state. Replay/migration gate on it.
    #[serde(default = "current_rules_version")]
    pub version: u32,
    /// Original seed for this deal. `GameRng::new(seed)` reproduces the deal.
    #[serde(default)]
    pub seed: u64,
    /// Live deterministic RNG state (advances with every random draw/shuffle).
    /// `#[serde(default)]` lets legacy snapshots (pre-seed) still load.
    #[serde(default)]
    pub rng: GameRng,
    pub players: Vec<Player>,
    pub current_player_index: usize,
    pub tavern_deck: Vec<Card>,
    pub castle_deck: Vec<Card>,
    pub discard_pile: Vec<Card>,
    pub played_cards: Vec<Card>, // Cards played against current enemy
    pub last_played: Option<Vec<Card>>,
    pub last_discarded: Option<Vec<Card>>,
    pub active_enemy: Option<Enemy>,
    pub status: GameStatus,
    pub shield_value: i32, // Spades accumulated against current enemy
    pub phase: TurnPhase,
    pub solo_jesters: u32,
    pub max_hand_size: usize,
    /// How the most recently defeated enemy card was resolved, used for
    /// client-side defeat animations. `None` until an enemy has been defeated.
    pub last_enemy_fate: Option<EnemyFate>,
}

impl GameState {
    /// Create a game deal with a fresh (random) seed.
    pub fn new(num_players: u32) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        // Mix wall-clock time with a per-process counter so seeds don't collide
        // even if games are created in the same nanosecond.
        let seed = nanos ^ counter.rotate_left(32) ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        Self::new_with_seed(seed, num_players)
    }

    /// Create a game deal from an explicit seed. Identical deals for identical
    /// seeds — the basis for replaying `game_history` from a stored seed.
    pub fn new_with_seed(seed: u64, num_players: u32) -> Self {
        let mut rng = GameRng::new(seed);
        let mut next_id = 1;

        // Create Castle Deck
        let mut kings: Vec<Card> = Suit::all()
            .iter()
            .map(|&s| {
                let c = Card::new(s, Rank::King, next_id);
                next_id += 1;
                c
            })
            .collect();
        shuffle(&mut kings, &mut rng);

        let mut queens: Vec<Card> = Suit::all()
            .iter()
            .map(|&s| {
                let c = Card::new(s, Rank::Queen, next_id);
                next_id += 1;
                c
            })
            .collect();
        shuffle(&mut queens, &mut rng);

        let mut jacks: Vec<Card> = Suit::all()
            .iter()
            .map(|&s| {
                let c = Card::new(s, Rank::Jack, next_id);
                next_id += 1;
                c
            })
            .collect();
        shuffle(&mut jacks, &mut rng);

        let mut castle_deck = Vec::new();
        castle_deck.extend(kings);
        castle_deck.extend(queens);
        castle_deck.extend(jacks);

        // Create Tavern Deck
        let mut tavern_deck = Vec::new();
        for &suit in &Suit::all() {
            for n in 2..=10 {
                 tavern_deck.push(Card::new(suit, Rank::Number(n), next_id));
                 next_id += 1;
            }
            tavern_deck.push(Card::new(suit, Rank::Ace, next_id));
            next_id += 1;
        }

        let (jesters, max_hand_size, solo_jesters) = match num_players {
            1 => (0, 8, 2),
            2 => (0, 7, 0),
            3 => (1, 6, 0),
            4 => (2, 5, 0),
            _ => panic!("Invalid number of players"),
        };

        for _ in 0..jesters {
            tavern_deck.push(Card::joker(next_id));
            next_id += 1;
        }
        shuffle(&mut tavern_deck, &mut rng);

        // Create Players
        let mut players = Vec::new();
        for i in 0..num_players {
            let mut hand = Vec::new();
            for _ in 0..max_hand_size {
                if let Some(card) = tavern_deck.pop() {
                    hand.push(card);
                }
            }
            players.push(Player { id: i, name: String::new(), hand });
        }

        let mut state = GameState {
            version: RULES_VERSION,
            seed,
            rng,
            players,
            current_player_index: 0,
            tavern_deck,
            castle_deck,
            discard_pile: Vec::new(),
            played_cards: Vec::new(),
            last_played: None,
            last_discarded: None,
            active_enemy: None,
            status: GameStatus::InProgress,
            shield_value: 0,
            phase: TurnPhase::AwaitingPlay,
            solo_jesters,
            max_hand_size,
            last_enemy_fate: None,
        };

        state.next_enemy();
        state
    }

    pub fn next_enemy(&mut self) {
        if let Some(card) = self.castle_deck.pop() {
            self.active_enemy = Some(Enemy::new(card));
            self.shield_value = 0;
            self.played_cards = Vec::new();
            self.phase = TurnPhase::AwaitingPlay;
        } else {
            self.status = GameStatus::Won;
        }
    }

    pub fn use_solo_jester(&mut self) -> Result<(), String> {
        if self.players.len() != 1 {
            return Err("Solo Jesters only available in single player".to_string());
        }
        if self.solo_jesters == 0 {
            return Err("No Jesters remaining".to_string());
        }
        
        // Jester can be used in AwaitingPlay OR at start of AwaitingDiscard
        // (Wait, rules say "[rules wording removed]" - 
        // that means before any cards are discarded).

        self.solo_jesters -= 1;
        let player = &mut self.players[0];
        
        // Discard hand
        self.discard_pile.extend(player.hand.drain(..));
        
        // Draw new FULL hand (8 cards for solo)
        for _ in 0..8 {
            if let Some(card) = self.tavern_deck.pop() {
                player.hand.push(card);
            }
        }

        // If we were in discard phase, we might now be able to satisfy damage.
        // We stay in current phase.
        self.check_solo_loss();
        Ok(())
    }

    pub fn play_cards(&mut self, card_indices: Vec<usize>) -> Result<(), String> {
        if let GameStatus::Lost(_) | GameStatus::Won = self.status {
            return Err("Game is already over".to_string());
        }

        if self.phase != TurnPhase::AwaitingPlay {
            return Err("Not currently in play phase".to_string());
        }

        let player = &mut self.players[self.current_player_index];
        let mut played_cards = Vec::new();

        let mut sorted_indices = card_indices.clone();
        sorted_indices.sort_unstable_by(|a, b| b.cmp(a));

        for idx in sorted_indices {
            if idx >= player.hand.len() {
                return Err("Invalid card index".to_string());
            }
            played_cards.push(player.hand.remove(idx));
        }

        if played_cards.is_empty() {
            return Err("No cards played".to_string());
        }

        if !self.is_valid_combo(&played_cards) {
            // Restore cards to hand if invalid
            let player = &mut self.players[self.current_player_index];
            player.hand.extend(played_cards);
            return Err("Invalid card combination".to_string());
        }

        if played_cards.len() == 1 && played_cards[0].rank == Rank::Joker {
            if let Some(ref mut enemy) = self.active_enemy {
                let formerly_immune_suit = enemy.card.suit;
                enemy.is_jester_active = true;

                // Retroactive powers for cards already on the table
                if let Some(suit) = formerly_immune_suit {
                    let cards_to_retrigger: Vec<Card> = self.played_cards.iter()
                        .filter(|c| c.suit == Some(suit))
                        .cloned()
                        .collect();
                    
                    if !cards_to_retrigger.is_empty() {
                        let attack_value = self.calculate_attack_value(&cards_to_retrigger);
                        self.apply_suit_powers(attack_value, &[suit]);
                    }
                }
            }
            self.last_played = Some(played_cards.clone());
            self.discard_pile.extend(played_cards);
            if self.players.len() > 2 {
                // The Jester's player chooses who takes the next turn. With only
                // two players there is no choice to make, so play just passes on.
                self.phase = TurnPhase::AwaitingNextPlayer;
            } else {
                self.current_player_index = (self.current_player_index + 1) % self.players.len();
            }
            return Ok(());
        }

        let attack_value = self.calculate_attack_value(&played_cards);
        let suits = self.get_active_suits(&played_cards);

        self.last_played = Some(played_cards.clone());
        self.apply_suit_powers(attack_value, &suits);

        let mut damage = attack_value;
        if suits.contains(&Suit::Clubs) && !self.is_enemy_immune(Suit::Clubs) {
            damage *= 2;
        }

        let enemy_defeated = if let Some(ref mut enemy) = self.active_enemy {
            enemy.current_health -= damage as i32;
            enemy.current_health <= 0
        } else {
            false
        };

        self.played_cards.extend(played_cards);

        if enemy_defeated {
            let enemy = self.active_enemy.take().unwrap();
            let exact_kill = enemy.current_health == 0;
            self.last_enemy_fate = Some(if exact_kill { EnemyFate::Tavern } else { EnemyFate::Discard });
            if exact_kill {
                self.tavern_deck.push(enemy.card);
            } else {
                self.discard_pile.push(enemy.card);
            }
            self.discard_pile.extend(self.played_cards.drain(..));
            self.next_enemy();
            self.check_solo_loss();
            return Ok(());
        }

        self.enter_discard_phase()
    }

    /// Resolve the choice opened by playing a Jester in a 3+ player game:
    /// choose any player (including the Jester's own player) to go next.
    pub fn choose_next_player(&mut self, index: usize) -> Result<(), String> {
        if self.phase != TurnPhase::AwaitingNextPlayer {
            return Err("Not awaiting a next-player choice".to_string());
        }
        if index >= self.players.len() {
            return Err("Invalid player index".to_string());
        }
        self.current_player_index = index;
        self.phase = TurnPhase::AwaitingPlay;
        Ok(())
    }

    pub fn yield_turn(&mut self) -> Result<(), String> {
        if self.phase != TurnPhase::AwaitingPlay {
            return Err("Can only yield during play phase".to_string());
        }
        
        // Single player cannot yield (Rules)
        if self.players.len() == 1 {
             return Err("Cannot yield in solo play".to_string());
        }

        self.enter_discard_phase()
    }

    fn enter_discard_phase(&mut self) -> Result<(), String> {
        let enemy_attack = if let Some(ref enemy) = self.active_enemy {
            (enemy.base_attack - self.shield_value).max(0)
        } else {
            0
        };

        if enemy_attack > 0 {
            self.phase = TurnPhase::AwaitingDiscard {
                damage_to_take: enemy_attack,
            };
            
            // Check for Loss: Can the player satisfy damage?
            // If they have Jesters, don't trigger loss yet! They might refresh.
            if self.solo_jesters == 0 {
                let player = &self.players[self.current_player_index];
                let total_hand_value: i32 = player.hand.iter().map(|c| {
                    match c.rank {
                        Rank::Ace => 1, Rank::Joker => 0, Rank::Jack => 10, Rank::Queen => 15, Rank::King => 20, Rank::Number(n) => n as i32,
                    }
                }).sum();

                if total_hand_value < enemy_attack {
                    self.status = GameStatus::Lost(format!("Cannot satisfy {} damage.", enemy_attack));
                }
            }
        } else {
            // No damage to take, move to next player
            self.current_player_index = (self.current_player_index + 1) % self.players.len();
            self.phase = TurnPhase::AwaitingPlay;
        }
        Ok(())
    }

    pub fn discard_cards(&mut self, card_indices: Vec<usize>) -> Result<(), String> {
        if let TurnPhase::AwaitingDiscard { damage_to_take } = self.phase {
            let player = &mut self.players[self.current_player_index];
            let mut discarded_cards = Vec::new();

            let mut sorted_indices = card_indices.clone();
            sorted_indices.sort_unstable_by(|a, b| b.cmp(a));

            for idx in sorted_indices {
                if idx >= player.hand.len() {
                    return Err("Invalid card index".to_string());
                }
                discarded_cards.push(player.hand.remove(idx));
            }

            let discard_value: i32 = discarded_cards.iter().map(|c| {
                match c.rank {
                    Rank::Ace => 1, Rank::Joker => 0, Rank::Jack => 10, Rank::Queen => 15, Rank::King => 20, Rank::Number(n) => n as i32,
                    }
            }).sum();
            
            if discard_value < damage_to_take {
                // Restore cards to hand if insufficient
                let player = &mut self.players[self.current_player_index];
                player.hand.extend(discarded_cards);
                return Err(format!("Insufficient discard value: {} < {}", discard_value, damage_to_take));
            } else {
                // Damage satisfied
                self.last_discarded = Some(discarded_cards.clone());
                self.discard_pile.extend(discarded_cards);
                self.current_player_index = (self.current_player_index + 1) % self.players.len();
                self.phase = TurnPhase::AwaitingPlay;
                self.check_solo_loss(); // Check if next player (if solo) is stuck
            }
            Ok(())
        } else {
            Err("Not in discard phase".to_string())
        }
    }

    fn check_solo_loss(&mut self) {
        if self.players.len() == 1 && self.status == GameStatus::InProgress {
            let player = &self.players[0];
            // If they have cards or Jesters, they aren't lost yet.
            if player.hand.is_empty() && self.solo_jesters == 0 {
                self.status = GameStatus::Lost("Out of cards and Jesters.".to_string());
            }
        }
    }

    fn is_valid_combo(&self, cards: &[Card]) -> bool {
        if cards.len() == 1 {
            return true;
        }

        // Animal Companion pairing
        if cards.len() == 2 {
            let has_ace = cards.iter().any(|c| c.rank == Rank::Ace);
            if has_ace {
                // One must be an Ace, the other can be anything except Joker (checked in play_cards)
                return cards.iter().all(|c| c.rank != Rank::Joker);
            }
        }

        // Sets (2, 3, or 4 of same rank, total <= 10)
        let first_rank = cards[0].rank;
        let same_rank = cards.iter().all(|c| c.rank == first_rank);
        let total: u32 = cards.iter().map(|c| c.attack_value()).sum();

        if same_rank && total <= 10 && cards.len() >= 2 && cards.len() <= 4 {
            // Only numbers can be in sets? Rules: "[rules wording removed]"
            // Jacks/Queens/Kings are 10+, so they can't be in a set summing to <= 10 anyway.
            return matches!(first_rank, Rank::Number(_));
        }

        false
    }

    fn calculate_attack_value(&self, cards: &[Card]) -> u32 {
        cards.iter().map(|c| c.attack_value()).sum()
    }

    fn get_active_suits(&self, cards: &[Card]) -> Vec<Suit> {
        let mut suits = Vec::new();
        for card in cards {
            if let Some(suit) = card.suit {
                if !suits.contains(&suit) {
                    suits.push(suit);
                }
            }
        }
        suits
    }

    fn is_enemy_immune(&self, suit: Suit) -> bool {
        self.active_enemy.as_ref().map_or(false, |e| e.is_immune(suit))
    }

    fn apply_suit_powers(&mut self, attack_value: u32, suits: &[Suit]) {
        let mut resolved_suits = suits.to_vec();
        resolved_suits.sort_by(|a, b| match (a, b) {
            (Suit::Hearts, Suit::Diamonds) => std::cmp::Ordering::Less,
            (Suit::Diamonds, Suit::Hearts) => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Equal,
        });

        for suit in resolved_suits {
            if self.is_enemy_immune(suit) {
                continue;
            }
            match suit {
                Suit::Hearts => {
                    shuffle(&mut self.discard_pile, &mut self.rng);
                    self.last_discarded = None;
                    for _ in 0..attack_value {
                        if let Some(card) = self.discard_pile.pop() {
                            self.tavern_deck.insert(0, card);
                        }
                    }
                }
                Suit::Diamonds => {
                    let player_count = self.players.len();
                    let mut drawer_offset = 0;
                    for _ in 0..attack_value {
                        let mut found_drawer = false;
                        for i in 0..player_count {
                            let idx = (self.current_player_index + drawer_offset + i) % player_count;
                            let max_hand = self.max_hand_size();
                            if self.players[idx].hand.len() < max_hand {
                                if let Some(card) = self.tavern_deck.pop() {
                                    self.players[idx].hand.push(card);
                                    drawer_offset = (drawer_offset + i + 1) % player_count;
                                    found_drawer = true;
                                    break;
                                }
                            }
                        }
                        if !found_drawer { break; } // Deck empty or all hands full
                    }
                }
                Suit::Spades => {
                    self.shield_value += attack_value as i32;
                }
                Suit::Clubs => {}
            }
        }
    }

    fn max_hand_size(&self) -> usize {
        match self.players.len() {
            1 => 8,
            2 => 7,
            3 => 6,
            4 => 5,
            _ => 0,
        }
    }
}
