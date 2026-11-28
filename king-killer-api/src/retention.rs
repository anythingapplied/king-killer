//! Personal-data retention (Standards 4.7): nothing about players is kept
//! longer than [`RETENTION`] after it was last used.
//!
//! | Data | Removed once older than the retention period, by |
//! |---|---|
//! | Rooms (`games`: members' names, chat, push subscriptions, game state) | `updated_at` - the last action in the room |
//! | Action history (`game_history`) | `created_at`, and with its room |
//! | Finished games (`game_results`, `game_result_players`) | `finished_at` |
//! | Player profiles (`players`: name, cookie hash) | `last_seen_at` (else `created_at`), once no kept result needs them |
//!
//! The sweep runs when the server starts - which is often, since it sleeps
//! when idle - and once a day while it stays up. It only deletes what is past
//! the cutoff, so running it again finds nothing more (Standards 1.6). The
//! leaderboard therefore covers the last three years.
//!
//! Times are UTC: SQLite's `CURRENT_TIMESTAMP` and `datetime('now', ...)`.
//!
//! # Changes
//!
//! * 2026-11-28: Created. Three years, as decided by Luke Alfuth on
//!   2026-11-27; before this nothing was ever deleted.

use std::time::Duration;

use sqlx::SqlitePool;

/// How long data is kept after it was last used, as an SQLite date modifier.
pub const RETENTION: &str = "-3 years";

/// How often a long-running server sweeps again.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// What one sweep removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub rooms: Vec<String>,
    pub history: u64,
    pub results: u64,
    pub players: u64,
}

/// Deletes everything past the retention period, in one transaction, and
/// returns the ids of the rooms removed (so the caller can drop them from
/// memory too). `now` is an SQLite time value - `'now'` in production, a
/// fixed time in tests.
pub async fn sweep(db: &SqlitePool, now: &str) -> Result<Swept, sqlx::Error> {
    let mut tx = db.begin().await?;
    let cutoff: (String,) = sqlx::query_as("SELECT datetime(?1, ?2)").bind(now).bind(RETENTION).fetch_one(&mut *tx).await?;
    let cutoff = cutoff.0;

    let rooms: Vec<(String,)> = sqlx::query_as("SELECT id FROM games WHERE updated_at < ?1")
        .bind(&cutoff)
        .fetch_all(&mut *tx)
        .await?;
    let rooms: Vec<String> = rooms.into_iter().map(|(id,)| id).collect();

    // History goes with its room, and on its own once it's old enough.
    let history = sqlx::query(
        "DELETE FROM game_history WHERE created_at < ?1 OR game_id IN (SELECT id FROM games WHERE updated_at < ?1)",
    )
    .bind(&cutoff)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM games WHERE updated_at < ?1").bind(&cutoff).execute(&mut *tx).await?;

    // Players first, then the result rows (no reliance on foreign-key cascades).
    sqlx::query("DELETE FROM game_result_players WHERE result_id IN (SELECT id FROM game_results WHERE finished_at < ?1)")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?;
    let results = sqlx::query("DELETE FROM game_results WHERE finished_at < ?1")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    let players = sqlx::query(
        "DELETE FROM players WHERE COALESCE(last_seen_at, created_at) < ?1 \
         AND id NOT IN (SELECT player_id FROM game_result_players)",
    )
    .bind(&cutoff)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    tx.commit().await?;
    Ok(Swept { rooms, history, results, players })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Today, for the tests: the cutoff is three years earlier, 2023-11-28.
    const NOW: &str = "2026-11-28 12:00:00";
    const OLD: &str = "2023-11-27 12:00:00"; // a day past the cutoff
    const KEPT: &str = "2023-11-29 12:00:00"; // a day inside it

    async fn db() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // AssertSqlSafe: test-only SQL assembled from the fixed seed data above,
    // never from input.
    async fn exec(db: &SqlitePool, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).execute(db).await.unwrap();
    }

    async fn ids(db: &SqlitePool, sql: &str) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).fetch_all(db).await.unwrap();
        rows.into_iter().map(|(id,)| id).collect()
    }

    async fn seed(db: &SqlitePool) {
        exec(db, &format!("INSERT INTO games (id, state_json, updated_at) VALUES ('OLD001', '{{}}', '{OLD}'), ('NEW001', '{{}}', '{KEPT}')")).await;
        exec(db, &format!(
            "INSERT INTO game_history (game_id, action_type, action_json, created_at) VALUES \
             ('OLD001', 'yield', '{{}}', '{KEPT}'), ('NEW001', 'yield', '{{}}', '{OLD}'), ('NEW001', 'yield', '{{}}', '{KEPT}')"
        ))
        .await;
        // Players: 1 gone quiet, 2 gone quiet but in a kept result, 3 active,
        // 4 old with no last_seen_at (from before the column) and no results.
        exec(db, &format!(
            "INSERT INTO players (id, secret_hash, name, created_at, last_seen_at) VALUES \
             (1, 'h1', 'Quiet', '{OLD}', '{OLD}'), (2, 'h2', 'Kept', '{OLD}', '{OLD}'), \
             (3, 'h3', 'Active', '{OLD}', '{KEPT}'), (4, 'h4', 'Legacy', '{OLD}', NULL)"
        ))
        .await;
        exec(db, &format!(
            "INSERT INTO game_results (id, game_id, seed, player_count, won, team_key, finished_at) VALUES \
             (10, 'OLD001', 1, 2, 1, '1,3', '{OLD}'), (11, 'NEW001', 2, 2, 0, '2,3', '{KEPT}')"
        ))
        .await;
        exec(db, "INSERT INTO game_result_players (result_id, player_id, seat) VALUES (10, 1, 0), (10, 3, 1), (11, 2, 0), (11, 3, 1)").await;
    }

    #[tokio::test]
    async fn removes_only_what_is_past_three_years() {
        let db = db().await;
        seed(&db).await;
        let swept = sweep(&db, NOW).await.unwrap();

        assert_eq!(swept.rooms, vec!["OLD001".to_string()]);
        assert_eq!(ids(&db, "SELECT id FROM games").await, ["NEW001"]);
        // The old room's history goes with it; the kept room loses only its old row.
        assert_eq!(swept.history, 2);
        let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM game_history").fetch_one(&db).await.unwrap();
        assert_eq!(left, 1);
        // The old result and its player rows go; the kept one stays.
        assert_eq!(swept.results, 1);
        let (result_players,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM game_result_players").fetch_one(&db).await.unwrap();
        assert_eq!(result_players, 2);
        // Quiet and Legacy go; Kept stays for its result; Active is recent.
        assert_eq!(swept.players, 2);
        assert_eq!(ids(&db, "SELECT name FROM players ORDER BY id").await, ["Kept", "Active"]);
    }

    #[tokio::test]
    async fn a_second_sweep_finds_nothing() {
        let db = db().await;
        seed(&db).await;
        sweep(&db, NOW).await.unwrap();
        assert_eq!(sweep(&db, NOW).await.unwrap(), Swept::default());
    }

    #[tokio::test]
    async fn an_empty_database_is_fine() {
        let db = db().await;
        assert_eq!(sweep(&db, NOW).await.unwrap(), Swept::default());
    }
}
