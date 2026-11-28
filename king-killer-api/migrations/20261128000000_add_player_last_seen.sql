-- When each player profile was last used, so profiles nobody has used for the
-- retention period (3 years, see king-killer-api/src/retention.rs) can be
-- removed. NULL for profiles created before this column; retention falls back
-- to created_at for them. Times are UTC (CURRENT_TIMESTAMP).
-- Not rerunnable on its own (SQLite has no ADD COLUMN IF NOT EXISTS); sqlx
-- runs each migration exactly once.
ALTER TABLE players ADD COLUMN last_seen_at DATETIME;
