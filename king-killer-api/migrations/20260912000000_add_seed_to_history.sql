-- Replay support: every history row records the deal seed and the rules
-- version that produced the action, so a game can be reconstructed from a
-- stored seed under the matching king-killer-core version.
ALTER TABLE game_history ADD COLUMN seed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_history ADD COLUMN version INTEGER NOT NULL DEFAULT 1;