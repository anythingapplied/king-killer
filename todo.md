# King Killer Project TODOs

## Gameplay Logic
- [x] **SP Jokers**: Give full hand of 8 cards.
- [x] **Diamond Draw Test**: Verified clockwise draw logic.
- [x] **Stuck Prevention**: Proactive loss check for solo players.
- [x] **Seat Assignment**: Auto-assign random seats (backend `join` picks a random free seat; creator holds seat 0).
- [x] **Immunity Warning**: Show `!` on card, boss, and attack button if playing an immune suit.

## UI & Layout
- [x] **Stationary Hand**: Hand layout fixed with empty slots.
- [x] **Desktop Overlap**: Refined using grid layout (needs overlap verification - covered by Playwright layout test).
- [x] **Combat Animations**:
    - [x] **Positioning**: Damage effect near HP, Shield effect near ATK.
    - [x] **Defeat Flow**: Enemy card flies to Tavern (exact kill, via `last_enemy_fate`) or Discard (overkill).
    - [x] **Fluidity**: Softer enemy entry + snappier hand deal.
    - [x] **Transition**: Replaced the 1200ms laggy hold with a 450ms blow + 650ms flight; killing-blow float now shows.
- [x] **Discard Display**: Show "Remaining" value only.

## Infra / Tests
- [x] Fixed `king-killer-core` test compile errors (`Card::new`/`Card::joker` id argument) + stale assertions.
- [x] Added `last_enemy_fate` to core state; Rust tests for exact-kill vs overkill.
- [x] Added frontend unit tests (Vitest) for shared game logic; extracted duplicate `isSelectionValid`/value helpers into `src/gameLogic.ts`.
- [x] Fixed stale `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` in devenv.nix (chromium version is resolved dynamically now).

## Completed
- [x] Fix "Your Turn" visibility.
- [x] Single player Joker spots in HUD.
- [x] Legible Previews (Doubled size).
- [x] Retroactive Jester power application.
- [x] Full-width solo Attack button.
