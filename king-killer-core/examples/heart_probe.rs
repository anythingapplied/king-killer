use king_killer_core::*;

fn main() {
    // Scenario: enemy (Clubs Jack) with low health. Player plays a Heart to finish it.
    let mut s = GameState::new_with_seed(7, 2);
    s.active_enemy = Some(Enemy::new(Card::new(Suit::Clubs, Rank::Jack, 900)));
    s.active_enemy.as_mut().unwrap().current_health = 3;
    s.players[0].hand = vec![
        Card::new(Suit::Hearts, Rank::Number(5), 901),
        Card::new(Suit::Spades, Rank::Number(10), 902),
    ];
    s.players[1].hand = vec![Card::new(Suit::Spades, Rank::Number(10), 903)];
    // Pre-seed discard so the heart has something to heal.
    s.discard_pile = vec![
        Card::new(Suit::Spades, Rank::Number(2), 904),
        Card::new(Suit::Spades, Rank::Number(3), 905),
        Card::new(Suit::Spades, Rank::Number(4), 906),
        Card::new(Suit::Spades, Rank::Number(5), 907),
    ];
    let tavern_before = s.tavern_deck.len();
    let disc_before = s.discard_pile.len();
    println!("before: tavern={} discard={}", tavern_before, disc_before);
    s.play_cards(vec![0]).unwrap();
    println!("after:  tavern={} discard={} enemy={:?}",
        s.tavern_deck.len(), s.discard_pile.len(),
        s.active_enemy.as_ref().map(|e| e.card.rank).unwrap_or(Rank::Joker));
    println!("enemy was defeated: {}", s.active_enemy.as_ref().map(|e| e.card.id).unwrap_or(u32::MAX) != 900);

    // Scenario 2: hearts IMMUNE enemy (Jack of Hearts) — is the power suppressed?
    let mut s2 = GameState::new_with_seed(8, 2);
    s2.active_enemy = Some(Enemy::new(Card::new(Suit::Hearts, Rank::Jack, 1000)));
    s2.players[0].hand = vec![Card::new(Suit::Hearts, Rank::Number(5), 1001)];
    s2.discard_pile = vec![
        Card::new(Suit::Spades, Rank::Number(2), 1002),
        Card::new(Suit::Spades, Rank::Number(3), 1003),
    ];
    let tb = s2.tavern_deck.len(); let db = s2.discard_pile.len();
    s2.play_cards(vec![0]).unwrap();
    println!("immune-case: tavern {}->{} discard {}->{}",
        tb, s2.tavern_deck.len(), db, s2.discard_pile.len());
}
