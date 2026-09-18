# King Killer Project TODOs

Merged from the original `todo.md` and `todo2.md`. Statuses below were checked
against the code rather than carried over, so a few entries that had been marked
open are now closed, and a couple that read as closed turned out to be partial.

## Open

### Correctness / security

- [ ] **Turn actions aren't seat-checked.** The socket now carries an
      authenticated seat (`?seat=N`) and uses it for host-only actions
      (`NewGame`/`Reset`) and for acting as yourself (`SetName`, `SendChat`).
      `PlayCards` / `Yield` / `DiscardCards` / `ChooseNextPlayer` /
      `UseSoloJester` still only check `current_player_index`, so nobody can
      play *out of turn* — but any connected client can take the current
      player's turn *for* them. The mechanism to fix this already exists; it
      just needs applying to the remaining arms.
- [ ] **Hands are broadcast to everyone.** The state snapshot ships the whole
      `GameState`, so every client receives every hand and the Tavern deck
      order. Anyone with devtools can read them. Needs per-seat redaction
      before send — still the largest outstanding change.
- [ ] **Rejected actions are silent.** The handler does `let _ = match &action`,
      so an `Err` is swallowed and the unchanged state is rebroadcast; the
      player sees a click that did nothing. Needs a `ServerMessage::Error`
      variant and a toast. Most rejections are now prevented client-side, so
      this is the edge-case path: races, replayed buffers, and any future
      client/server rule divergence.

### Gameplay / UX

- [ ] **New game should default to the host plus the most recently joined
      players.** Starting a new deal with a different player count works, but
      seat selection isn't ordered by join recency. `Member` has no join-order
      field yet; `host` was added for the host gate and the same approach would
      work here.
- [ ] **Hover the play area to see every play so far.** Done for the *current*
      enemy via `play_log`. Not done across the whole game — `game_log` has the
      data, it just isn't surfaced that way.
- [ ] **Draw animation**: cards slide from the Tavern deck into their sorted
      hand position.
- [ ] **Enemy defeat preview**: briefly show what the enemy was defeated with
      before cleanup. (`last_played` is already on the state.)

### Testing & infra

- [ ] **Socket handler has no tests.** Persistence helpers, `claim_seat`,
      `deal_new_game`, the host gate, `SetName` authorization and all of chat
      are covered now. `create_game`, `join_game_seat` and `handle_socket`
      itself are not.
- [ ] **Playwright needs a running backend.** The layout and join specs assume
      `localhost:3000` is up. Worth a fixture that boots the server.
- [ ] **Background-tab alert on mobile.** iOS suspends audio for backgrounded
      tabs, so the turn chime is inaudible there. The tab-title flash only helps
      on desktop; the Notifications API is the only thing that works unfocused.
- [ ] **Shared rule fixtures.** `frontend/src/gameLogic.ts` re-implements
      `is_valid_combo` / `attack_value` / clubs-doubling in TypeScript so the UI
      can grey out illegal cards. They agree today, and both files now warn
      about each other, but nothing enforces it — and because the server rejects
      silently, a divergence shows up as a button that does nothing. A shared
      table of cases exercised from both suites would close it.

## Done

### Rules engine

- [x] **Suit power order**: Hearts always resolves before Diamonds. The old
      comparator wasn't a total order, so a four-suit combo could draw from a
      deck it hadn't healed yet.
- [x] **Duplicate card indices rejected**: repeated indices removed *different*
      cards as the hand shifted, letting a client play cards it never selected.
- [x] **Rejected plays and discards restore the hand exactly**, at the original
      indices rather than appended to the end.
- [x] **Jester next-player choice** offered at every table size; two players was
      hardcoded to auto-advance, removing the legal "keep the turn" option.
- [x] **Jester goes to the play area**, not straight to the discard pile, so a
      Hearts heal can't recycle it mid-fight.
- [x] **Retroactive Jester powers restricted to Spades** — Hearts and Diamonds
      are one-shot effects that already resolved, and Clubs is explicitly not
      retroactive.
- [x] **Yield restriction**: no yielding once [rules wording removed].
- [x] **Loss check can't be skipped.** Every turn hand-off goes through
      `advance_turn`. A fully-shielded attack used to skip the discard step and
      with it the only loss check on that path, leaving a solo player with an
      empty hand, no Jesters and no game over.
- [x] **The full "can't play or yield" rule**, including an empty-handed player
      at a full table whose teammates have all just yielded.
- [x] **Solo Jester** refills to the hand limit, and spending the last one on an
      unpayable hit ends the game instead of softlocking.
- [x] **Random starting player**.
- [x] **Grouped play log** (`play_log`) and **whole-game log** (`game_log`,
      capped at 200 entries).
- [x] **A yield is recorded as a play**, so the board shows "Yield" instead of
      leaving the previous player's cards up.
- [x] `RULES_VERSION` at **4**; bump it for any rules or RNG change or stored
      histories replay differently.

### Server

- [x] **Spectators**: players beyond the seat count watch, and can chat.
- [x] **Host gate**: only the room's first-ever member may start a new deal.
- [x] **`SetName` is authorized against the socket's seat**, not a seat supplied
      in the message body.
- [x] **Chat**, riding inside the room snapshot (no new message type, no
      migration), capped at 100 messages / 300 chars, truncated by chars so
      multi-byte text can't panic.
- [x] **`Ping` keepalive is handled.** It had no enum arm, so it failed to parse
      and did nothing — and adding the variant had left the dispatch match
      non-exhaustive, which broke the build.
- [x] **`Room` derive restored.** An edit had stranded
      `#[derive(Serialize, Deserialize, Clone)]` above a `const`, dropping the
      traits that persistence depends on.
- [x] **Startup fails loudly** if the room table is unreadable, instead of
      starting empty and overwriting rooms that were merely unreadable. A single
      unparseable row is skipped and logged, and left in the database.
- [x] **`create_game` input validation**: a player count outside 1–4 panicked
      the handler.

### UI

- [x] **Fluid scaling**: card size derives from a `dvh` height budget with hand
      slots on `flex-basis: 0`. An 8-card solo hand used to overflow the screen
      by 39–50px on every common phone; cards now also grow on desktop instead
      of capping at 95px.
- [x] **`100dvh` + safe-area insets**: the footer no longer hides under mobile
      browser chrome or the home indicator.
- [x] **Fluid type ramp** with a 10px floor, replacing fixed 7/8/9/10px labels.
- [x] **In Play / Last Play visible on mobile** (were `hidden md:flex`).
- [x] **Last discarded shown**: the core had always tracked it; nothing rendered
      it.
- [x] **Spectators numbered among spectators**, not by raw seat — the first
      watcher at a 2-player table read as "Spectator 3".
- [x] **Back button returns to the game**, and "Menu" is now "Exit".
- [x] **Play-log popover stays on screen**; it was anchored to a narrow
      edge-hugging sidebar and ran off the viewport on phones.
- [x] **Turn chime actually sounds.** It was scheduled against a suspended audio
      context's frozen clock, and the context was never created from a user
      gesture, so on iOS it never unsuspended at all. Plus a mute toggle.
- [x] **Stale socket frames ignored** — an in-flight frame from a room you'd
      left could overwrite the one you'd just joined.
- [x] **Board transitions driven by the socket event**, not an effect watching
      state; the duplicate `gameState` copy is gone.
- [x] **Stationary hand**, **combat animations**, **defeat flight**, **discard
      "remaining" display**, **legible previews**, **full-width solo attack**.

### Tests & docs

- [x] Rust: 34 rules-engine tests; server tests for persistence, seats, host,
      `SetName`, chat and startup recovery.
- [x] Frontend: 31 unit tests (shared rules, reconnect, chime, spectator
      numbering, chat unread) and a Playwright layout spec.
- [x] **Flaky tests fixed**: several assumed player 0 starts, which stopped
      being true once the starting player became random, and one drew the immune
      Jack of Diamonds about one run in four.
- [x] **README** plus module docs on both crates, covering the invariants that
      aren't visible from the code: `RULES_VERSION`, `Room` vs `GameState`
      lifetimes, the single `state_json` column, idle shutdown, and identity
      coming from the socket rather than a payload.
- [x] Lint clean: 0 errors, 0 warnings.
