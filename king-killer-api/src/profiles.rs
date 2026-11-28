//! Lasting player profiles, finished-game results and the leaderboard.
//!
//! # Profiles
//!
//! A profile is a person across rooms and games, so results can be counted
//! for them. There are no accounts: the server issues a random secret in an
//! `HttpOnly` cookie ([`PROFILE_COOKIE`]) the first time a browser creates or
//! joins a game, and the database keeps only the secret's SHA-256, never the
//! secret itself. Page scripts can't read the cookie (Standards 4.2), and a
//! copy of the database can't be turned back into someone's cookie. A new
//! device or cleared site data starts a new profile.
//!
//! A room links each member token to a profile (`Room::profiles`); the profile
//! takes the member's latest name, so a rename follows the person.
//!
//! # Results
//!
//! A game is recorded once, when it reaches Won or Lost - abandoned games and
//! re-deals mid-game never finish, so they are never counted. Games where
//! someone used undo count like any other. `(game_id, seed)` is unique, so
//! recording the same finish twice is a no-op.
//!
//! # Ranking
//!
//! Standings are sorted by the lower bound of the 95% Wilson score interval
//! for the win rate ([`wilson_lower_bound`]): a short lucky run can't top the
//! board, because one win in one game only proves the true rate is above ~21%.
//!
//! Times are UTC (SQLite's `CURRENT_TIMESTAMP`).
//!
//! # Changes
//!
//! * 2026-11-27: Created, for the leaderboard: profiles, recorded results,
//!   and Wilson-ranked standings per player count, for players and teams.

use std::collections::HashMap;

use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use king_killer_core::{GameState, GameStatus};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

/// The profile cookie. `__Host-` makes the browser insist on `Secure`,
/// `Path=/` and no `Domain`, so no other host can set or read it.
pub const PROFILE_COOKIE: &str = "__Host-kk-player";

/// Browsers cap a cookie's lifetime at 400 days; each create or join renews it.
const PROFILE_COOKIE_DAYS: i64 = 400;

/// Rows per list on the board.
pub const LEADERBOARD_SIZE: usize = 10;

/// 95% two-sided confidence.
const WILSON_Z: f64 = 1.96;

/// Shown for a profile that never gave a name.
const UNNAMED: &str = "Unnamed player";

fn hash_secret(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn profile_cookie(secret: String) -> Cookie<'static> {
    Cookie::build((PROFILE_COOKIE, secret))
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::days(PROFILE_COOKIE_DAYS))
        .build()
}

/// The profile this request's cookie names, if it names a known one.
pub async fn find_profile(db: &SqlitePool, jar: &CookieJar) -> Result<Option<i64>, sqlx::Error> {
    let Some(cookie) = jar.get(PROFILE_COOKIE) else { return Ok(None) };
    let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM players WHERE secret_hash = ?1")
        .bind(hash_secret(cookie.value()))
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(id,)| id))
}

/// The profile behind this request, creating it (and its cookie) when the
/// request has none or names one this server doesn't know. Returns the
/// profile id and the jar to send back, which renews the cookie either way.
/// `name`, when given, becomes the profile's name.
pub async fn profile_for(
    db: &SqlitePool,
    jar: CookieJar,
    name: Option<&str>,
    new_secret: impl FnOnce() -> String,
) -> Result<(i64, CookieJar), sqlx::Error> {
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    if let Some(id) = find_profile(db, &jar).await? {
        if let Some(name) = name {
            rename_profile(db, id, name).await?;
        }
        // Re-sent so the 400 days count from the latest visit.
        let secret = jar.get(PROFILE_COOKIE).map(|c| c.value().to_string()).unwrap_or_default();
        return Ok((id, jar.add(profile_cookie(secret))));
    }

    let secret = new_secret();
    let (id,): (i64,) = sqlx::query_as("INSERT INTO players (secret_hash, name) VALUES (?1, ?2) RETURNING id")
        .bind(hash_secret(&secret))
        .bind(name.unwrap_or(""))
        .fetch_one(db)
        .await?;
    Ok((id, jar.add(profile_cookie(secret))))
}

/// Gives a profile its player's latest name.
pub async fn rename_profile(db: &SqlitePool, id: i64, name: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE players SET name = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2 AND name <> ?1")
        .bind(name.trim())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// The team a finished game is credited to: its players' profile ids, sorted,
/// so the same people make the same key whatever seats they sat in. `None`
/// when any seat had no profile, or one profile held two seats (one person
/// playing both hands isn't a team).
pub fn team_key(seats: &[Option<i64>]) -> Option<String> {
    let mut ids: Vec<i64> = seats.iter().copied().collect::<Option<_>>()?;
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    Some(ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
}

/// Records a finished game, once. `seats[i]` is the profile at seat `i`, if
/// any. Returns whether a new result was written; an unfinished game, or one
/// already recorded, writes nothing.
pub async fn record_result(
    db: &SqlitePool,
    game_id: &str,
    game: &GameState,
    seats: &[Option<i64>],
) -> Result<bool, sqlx::Error> {
    let won = match game.status {
        GameStatus::Won => true,
        GameStatus::Lost(_) => false,
        GameStatus::InProgress => return Ok(false),
    };

    let mut tx = db.begin().await?;
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO game_results (game_id, seed, player_count, won, team_key) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(game_id)
    .bind(game.seed as i64)
    .bind(game.players.len() as i64)
    .bind(won)
    .bind(team_key(seats))
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        tx.commit().await?;
        return Ok(false);
    }
    let result_id = inserted.last_insert_rowid();
    for (seat, player) in seats.iter().enumerate() {
        if let Some(player_id) = player {
            // OR IGNORE: a profile holding two seats is credited once.
            sqlx::query("INSERT OR IGNORE INTO game_result_players (result_id, player_id, seat) VALUES (?1, ?2, ?3)")
                .bind(result_id)
                .bind(player_id)
                .bind(seat as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}

/// Lower bound of the Wilson score interval for `wins` out of `games` at 95%.
/// 0 for no games.
pub fn wilson_lower_bound(wins: i64, games: i64) -> f64 {
    if games <= 0 {
        return 0.0;
    }
    let n = games as f64;
    let rate = wins as f64 / n;
    let z2 = WILSON_Z * WILSON_Z;
    let centre = rate + z2 / (2.0 * n);
    let margin = WILSON_Z * ((rate * (1.0 - rate) + z2 / (4.0 * n)) / n).sqrt();
    ((centre - margin) / (1.0 + z2 / n)).max(0.0)
}

/// One row on the board: a player (one name) or a team (several).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Standing {
    pub names: Vec<String>,
    pub games: i64,
    pub wins: i64,
    /// [`wilson_lower_bound`] of the win rate, 0 to 1.
    pub score: f64,
}

/// The board for one table size. Solo has no teams.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Board {
    pub player_count: i64,
    pub players: Vec<Standing>,
    pub teams: Vec<Standing>,
}

/// Scores and orders standings, best first, keeping the top `limit`. Ties go
/// to more wins, then more games, then name order, so the order is stable.
pub fn rank(rows: Vec<(Vec<String>, i64, i64)>, limit: usize) -> Vec<Standing> {
    let mut standings: Vec<Standing> = rows
        .into_iter()
        .map(|(names, games, wins)| Standing { score: wilson_lower_bound(wins, games), names, games, wins })
        .collect();
    standings.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(b.wins.cmp(&a.wins))
            .then(b.games.cmp(&a.games))
            .then(a.names.cmp(&b.names))
    });
    standings.truncate(limit);
    standings
}

fn display_name(name: &str) -> String {
    if name.trim().is_empty() { UNNAMED.to_string() } else { name.to_string() }
}

/// The boards for 1 to 4 players.
pub async fn leaderboard(db: &SqlitePool) -> Result<Vec<Board>, sqlx::Error> {
    let player_rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT r.player_count, p.name, COUNT(*), SUM(r.won) \
         FROM game_result_players AS gp \
         JOIN game_results AS r ON r.id = gp.result_id \
         JOIN players AS p ON p.id = gp.player_id \
         GROUP BY r.player_count, p.id",
    )
    .fetch_all(db)
    .await?;

    let team_rows: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT player_count, team_key, COUNT(*), SUM(won) \
         FROM game_results \
         WHERE team_key IS NOT NULL AND player_count > 1 \
         GROUP BY player_count, team_key",
    )
    .fetch_all(db)
    .await?;

    // Names for the ids inside team keys: only profiles that have a result.
    let names: HashMap<i64, String> = sqlx::query_as::<_, (i64, String)>(
        "SELECT id, name FROM players WHERE id IN (SELECT player_id FROM game_result_players)",
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();

    Ok((1..=4)
        .map(|player_count| {
            let players = player_rows
                .iter()
                .filter(|row| row.0 == player_count)
                .map(|(_, name, games, wins)| (vec![display_name(name)], *games, *wins))
                .collect();
            let teams = team_rows
                .iter()
                .filter(|row| row.0 == player_count)
                .map(|(_, key, games, wins)| {
                    let mut members: Vec<String> = key
                        .split(',')
                        .filter_map(|id| id.parse::<i64>().ok())
                        .map(|id| display_name(names.get(&id).map(String::as_str).unwrap_or("")))
                        .collect();
                    members.sort();
                    (members, *games, *wins)
                })
                .collect();
            Board { player_count, players: rank(players, LEADERBOARD_SIZE), teams: rank(teams, LEADERBOARD_SIZE) }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wilson_matches_hand_worked_values() {
        // p = 1, n = 1: (1 + 1.9208 - 1.96 * sqrt(0.9604)) / 4.8416 = 0.2065
        assert!((wilson_lower_bound(1, 1) - 0.2065).abs() < 1e-4);
        assert!((wilson_lower_bound(10, 10) - 0.7225).abs() < 1e-4);
        assert!((wilson_lower_bound(5, 10) - 0.2366).abs() < 1e-4);
        assert_eq!(wilson_lower_bound(0, 5), 0.0);
        assert_eq!(wilson_lower_bound(0, 0), 0.0, "no games, no score");
    }

    #[test]
    fn one_lucky_win_does_not_top_a_long_good_record() {
        let ranked = rank(
            vec![
                (vec!["Lucky".into()], 1, 1),
                (vec!["Steady".into()], 20, 15),
                (vec!["Cold".into()], 4, 0),
            ],
            10,
        );
        let order: Vec<&str> = ranked.iter().map(|s| s.names[0].as_str()).collect();
        assert_eq!(order, ["Steady", "Lucky", "Cold"]);
    }

    #[test]
    fn ties_break_on_wins_then_games_then_name() {
        let ranked = rank(
            vec![(vec!["Bea".into()], 0, 0), (vec!["Ann".into()], 0, 0), (vec!["Cy".into()], 3, 0)],
            10,
        );
        let order: Vec<&str> = ranked.iter().map(|s| s.names[0].as_str()).collect();
        assert_eq!(order, ["Cy", "Ann", "Bea"], "all score 0: more games first, then by name");
    }

    #[test]
    fn rank_keeps_only_the_top_rows() {
        let rows = (0..15).map(|i| (vec![format!("P{i:02}")], 20, i)).collect();
        let ranked = rank(rows, LEADERBOARD_SIZE);
        assert_eq!(ranked.len(), LEADERBOARD_SIZE);
        assert_eq!(ranked[0].names[0], "P14");
    }

    #[test]
    fn a_team_is_the_same_people_in_any_seats() {
        assert_eq!(team_key(&[Some(7), Some(2), Some(5)]), Some("2,5,7".into()));
        assert_eq!(team_key(&[Some(5), Some(7), Some(2)]), team_key(&[Some(2), Some(5), Some(7)]));
        assert_eq!(team_key(&[Some(2), None]), None, "a seat without a profile");
        assert_eq!(team_key(&[Some(3), Some(3)]), None, "one person on both hands");
        assert_eq!(team_key(&[Some(4)]), Some("4".into()), "solo");
    }

    #[test]
    fn the_cookie_is_locked_down() {
        let cookie = profile_cookie("secret".into());
        assert!(cookie.http_only().unwrap_or(false));
        assert!(cookie.secure().unwrap_or(false));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.path(), Some("/"));
        assert!(cookie.domain().is_none(), "__Host- forbids a Domain");
        assert!(cookie.name().starts_with("__Host-"));
    }

    #[test]
    fn only_a_hash_of_the_secret_is_kept() {
        let hashed = hash_secret("abc");
        assert_eq!(hashed, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_ne!(hashed, "abc");
    }
}
