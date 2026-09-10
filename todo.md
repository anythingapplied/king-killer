# King Killer Project TODOs

## Gameplay Logic
- [x] **SP Jokers**: Give full hand of 8 cards.
- [x] **Diamond Draw Test**: Verified clockwise draw logic.
- [x] **Stuck Prevention**: Proactive loss check for solo players.
- [ ] **Seat Assignment**: Auto-assign random seats.
- [ ] **Immunity Warning**: Show `!` on card, boss, and attack button if playing an immune suit.

## UI & Layout
- [x] **Stationary Hand**: Hand layout fixed with empty slots.
- [x] **Desktop Overlap**: Refined using grid layout (needs overlap verification).
- [ ] **Combat Animations**:
    - [ ] **Positioning**: Damage effect near HP, Shield effect near ATK.
    - [ ] **Defeat Flow**: Animate enemy card flying to Tavern (exact) or Discard (overkill).
    - [ ] **Fluidity**: Fix the clunky scale-pause-scale enemy entry and weird card deal delays.
    - [ ] **Transition**: Reduce the laggy feel after defeating an enemy while still showing the blow.
- [x] **Discard Display**: Show "Remaining" value only.

## Completed
- [x] Fix "Your Turn" visibility.
- [x] Single player Joker spots in HUD.
- [x] Legible Previews (Doubled size).
- [x] Retroactive Jester power application.
- [x] Full-width solo Attack button.
