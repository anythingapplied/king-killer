//! Rules checked against `shared/rule-fixtures.json`.
//!
//! `frontend/src/gameLogic.ts` re-implements these same rules so the UI can
//! grey out illegal selections before anything reaches the server. They agreed
//! by inspection, but nothing enforced it — and because the server rejects
//! invalid actions silently, a divergence surfaces as a button that does
//! nothing rather than an error.
//!
//! Both suites read the same file, so a case added in one place has to hold in
//! both. `frontend/unit/sharedRules.test.ts` is the other half.

use king_killer_core::{Card, GameState, Rank, Suit};
use serde::Deserialize;

/// A card without an id: ids carry no rule meaning, so the fixture omits them
/// and the test assigns them.
#[derive(Deserialize)]
struct FixtureCard {
    suit: Option<Suit>,
    rank: Rank,
}

#[derive(Deserialize)]
struct AttackValueCase {
    why: String,
    card: FixtureCard,
    expected: u32,
}

#[derive(Deserialize)]
struct ComboCase {
    why: String,
    cards: Vec<FixtureCard>,
    valid: bool,
}

#[derive(Deserialize)]
struct DamageCase {
    why: String,
    cards: Vec<FixtureCard>,
    #[serde(rename = "enemySuit")]
    enemy_suit: Suit,
    #[serde(rename = "jesterActive")]
    jester_active: bool,
    expected: u32,
}

#[derive(Deserialize)]
struct Fixtures {
    #[serde(rename = "attackValues")]
    attack_values: Vec<AttackValueCase>,
    combos: Vec<ComboCase>,
    damage: Vec<DamageCase>,
}

fn fixtures() -> Fixtures {
    // include_str! so a missing or malformed fixture is a compile/parse error
    // here rather than a silently skipped test.
    let raw = include_str!("../../shared/rule-fixtures.json");
    serde_json::from_str(raw).expect("shared/rule-fixtures.json should parse")
}

fn build(cards: &[FixtureCard]) -> Vec<Card> {
    cards
        .iter()
        .enumerate()
        .map(|(i, c)| Card {
            suit: c.suit,
            rank: c.rank,
            id: 9000 + i as u32,
        })
        .collect()
}

#[test]
fn attack_values_match_the_shared_fixture() {
    let f = fixtures();
    assert!(!f.attack_values.is_empty(), "fixture should not be empty");
    for case in &f.attack_values {
        let card = build(std::slice::from_ref(&case.card))[0].clone();
        assert_eq!(
            card.attack_value(),
            case.expected,
            "attack value for {:?} ({})",
            card.rank,
            case.why
        );
    }
}

#[test]
fn combo_validity_matches_the_shared_fixture() {
    let f = fixtures();
    assert!(!f.combos.is_empty(), "fixture should not be empty");
    for case in &f.combos {
        let cards = build(&case.cards);
        assert_eq!(
            GameState::is_valid_combo(&cards),
            case.valid,
            "combo {:?} — {}",
            cards.iter().map(|c| c.rank).collect::<Vec<_>>(),
            case.why
        );
    }
}

#[test]
fn blow_damage_matches_the_shared_fixture() {
    let f = fixtures();
    assert!(!f.damage.is_empty(), "fixture should not be empty");
    for case in &f.damage {
        let cards = build(&case.cards);
        let base = GameState::calculate_attack_value(&cards);

        // Mirrors the frontend's calculateBlowDamage: clubs double the whole
        // play unless the enemy is immune to clubs, and a Jester clears that
        // immunity.
        let has_clubs = cards.iter().any(|c| c.suit == Some(Suit::Clubs));
        let clubs_blocked = case.enemy_suit == Suit::Clubs && !case.jester_active;
        let total = if has_clubs && !clubs_blocked { base * 2 } else { base };

        assert_eq!(total, case.expected, "damage — {}", case.why);
    }
}
