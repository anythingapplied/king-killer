# CLAUDE.md

Instructions for AI coding agents working in this repository. `AGENT.md` is the
owner's original project brief; read it for what the game is meant to be.

## Standards

Code here follows the Development Standards in `DevelopmentStandards.md` of the
`LukeAlfuth/Scripts` repository (private: ask Luke Alfuth for access). Apply
Section 1 (Code Quality Baseline) to every change without being asked: errors
fail loudly, every wait has a time limit, no duplicated or dead code, headers
and dated change notes, safe to run twice. Section 16 covers the web client and
Section 4 security. Deviate only with approval asked before building, and
record an approved deviation in the affected file's header.

## Repository rules

- **Determinism:** all randomness goes through `GameRng`; any change to the
  rules or the RNG bumps `RULES_VERSION` (README, "Things that will bite you").
- **Identity comes from the server:** a seat from the socket's token, a person
  from the profile cookie. Never trust a seat or player sent in a payload.
- **One origin, no CORS:** Vite proxies `/api` in development. Every POST
  carries `X-Requested-With: king-killer`; client REST calls go through
  `frontend/src/api.ts`, never `fetch` directly.
- **Migrations are forever:** never edit one that has shipped (sqlx checksums
  the bytes); add a new one. They stay LF (`.gitattributes`).
- **Room fields need `#[serde(default)]`:** the whole `Room` is one JSON column.
- **Exact versions** in `Cargo.toml` and `package.json`; Dependabot proposes
  upgrades.
- **Work on a branch, merge by pull request.** Small commits that say what and
  why, marked as AI-assisted with a `Co-Authored-By` line. Keep `todo.md`
  current: open items at the top, finished ones under Done.

## Commands

```bash
cargo test --workspace                      # rules engine + server
cargo clippy --workspace                    # no new warnings
cd frontend && npm ci                       # install exactly what the lockfile says
cd frontend && npm run build                # type-check (strict) + build
cd frontend && npm run lint
cd frontend && npm test                     # Vitest
cd frontend && npm run test:e2e             # Playwright; needs: cargo build -p king-killer-api
cd frontend && npm audit --audit-level=high
cargo audit                                 # needs: cargo install cargo-audit --locked
```

The Playwright fixture starts a fresh API with a throwaway database on :3000 for
each test, so nothing else may be using that port.
