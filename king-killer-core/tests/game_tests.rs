use king_killer_core::*;

#[test]
fn test_new_game() {
    let state = GameState::new(2);
    assert_eq!(state.players.len(), 2);
    assert_eq!(state.players[0].hand.len(), 7);
    assert_eq!(state.players[1].hand.len(), 7);
    assert!(state.active_enemy.is_some());
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
}

#[test]
fn test_play_card_damage() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Spades, Rank::Jack, 100)));
    state.players[0].hand = vec![
        Card::new(Suit::Clubs, Rank::Number(5), 101),
        Card::new(Suit::Hearts, Rank::Number(10), 102), // Padding
        Card::new(Suit::Hearts, Rank::Number(10), 103), // Extra padding to satisfy damage
    ];
    state.play_cards(vec![0]).unwrap();
    // Survive damage
    state.discard_cards(vec![0]).unwrap();
    
    if let Some(enemy) = state.active_enemy {
        assert_eq!(enemy.current_health, 10);
    } else {
        panic!("Enemy should still be active");
    }
}

#[test]
fn test_diamond_draw_order() {
    let mut state = GameState::new(2);
    state.players[0].hand = vec![
        Card::new(Suit::Diamonds, Rank::Number(3), 200),
        Card::new(Suit::Spades, Rank::Number(2), 201),
        Card::new(Suit::Hearts, Rank::Number(10), 202),
        Card::new(Suit::Hearts, Rank::Number(10), 203),
    ];
    state.players[1].hand = vec![
        Card::new(Suit::Clubs, Rank::Number(2), 204),
        Card::new(Suit::Hearts, Rank::Number(10), 205),
    ];
    state.tavern_deck = vec![
        Card::new(Suit::Hearts, Rank::Number(9), 206),
        Card::new(Suit::Hearts, Rank::Number(8), 207),
        Card::new(Suit::Hearts, Rank::Number(7), 208),
    ];
    state.current_player_index = 0;
    state.play_cards(vec![0]).unwrap();
    // Discard to survive damage: hand is now [S2, H10, H10]; play the 10 (index 1)
    state.discard_cards(vec![1]).unwrap();
    
    // Draw logic check
    assert_eq!(state.players[0].hand.len(), 4); // 4 original - 1 played - 1 discarded + 2 drawn
    assert_eq!(state.players[1].hand.len(), 3); // 2 original + 1 drawn
}

#[test]
fn test_all_four_twos() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 300)));
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(2), 301),
        Card::new(Suit::Diamonds, Rank::Number(2), 302),
        Card::new(Suit::Spades, Rank::Number(2), 303),
        Card::new(Suit::Clubs, Rank::Number(2), 304),
        Card::new(Suit::Hearts, Rank::Number(10), 305), 
        Card::new(Suit::Hearts, Rank::Number(10), 306),
    ];
    state.players[1].hand = vec![Card::new(Suit::Hearts, Rank::Number(10), 307); 7]; // Full hand
    
    state.tavern_deck = vec![Card::new(Suit::Spades, Rank::Number(10), 308); 10];
    state.discard_pile = vec![Card::new(Suit::Spades, Rank::Number(9), 309); 5];
    
    state.play_cards(vec![0, 1, 2, 3]).unwrap();
    state.discard_cards(vec![0]).unwrap(); // Take 10 damage
    
    assert_eq!(state.discard_pile.len(), 6); // 5 initial + 1 new discard (Hearts power was blocked)
    assert_eq!(state.shield_value, 8); // Spades applied
    // P1 started with 6. Played 4 (2 left). Diamond draws happen *during* play
    // (before discard), capping P1 at max_hand_size 7. Then discarded 1 H10 (6 left).
    // P2 is full, so P1 gets all the draws until full.
    assert_eq!(state.players[0].hand.len(), 6); 
}

#[test]
fn test_retroactive_spades() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Spades, Rank::Jack, 400)));
    state.players[0].hand = vec![
        Card::new(Suit::Spades, Rank::Number(5), 401),
        Card::new(Suit::Hearts, Rank::Number(10), 402),
        Card::new(Suit::Hearts, Rank::Number(10), 403),
    ];
    state.players[1].hand = vec![
        Card::joker(404),
        Card::new(Suit::Hearts, Rank::Number(10), 405),
    ];
    
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.shield_value, 0); // immune
    state.discard_cards(vec![0]).unwrap(); // P1 take damage
    
    // P2 plays Jester
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.shield_value, 5); // retroactive
}

#[test]
fn test_exact_kill_goes_to_tavern() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 500)));
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::King, 501)];
    state.play_cards(vec![0]).unwrap();

    assert_eq!(state.last_enemy_fate, Some(EnemyFate::Tavern));
    // Exact kill: enemy card is placed on top of the Tavern deck (drawn first).
    assert_eq!(state.tavern_deck.last().map(|c| c.rank), Some(Rank::Jack));
    assert_eq!(state.discard_pile.last().map(|c| c.rank), Some(Rank::King));
}

#[test]
fn test_overkill_goes_to_discard() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 600)));
    state.active_enemy.as_mut().unwrap().current_health = 10; // below 20
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::King, 601)];
    state.play_cards(vec![0]).unwrap();

    assert_eq!(state.last_enemy_fate, Some(EnemyFate::Discard));
    // Overkill: enemy card goes to the discard pile.
    assert!(state.discard_pile.iter().any(|c| c.rank == Rank::Jack));
}

#[test]
fn test_last_enemy_fate_none_at_start() {
    let state = GameState::new(2);
    assert_eq!(state.last_enemy_fate, None);
}

#[test]
fn test_new_with_seed_is_deterministic() {
    let a = GameState::new_with_seed(42, 2);
    let b = GameState::new_with_seed(42, 2);
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    assert_eq!(a.seed, 42);
    assert_eq!(a.version, RULES_VERSION);

    let c = GameState::new_with_seed(43, 2);
    assert_ne!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&c).unwrap()
    );
}

#[test]
fn test_actions_replay_from_seed() {
    let seed = 12345u64;
    let mut game = GameState::new_with_seed(seed, 2);
    let snapshot = game.clone();

    // Replay from only the saved seed: deal + RNG progression must be identical.
    let mut replay = GameState::new_with_seed(seed, 2);

    game.play_cards(vec![0]).unwrap();
    replay.play_cards(vec![0]).unwrap();
    assert_eq!(
        serde_json::to_string(&game).unwrap(),
        serde_json::to_string(&replay).unwrap()
    );
    assert_ne!(
        serde_json::to_string(&snapshot).unwrap(),
        serde_json::to_string(&game).unwrap()
    );
    assert_eq!(RULES_VERSION, 2, "bump when rules or RNG change");
}

#[test]
fn test_jester_lets_player_choose_next_in_multiplayer() {
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 700)));
    state.players[0].hand = vec![Card::joker(701)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();

    // Steps 3 and 4 are skipped, so the chooser keeps the turn until they pick.
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);
    assert_eq!(state.current_player_index, 0);
    assert!(state.active_enemy.as_ref().unwrap().is_jester_active);

    state.choose_next_player(2).unwrap();
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
    assert_eq!(state.current_player_index, 2);
}

#[test]
fn test_jester_can_choose_self() {
    let mut state = GameState::new(4);
    state.players[1].hand = vec![Card::joker(710)];
    state.current_player_index = 1;
    state.phase = TurnPhase::AwaitingPlay;
    state.play_cards(vec![0]).unwrap();

    state.choose_next_player(1).unwrap();
    assert_eq!(state.current_player_index, 1);
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
}

#[test]
fn test_choose_next_player_rejected_outside_jester_choice() {
    let mut state = GameState::new(3);
    let err = state.choose_next_player(1).unwrap_err();
    assert!(err.contains("next-player"));

    let mut state = GameState::new(3);
    state.players[0].hand = vec![Card::joker(720)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    state.play_cards(vec![0]).unwrap();
    assert!(state.choose_next_player(9).is_err());
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);
}

#[test]
fn test_jester_two_player_auto_advances() {
    let mut state = GameState::new(2);
    state.players[0].hand = vec![Card::joker(730)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();

    // No meaningful choice with two players: play simply passes on.
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
    assert_eq!(state.current_player_index, 1);
}
