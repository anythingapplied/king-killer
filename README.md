# King Killer

A mobile-first web implementation of the co-operative card game
[King Killer](rules.md). Rust rules engine, Rust server, React frontend, SQLite
persistence.

No accounts, no lobbies: you create a room, share the link, and whoever opens it
takes a seat. Anyone arriving after the seats are full watches instead.

## Layout

| Path | What it is |
|---|---|
| `king-killer-core/` | The rules engine. Pure logic, no I/O, no networking. |
| `king-killer-api/` | HTTP + WebSocket server, SQLite persistence, room membership. |
| `frontend/` | React + Vite + Tailwind client. |
| `rules.md` | The game's rules, as implemented. |
| `scripts/` | Card art generation and a dev launcher. |

The rules live in Rust specifically so they can be reused from OpenSpiel for
game-theory work — that's why `king-killer-core` has no dependency on the server.

## Running it

```bash
# Backend (http://localhost:3000)
cd king-killer-api && cargo run

# Frontend (http://localhost:5173, proxies the API)
cd frontend && npm install && npm run dev
```

`scripts/dev.sh` starts both under `nix shell` and logs to `backend.log` /
`frontend.log`. The repo targets NixOS via `devenv.nix`, but nothing outside
`dev.sh` assumes Nix.

`DATA_DIR` sets where `kingkiller.db` lives (default `./data`). Migrations in
`king-killer-api/migrations/` run automatically at startup.

## Tests

```bash
cargo test                      # rules engine + server
cd frontend && npm test         # unit tests (vitest)
cd frontend && npm run lint     # eslint
cd frontend && npm run test:e2e # playwright — needs the backend running
```

## Things that will bite you

**Determinism is load-bearing.** A game is reproducible from
`(seed, RULES_VERSION, ordered actions)`, which is what the `game_history` table
stores. All randomness goes through `GameRng`. **Any change to the rules or to
the RNG must bump `RULES_VERSION`** in `king-killer-core/src/lib.rs`, or stored
histories will silently replay into a different game.

**Some rules are implemented twice.** `frontend/src/gameLogic.ts` mirrors
`is_valid_combo`, `attack_value` and the clubs-doubling logic so the UI can grey
out illegal cards. The server is authoritative and **rejects invalid actions
silently**, so a divergence between the two shows up as a button that does
nothing rather than an error. Change them together.

**Rooms outlive games.** A `Room` holds members with stable seats; the
`GameState` inside it is replaced whenever a new deal starts. Anything that
should survive a re-deal (membership, chat, who the host is) belongs on `Room`,
not on `GameState`.

**The whole `Room` is serialized into one `state_json` column.** New room-level
fields need `#[serde(default)]` but no migration. The flip side: a field added
*without* a default makes every stored room fail to parse, and they're skipped
at startup — loudly, but skipped.

**The server exits when idle** (two minutes, see `idle_timeout`) so it can
scale to zero. Clients reconnect transparently and replay buffered actions, so
this is invisible mid-game — but it means nothing may live only in server
memory. The client's 30-second `Ping` deliberately does *not* reset the idle
timer.

**Identity comes from the socket, never the message body.** The WebSocket
carries `?seat=N`; that is what authorizes host-only actions (`NewGame`,
`Reset`) and acting as yourself (`SetName`, `SendChat`). Everything else targets
the game's own `current_player_index`. Don't add an action that trusts a seat
sent in its payload.

## Deploying

Fly.io, via the `Dockerfile` (`fly deploy`). `fly.toml` sets
`auto_stop_machines` with `min_machines_running = 0`, which is the other half of
the idle-shutdown behaviour above. The database lives on a mounted volume at
`/data`.
