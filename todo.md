# King Killer Project TODOs

## Open

### Correctness / security
- [ ] **Seat authorization**: the WebSocket accepts any action from any connected
      client. Nothing stops a player sending `PlayCards` on someone else's turn,
      or `SetName` for another seat. Needs the socket to carry a seat and the
      handler to check it against `current_player_index`.
- [ ] **Hands are broadcast to everyone**: `ServerMessage::State` ships the whole
      `GameState`, so every client receives every hand and the Tavern deck order.
      Anyone with devtools can read them. Needs per-seat redaction before send —
      this is the largest outstanding change.
- [ ] **Rejected actions are silent**: the handler does `let _ = match &action`,
      so an `Err` is swallowed and the unchanged state is rebroadcast. The player
      sees a click that did nothing. Needs a `ServerMessage::Error` variant and a
      toast. Most rejections are now prevented client-side, so this is the
      edge-case path (races, replayed buffers).

### Carried over from `todo.md_bkup`, still not done
- [ ] **Draw animation**: cards slide from the Tavern deck into their sorted hand
      position.
- [ ] **Enemy defeat preview**: briefly show what the enemy was defeated with
      before cleanup. (`last_played` is already on the state.)

### Nice to have
- [ ] **Background-tab alert on mobile**: iOS suspends audio for backgrounded
      tabs, so the turn chime is inaudible there. The tab-title flash only helps
      on desktop. The Notifications API is the only thing that works unfocused.
- [ ] **`king-killer-api` handler tests**: only the persistence helpers are covered;
      `create_game` / `join_game_seat` / the socket handler are not.
- [ ] **Playwright needs a running backend**: the layout and join specs assume
      `localhost:3000` is up. Worth a fixture that boots the server.

## Done

### Gameplay logic
- [x] **SP Jokers**: give a full hand (now refills to the hand limit, not a
      hardcoded 8).
- [x] **Diamond draw**: clockwise draw logic verified; the test no longer picks a
      random enemy, which made it fail ~1 run in 4 when it drew the immune Jack
      of Diamonds.
- [x] **Stuck prevention**: proactive loss check for solo players, including
      after the last Jester is spent mid-discard (previously a hard softlock).
- [x] **Seat assignment**: backend `join` picks a random free seat; creator holds
      seat 0.
- [x] **Immunity warning**: `!` on card, boss and attack button.
- [x] **Suit power order**: Hearts always resolves before Diamonds. The old
      comparator was not a total order, so a four-suit combo could draw from a
      deck it had not healed yet.
- [x] **Duplicate card indices rejected**: repeated indices used to remove
      *different* cards as the hand shifted.
- [x] **Jester next-player choice**: offered at every table size. Two players was
      hardcoded to auto-advance, which removed the legal "keep the turn" option.
- [x] **Jester goes to the play area**, not straight to the discard pile, so a
      Hearts heal can no longer recycle it mid-fight.
- [x] **Retroactive Jester powers restricted to Spades** — Hearts and Diamonds
      are one-shot effects that already resolved, and Clubs is explicitly not
      retroactive. (This entry previously read "Retroactive Jester power
      application", which described the over-broad behaviour.)
- [x] **Yield restriction**: a player may not yield once [rules wording removed].
- [x] **`create_game` input validation**: `num_players` outside 1–4 used to panic
      the handler.

### UI & layout
- [x] **Fluid scaling**: card size derives from a `dvh` height budget with hand
      slots on `flex-basis: 0`, so an 8-card solo hand can no longer overflow the
      screen (it used to run 39–50px past the edge on every common phone) and
      cards grow on desktop instead of capping at 95px.
- [x] **`100dvh` + safe-area insets**: the footer no longer hides under mobile
      browser chrome or the home indicator.
- [x] **Fluid type ramp** replaces the fixed 7/8/9/10px labels.
- [x] **In Play / Last Play visible on mobile** (were `hidden md:flex`).
- [x] **Last discarded shown**: the core has always tracked `last_discarded` and
      cleared it on a Hearts shuffle, but nothing rendered it.
- [x] **Mute toggle** for the turn chime, persisted to localStorage.
- [x] **Stationary hand**, **combat animations**, **defeat flight**, **discard
      "remaining" display**, **legible previews**, **full-width solo attack**.

### Infra / tests
- [x] **Turn chime actually sounds**: it was scheduled against a suspended
      context's frozen clock, and the context was never created from a user
      gesture (so on iOS it never unsuspended at all).
- [x] Frontend unit tests for shared game logic, reconnect, and the chime rule.
- [x] Rust tests for exact-kill vs overkill, suit ordering, index validation,
      Jester choice and placement, yield limits, solo-Jester loss.
- [x] `RULES_VERSION` bumped to 3 (rules behaviour changed).
- [x] Stale `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` resolved dynamically.
