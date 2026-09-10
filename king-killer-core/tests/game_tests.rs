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
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Spades, Rank::Jack)));
    state.players[0].hand = vec![
        Card::new(Suit::Clubs, Rank::Number(5)),
        Card::new(Suit::Hearts, Rank::Number(10)), // Padding
        Card::new(Suit::Hearts, Rank::Number(10)), // Extra padding to satisfy damage
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
        Card::new(Suit::Diamonds, Rank::Number(3)),
        Card::new(Suit::Spades, Rank::Number(2)),
        Card::new(Suit::Hearts, Rank::Number(10)),
        Card::new(Suit::Hearts, Rank::Number(10)),
    ];
    state.players[1].hand = vec![
        Card::new(Suit::Clubs, Rank::Number(2)),
        Card::new(Suit::Hearts, Rank::Number(10)),
    ];
    state.tavern_deck = vec![
        Card::new(Suit::Hearts, Rank::Number(9)),
        Card::new(Suit::Hearts, Rank::Number(8)),
        Card::new(Suit::Hearts, Rank::Number(7)),
    ];
    state.current_player_index = 0;
    state.play_cards(vec![0]).unwrap();
    // Discard to survive damage
    state.discard_cards(vec![0]).unwrap();
    
    // Draw logic check
    assert_eq!(state.players[0].hand.len(), 4); // 4 original - 1 played - 1 discarded + 2 drawn
    assert_eq!(state.players[1].hand.len(), 3); // 2 original + 1 drawn
}

#[test]
fn test_all_four_twos() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack)));
    state.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(2)),
        Card::new(Suit::Diamonds, Rank::Number(2)),
        Card::new(Suit::Spades, Rank::Number(2)),
        Card::new(Suit::Clubs, Rank::Number(2)),
        Card::new(Suit::Hearts, Rank::Number(10)), 
        Card::new(Suit::Hearts, Rank::Number(10)),
    ];
    state.players[1].hand = vec![Card::new(Suit::Hearts, Rank::Number(10)); 7]; // Full hand
    
    state.tavern_deck = vec![Card::new(Suit::Spades, Rank::Number(10)); 10];
    state.discard_pile = vec![Card::new(Suit::Spades, Rank::Number(9)); 5];
    
    state.play_cards(vec![0, 1, 2, 3]).unwrap();
    state.discard_cards(vec![0]).unwrap(); // Take 10 damage
    
    assert_eq!(state.discard_pile.len(), 6); // 5 initial + 1 new discard (Hearts power was blocked)
    assert_eq!(state.shield_value, 8); // Spades applied
    // P1 started with 6. Played 4 (2 left). Discarded 1 (1 left). 
    // Diamond power draws 8 cards, but capped at hand size 7. 
    // P2 is full, so P1 gets all of them until full.
    assert_eq!(state.players[0].hand.len(), 7); 
}

#[test]
fn test_retroactive_spades() {
    let mut state = GameState::new(2);
    state.active_enemy = Some(Enemy::new(Card::new(Suit::Spades, Rank::Jack)));
    state.players[0].hand = vec![
        Card::new(Suit::Spades, Rank::Number(5)),
        Card::new(Suit::Hearts, Rank::Number(10)),
        Card::new(Suit::Hearts, Rank::Number(10)),
    ];
    state.players[1].hand = vec![
        Card::joker(),
        Card::new(Suit::Hearts, Rank::Number(10)),
    ];
    
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.shield_value, 0); // immune
    state.discard_cards(vec![0]).unwrap(); // P1 take damage
    
    // P2 plays Jester
    state.play_cards(vec![0]).unwrap();
    assert_eq!(state.shield_value, 5); // retroactive
}
