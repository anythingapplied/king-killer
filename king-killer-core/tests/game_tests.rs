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
    state.current_player_index = 0;
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
    // Fixed seed: the random starting player / deal must not affect this test,
    // and the draw-order assertions stay deterministic across every run.
    let mut state = GameState::new_with_seed(999, 2);
    /* Pin the enemy as well. Its suit is incidental here, but a Jack of
       Diamonds is immune to the very draw being asserted on - so don't leave
       that riding on which seed happens to be picked. */
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 299)));
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
    
    state.current_player_index = 0;
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
    
    state.current_player_index = 0;
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
    state.current_player_index = 0;
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
    state.current_player_index = 0;
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
fn test_starting_player_is_random_across_seeds() {
    // "Random players should start each game": the first turn must not always
    // go to seat 0. Different deals (seeds) should pick different starters.
    let starters: std::collections::HashSet<usize> = (0..200)
        .map(|s| GameState::new_with_seed(s as u64, 4).current_player_index)
        .collect();
    // With 4 players and 200 seeds virtually every seat should appear.
    assert!(starters.len() >= 3, "expected near-uniform spread, got {:?}", starters);
    assert!(starters.iter().all(|&i| i < 4));
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
    assert_eq!(RULES_VERSION, 4, "bump when rules or RNG change");
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
fn test_jester_two_player_still_chooses() {
    let mut state = GameState::new(2);
    state.players[0].hand = vec![Card::joker(730)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();

    /* Two players is still a choice - keep the turn or pass it - so the turn
       must never advance on its own. */
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);
    assert_eq!(state.current_player_index, 0);

    /* Keeping the turn is a legal choice. */
    state.choose_next_player(0).unwrap();
    assert_eq!(state.current_player_index, 0);
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
}

#[test]
fn test_jester_two_player_can_pass_the_turn() {
    let mut state = GameState::new(2);
    state.players[0].hand = vec![Card::joker(740)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();
    state.choose_next_player(1).unwrap();
    assert_eq!(state.current_player_index, 1);
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
}

#[test]
fn test_jester_sits_in_the_play_area_until_the_enemy_dies() {
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 750)));
    state.players[0].hand = vec![
        Card::joker(751),
        Card::new(Suit::Spades, Rank::King, 752),
    ];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    state.discard_pile = Vec::new();

    state.play_cards(vec![0]).unwrap();
    /* On the table, not in the discard pile, so a Hearts heal cannot recycle
       it back into the Tavern deck while the fight is still running. */
    assert_eq!(state.played_cards.len(), 1);
    assert!(state.discard_pile.is_empty());

    state.choose_next_player(0).unwrap();
    state.play_cards(vec![0]).unwrap(); // King: exactly 20, kills the Jack

    /* Defeat sweeps the whole play area, Jester included, into the discard. */
    assert!(state.played_cards.is_empty());
    assert!(state.discard_pile.iter().any(|c| c.rank == Rank::Joker));
}

#[test]
fn test_hearts_resolve_before_diamonds_in_a_four_suit_combo() {
    /* All four suits can hit the table at once (four 2s = 8). Hearts must heal
       into the Tavern deck before Diamonds draws out of it, whatever order the
       cards happened to sit in the hand. */
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Clubs, Rank::Jack, 800)));
    state.current_player_index = 0; // the starting player is random now
    /* Cards leave the hand highest-index-first, so this ordering hands the
       resolver [Diamonds, Spades, Clubs, Hearts] - Diamonds ahead of Hearts. */
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(2), 801),
        Card::new(Suit::Clubs, Rank::Number(2), 802),
        Card::new(Suit::Spades, Rank::Number(2), 803),
        Card::new(Suit::Diamonds, Rank::Number(2), 804),
    ];
    state.players[1].hand = vec![Card::new(Suit::Hearts, Rank::Number(10), 805); 7];
    state.tavern_deck = Vec::new();
    state.discard_pile = vec![Card::new(Suit::Spades, Rank::Number(9), 806); 8];

    state.play_cards(vec![0, 1, 2, 3]).unwrap();

    /* Hearts moves all 8 discards under the Tavern deck, then Diamonds draws 8
       out of it - the solo drawer fills to the 7-card limit and 1 is left.
       Resolved the other way round the deck is empty when Diamonds runs and the
       player draws nothing at all. */
    assert_eq!(state.discard_pile.len(), 0);
    assert_eq!(state.players[0].hand.len(), 7);
    assert_eq!(state.tavern_deck.len(), 1);
}

#[test]
fn test_duplicate_indices_are_rejected() {
    let mut state = GameState::new(2);
    state.current_player_index = 0; // the starting player is random now
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(5), 810),
        Card::new(Suit::Spades, Rank::Number(5), 811),
        Card::new(Suit::Clubs, Rank::Number(9), 812),
    ];
    let before = state.players[0].hand.clone();

    assert!(state.play_cards(vec![0, 0]).is_err());
    /* The hand must be untouched by a rejected play. */
    assert_eq!(state.players[0].hand, before);
}

#[test]
fn test_out_of_range_index_leaves_hand_untouched() {
    let mut state = GameState::new(2);
    state.current_player_index = 0; // the starting player is random now
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(5), 820),
        Card::new(Suit::Spades, Rank::Number(5), 821),
    ];
    assert!(state.play_cards(vec![0, 7]).is_err());
    assert_eq!(state.players[0].hand.len(), 2);
}

#[test]
fn test_jester_does_not_retroactively_heal_or_draw() {
    /* Only Spades apply retroactively. A Hearts enemy blocked the heal when the
       heart was played, and playing a Jester later must not rewind it. */
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 830)));
    state.current_player_index = 0; // the starting player is random now
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(5), 831),
        Card::new(Suit::Spades, Rank::Number(10), 832),
    ];
    state.players[1].hand = vec![Card::joker(833)];
    state.discard_pile = vec![Card::new(Suit::Clubs, Rank::Number(4), 834); 6];

    state.play_cards(vec![0]).unwrap();
    state.discard_cards(vec![0]).unwrap();
    let discard_after_play = state.discard_pile.len();
    let tavern_after_play = state.tavern_deck.len();

    state.play_cards(vec![0]).unwrap();

    /* Nothing is healed back: the discard pile and the Tavern deck are both
       untouched. The Jester goes to the play area, not the discard. */
    assert_eq!(state.discard_pile.len(), discard_after_play);
    assert_eq!(state.tavern_deck.len(), tavern_after_play);
    assert!(state.played_cards.iter().any(|c| c.rank == Rank::Joker));
}

#[test]
fn test_cannot_yield_when_everyone_else_already_has() {
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 840)));
    state.current_player_index = 0; // the starting player is random now
    for p in state.players.iter_mut() {
        p.hand = vec![Card::new(Suit::Spades, Rank::Number(10), 841); 4];
    }

    state.yield_turn().unwrap();
    state.discard_cards(vec![0]).unwrap();
    state.yield_turn().unwrap();
    state.discard_cards(vec![0]).unwrap();

    /* Two yields in a row in a three-player game: the third player is stuck
       playing a card. */
    assert!(state.yield_turn().is_err());

    /* Playing a card clears the streak, so yielding is legal again. */
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.consecutive_yields, 0);
}

#[test]
fn test_solo_jester_on_an_unpayable_hit_ends_the_game() {
    /* Spending the last Jester during the discard step and still coming up
       short must end the game rather than leave it stuck in AwaitingDiscard. */
    let mut state = GameState::new(1);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::King, 850)));
    state.solo_jesters = 1;
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::Number(2), 851)];
    state.tavern_deck = vec![Card::new(Suit::Spades, Rank::Number(2), 852); 3];

    state.play_cards(vec![0]).unwrap();
    assert!(matches!(state.phase, TurnPhase::AwaitingDiscard { .. }));
    assert_eq!(state.status, GameStatus::InProgress);

    state.use_solo_jester().unwrap();
    assert!(matches!(state.status, GameStatus::Lost(_)));
}

#[test]
fn test_yield_is_recorded_as_an_empty_play() {
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 860)));
    for p in state.players.iter_mut() {
        // Hearts: the enemy is immune, so nothing shields the incoming hit away
        // and the discard step actually happens.
        p.hand = vec![Card::new(Suit::Hearts, Rank::Number(10), 861); 3];
    }
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.last_played.as_ref().map(|c| c.len()), Some(1));
    state.discard_cards(vec![0]).unwrap();

    state.yield_turn().unwrap();
    /* An empty play means "yielded" - the board must not keep showing the
       previous player's cards as though nothing happened. */
    assert_eq!(state.last_played, Some(Vec::new()));
}

#[test]
fn test_play_log_keeps_each_play_grouped_and_attributed() {
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::King, 870)));
    for p in state.players.iter_mut() {
        p.hand = vec![Card::new(Suit::Hearts, Rank::Number(10), 871); 4];
    }
    state.current_player_index = 0;
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(3), 872),
        Card::new(Suit::Spades, Rank::Number(3), 873),
        Card::new(Suit::Hearts, Rank::Number(10), 874),
        Card::new(Suit::Hearts, Rank::Number(10), 875),
    ];
    state.phase = TurnPhase::AwaitingPlay;

    /* A pair played together must stay one entry, not two loose cards. */
    state.play_cards(vec![0, 1]).unwrap();
    assert_eq!(state.play_log.len(), 1);
    assert_eq!(state.play_log[0].player, 0);
    assert_eq!(state.play_log[0].cards.len(), 2);
    assert_eq!(state.played_cards.len(), 2);

    /* Spades shielded 6 of the King's 20, so 14 still has to be covered - one
       ten is not enough. */
    state.discard_cards(vec![0, 1]).unwrap();
    state.yield_turn().unwrap();

    /* A yield is an entry too, with no cards. */
    assert_eq!(state.play_log.len(), 2);
    assert_eq!(state.play_log[1].player, 1);
    assert!(state.play_log[1].cards.is_empty());
}

#[test]
fn test_play_log_resets_with_the_enemy() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 880)));
    state.current_player_index = 0;
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::King, 881)];
    state.phase = TurnPhase::AwaitingPlay;

    /* King is exactly 20: the Jack dies and a fresh enemy comes up. */
    state.play_cards(vec![0]).unwrap();
    assert!(state.play_log.is_empty(), "the log belongs to the enemy that just died");
    assert!(state.played_cards.is_empty());
}

#[test]
fn test_game_log_records_the_whole_game_not_just_one_enemy() {
    let mut state = GameState::new(3);
    /* Every game starts by revealing the first enemy. */
    assert_eq!(state.game_log.len(), 1);
    assert_eq!(state.game_log[0].kind, LogKind::EnemyRevealed);
    assert_eq!(state.game_log[0].player, None);

    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 890)));
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    for p in state.players.iter_mut() {
        p.hand = vec![Card::new(Suit::Hearts, Rank::Number(10), 891); 3];
    }

    state.play_cards(vec![0]).unwrap();
    state.discard_cards(vec![0]).unwrap();
    state.yield_turn().unwrap();

    let kinds: Vec<LogKind> = state.game_log.iter().skip(1).map(|e| e.kind).collect();
    assert_eq!(kinds, vec![LogKind::Played, LogKind::Discarded, LogKind::Yielded]);
    assert_eq!(state.game_log[1].player, Some(0));
    assert_eq!(state.game_log[1].cards.len(), 1);
    assert_eq!(state.game_log[3].player, Some(1));

    /* play_log is per-enemy; game_log is not. */
    assert!(state.game_log.len() > state.play_log.len());
}

#[test]
fn test_game_log_is_capped() {
    let mut state = GameState::new(2);
    for i in 0..250 {
        state.log_for_test(Some(0), LogKind::Yielded, Vec::new());
        let _ = i;
    }
    assert!(state.game_log.len() <= 200, "log grew to {}", state.game_log.len());
    /* The newest entries are the ones kept. */
    assert_eq!(state.game_log.last().map(|e| e.kind), Some(LogKind::Yielded));
}

#[test]
fn test_a_rejected_play_leaves_the_hand_untouched_and_in_order() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 900)));
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    let hand = vec![
        Card::new(Suit::Hearts, Rank::Number(2), 901),
        Card::new(Suit::Spades, Rank::Number(7), 902),
        Card::new(Suit::Clubs, Rank::Number(9), 903),
        Card::new(Suit::Diamonds, Rank::King, 904),
    ];
    state.players[0].hand = hand.clone();

    /* 7 and 9 are neither a set nor an Ace pairing. */
    assert!(state.play_cards(vec![1, 2]).is_err());
    /* Same cards, same order - not appended to the end. */
    assert_eq!(state.players[0].hand, hand);
}

#[test]
fn test_a_rejected_discard_neither_reorders_the_hand_nor_logs() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::King, 910)));
    state.current_player_index = 0;
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(2), 911),
        Card::new(Suit::Hearts, Rank::Number(3), 912),
        Card::new(Suit::Hearts, Rank::Number(10), 913),
    ];
    state.phase = TurnPhase::AwaitingDiscard { damage_to_take: 20 };
    let hand = state.players[0].hand.clone();
    let log_len = state.game_log.len();

    /* A single 2 nowhere near covers 20. */
    assert!(state.discard_cards(vec![0]).is_err());
    assert_eq!(state.players[0].hand, hand);
    /* A rejected discard never happened, so it must not appear in the log. */
    assert_eq!(state.game_log.len(), log_len);
}

#[test]
fn solo_player_loses_when_the_attack_is_fully_shielded_and_the_hand_is_empty() {
    /* The reported bug. A shield that cancels the enemy's attack entirely
       skips the discard step - and the loss check used to live only on that
       path, so the turn came straight back to a solo player with no cards, no
       Jesters, and no game over. */
    let mut state = GameState::new(1);
    state.solo_jesters = 0;
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Diamonds, Rank::King, 920)));
    state.shield_value = 20; // already covers the King's 20 attack
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::Number(2), 921)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();

    assert!(state.players[0].hand.is_empty());
    assert!(
        matches!(state.status, GameStatus::Lost(_)),
        "an empty hand with no Jester left is a loss, shielded or not"
    );
}

#[test]
fn solo_player_with_a_jester_left_is_not_lost_yet() {
    /* Same position, but a Jester can still refresh the hand - so this must
       not be declared a loss. */
    let mut state = GameState::new(1);
    state.solo_jesters = 1;
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Diamonds, Rank::King, 930)));
    state.shield_value = 20;
    state.players[0].hand = vec![Card::new(Suit::Spades, Rank::Number(2), 931)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.play_cards(vec![0]).unwrap();

    assert_eq!(state.status, GameStatus::InProgress);
}

#[test]
fn a_player_who_can_neither_play_nor_yield_loses() {
    /* The table loses when the current player has no legal play and cannot
       yield. An empty-handed player can normally still yield - but not
       once everyone else already has. */
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 940)));
    state.shield_value = 10; // cancels the Jack's attack, so yielding costs nothing
    state.players[0].hand = vec![Card::new(Suit::Hearts, Rank::Number(5), 941)];
    state.players[1].hand = Vec::new();
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.yield_turn().unwrap();

    assert_eq!(state.current_player_index, 1);
    assert!(
        matches!(state.status, GameStatus::Lost(_)),
        "seat 1 has no cards and cannot yield after seat 0 just did"
    );
}

#[test]
fn an_empty_handed_player_who_can_still_yield_is_not_lost() {
    /* Three players: one yield does not exhaust the table's ability to yield,
       so seat 1 still has a legal move. */
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 950)));
    state.shield_value = 10;
    state.players[0].hand = vec![Card::new(Suit::Hearts, Rank::Number(5), 951)];
    state.players[1].hand = Vec::new();
    state.players[2].hand = vec![Card::new(Suit::Hearts, Rank::Number(5), 952)];
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;

    state.yield_turn().unwrap();

    assert_eq!(state.current_player_index, 1);
    assert_eq!(state.status, GameStatus::InProgress);
}

#[test]
fn choosing_an_empty_handed_player_is_not_a_loss_while_they_can_still_yield() {
    /* Pins the reasoning behind check_turn_playable in choose_next_player:
       playing the Jester resets the yield streak, so the chosen player always
       has yielding available and must not be declared stuck. If the streak
       reset ever changes, this test says what breaks. */
    let mut state = GameState::new(3);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 960)));
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    state.players[0].hand = vec![Card::joker(961)];
    state.players[1].hand = Vec::new();
    state.players[2].hand = vec![Card::new(Suit::Hearts, Rank::Number(5), 962)];

    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);
    assert_eq!(state.consecutive_yields, 0, "the Jester broke any run of yields");

    state.choose_next_player(1).unwrap();

    assert_eq!(state.current_player_index, 1);
    assert_eq!(state.status, GameStatus::InProgress, "seat 1 can still yield");
}

#[test]
fn jester_player_can_choose_themself_in_a_four_player_game() {
    /* End-to-end: seat 2 plays the Jester and picks seat 2 - back to
       themselves - and the turn genuinely stays with them, not merely
       "would have been allowed". */
    let mut state = GameState::new(4);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::King, 990)));
    state.current_player_index = 2;
    state.phase = TurnPhase::AwaitingPlay;
    state.players[2].hand = vec![Card::joker(991), Card::new(Suit::Spades, Rank::Number(5), 992)];

    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);
    assert_eq!(state.current_player_index, 2, "still the Jester player's turn while they decide");

    state.choose_next_player(2).unwrap();

    assert_eq!(state.current_player_index, 2, "chose to keep it");
    assert_eq!(state.phase, TurnPhase::AwaitingPlay);
    /* And the game genuinely continues from there - it is seat 2's turn to
       act, not merely a number that says so: they hold the only remaining
       card and playing it must succeed rather than being rejected as
       out-of-turn. */
    assert_eq!(state.players[2].hand.len(), 1);
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.players[2].hand.len(), 0, "the play was accepted");
}

#[test]
fn jester_player_can_hand_the_turn_to_any_other_seat() {
    let mut state = GameState::new(4);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::King, 993)));
    state.current_player_index = 0;
    state.phase = TurnPhase::AwaitingPlay;
    state.players[0].hand = vec![Card::joker(994)];

    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.phase, TurnPhase::AwaitingNextPlayer);

    for target in [1usize, 2, 3, 0] {
        state.current_player_index = 0;
        state.phase = TurnPhase::AwaitingNextPlayer;
        state.choose_next_player(target).unwrap();
        assert_eq!(state.current_player_index, target);
        assert_eq!(state.phase, TurnPhase::AwaitingPlay);
    }
}
