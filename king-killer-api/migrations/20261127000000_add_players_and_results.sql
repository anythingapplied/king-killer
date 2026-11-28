-- Lasting player profiles and finished-game results, for the leaderboard.
-- See king-killer-api/src/profiles.rs. Times are UTC (CURRENT_TIMESTAMP).
-- Rerunnable: every statement is IF NOT EXISTS.

-- A person across rooms and games. secret_hash is the SHA-256 of the secret in
-- their profile cookie; the secret itself is never stored.
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    secret_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
);

-- One row per game that reached Won or Lost. (game_id, seed) is one deal, so
-- the same finish can't be recorded twice. team_key is the sorted player ids
-- ("2,5,7"), NULL when a seat had no profile or one profile held two seats.
-- No foreign key to games: a result outlives its room.
CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    seed INTEGER NOT NULL,
    player_count INTEGER NOT NULL,
    won INTEGER NOT NULL,
    team_key TEXT,
    finished_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (game_id, seed)
);

CREATE INDEX IF NOT EXISTS game_results_player_count_team_key ON game_results (player_count, team_key);

-- Who played in each result, and from which seat.
CREATE TABLE IF NOT EXISTS game_result_players (
    result_id INTEGER NOT NULL REFERENCES game_results (id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players (id),
    seat INTEGER NOT NULL,
    PRIMARY KEY (result_id, player_id)
);

CREATE INDEX IF NOT EXISTS game_result_players_player_id ON game_result_players (player_id);
