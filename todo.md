# King Killer Project TODOs

Merged from the original `todo.md` and `todo2.md`. Statuses below were checked
against the code rather than carried over, so a few entries that had been marked
open are now closed, and a couple that read as closed turned out to be partial.

## Open

### Gameplay / UX

- [ ] **Undo for moves that didn't reveal anything.** Decided: keep a
      snapshot of the state from before each move and restore it, rather
      than trying to reverse the move. That makes a Hearts play undoable
      even though it shuffles the discard pile into the Tavern - the new
      order is never shown to anyone, so nothing is learned. A move that
      *reveals* something must stay final: drawing cards (Diamonds, a
      refill), a new enemy coming up, or anything else that puts hidden
      cards face up. Notes for whoever builds it:
      - The snapshot has to include the RNG state, or undoing and replaying
        the same Hearts play would shuffle differently from the first time.
      - `game_history` must record the undo (e.g. an `Undo` action) so
        stored games still replay to the same result; bump `RULES_VERSION`
        if the replay rules change.
      - Decide who may undo (presumably only the player who moved, before
        the next player acts) and show it to the table.
- [ ] **Leaderboard.** Ranked with confidence intervals rather than raw win
      rate, so someone at 1 win in 1 game isn't on top - e.g. sort by the
      lower bound of the Wilson score interval. Requested shape:
      - Split by number of players (solo, 2, 3, 4).
      - For multiplayer, show both the best individual players and the best
        team combinations (the same set of people playing together).
      Open questions for whoever builds it:
      - **Identity.** There are no accounts: a name is free text per room and
        a seat token belongs to one room, so the same person isn't
        recognisable across games yet. Needs some lasting player identity
        (or an agreed rule such as matching by name) before anything can be
        counted.
      - **What counts as a game.** Results come from games reaching Won or
        Lost; decide about abandoned games, re-deals mid-game, and games
        where undo was used.
      - **Where results live.** A results table written when a game ends,
        rather than replaying `game_history`.
- [ ] **Confirm the turn chime on the reporter's own setup** (Linux, Brave).
      Nothing host-specific was found; the silent case was a page that hadn't
      been interacted with since it loaded, which now shows a "tap to turn on
      the turn sound" hint (Done, below). If it's still silent after tapping
      that, the cause is outside the page - Brave's site Sound/Autoplay
      settings, a muted tab, or the audio output.

### Testing & infra

- [ ] **Set the VAPID secrets on Fly** (`scripts/generate_vapid_keys.js`,
      then `fly secrets set` - see the README). Web Push is built but stays
      off until the server has a key.

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
- [x] **Yield restriction**: no yielding when every other player yielded
      on their most recent turn.
- [x] **Loss check can't be skipped.** Every turn hand-off goes through
      `advance_turn`. A fully-shielded attack used to skip the discard step and
      with it the only loss check on that path, leaving a solo player with an
      empty hand, no Jesters and no game over.
- [x] **The full "can't play or yield" rule**, including an empty-handed player
      at a full table whose teammates have all just yielded.
- [x] **Solo Jester** refills to the hand limit, and spending the last one on an
      unpayable hit ends the game instead of softlocking.
- [x] **Random starting player** for a fresh room's first deal.
- [x] **A re-deal seats the host plus the most recent arrivals.** `Member`
      gained `joined_seq`, and a new deal reassigns seats by host-then-recency
      instead of keeping whoever held the low seats - so someone who joined
      early and had been spectating no longer keeps a seat ahead of the person
      who just turned up to play. Seats move, identity doesn't: the token
      follows the member, and `RoomSnapshot::you` tells each connection its
      (possibly new) seat, which the client now trusts over the one it stored
      at join.
- [x] **The play popover can widen to the whole game**, not just the current
      enemy - `game_log` already held the data.
- [x] **A new deal (`NewGame`/`Reset`) starts with the player after whoever
      went first last time**, not the host every time and not re-rolled
      randomly. `GameState::new` always picks randomly, which - especially at
      a small table - lands on the same seat often enough to read as
      favoritism; `deal_new_game` now overrides it with an explicit rotation.
      Wraps around the table, including when it shrank past the previous
      starter's seat. Solo doesn't rotate (nothing to rotate to).
- [x] **The start rotation really rotates.** The item above read "who went
      first" from `current_player_index` at deal time - whoever's turn it
      happened to be when the host pressed New - so the next starter was
      effectively random. `Room::last_starter` now records the seat that went
      first (set on create and on every deal, and moved with its person by
      `reassign_seats`), and the next deal starts from the seat after it.
      (Also reported as "the starting player should rotate each round".)
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
- [x] **Seats are proven, not claimed.** `join`/`create` issue a 32-character
      secret stored on the `Member`; the socket presents it as `?token=...` and
      the server *derives* the seat from it. A seat number is public, so the
      previous `?seat=N` was self-asserted and every seat-based check was
      advisory. `RoomSnapshot` carries a separate `MemberView` type so the
      compiler prevents a token ever reaching a client.
- [x] **`create_game` and `join_game_seat` report why they failed**, not just a
      status code — a bad player count names the value, an unknown room code
      names the code — via a shared `api_error` helper, and the client reads
      the body (`readApiErrorMessage`) with a generic fallback if it's absent
      or unparseable. `get_game` (the anonymous read) got the same treatment.
- [x] **Rejected actions reach the player who sent them.** `apply_action`'s
      `Err` used to be swallowed with `let _ =`, leaving a click that did
      nothing with no explanation — most now-prevented client-side, but races,
      a stale selection, or a rule drifting between client and server still
      hit this path. `ServerMessage::Error` is sent only to the connection that
      triggered it (a private `mpsc` channel merged into that connection's send
      loop) rather than broadcast, since announcing someone's wrong guess to
      the whole table would be worse than the silence it replaces. Shown as a
      brief, auto-dismissing toast.
- [x] **Hands and deck order are redacted per seat.** The snapshot used to
      ship every hand and the Tavern order to every client; `get_game` handed
      them to an anonymous GET. Each connection now gets a view narrowed to its
      own seat: other hands and the Tavern deck become face-down placeholders
      (counts preserved, which is all the UI reads) and the castle deck is sent
      in canonical order so the next enemy isn't revealed.
- [x] **Turn actions are seat-checked.** `PlayCards` / `Yield` /
      `DiscardCards` / `ChooseNextPlayer` / `UseSoloJester` now require the
      connection's seat to be the one whose turn it is. The rules engine
      already stopped anyone acting *out of turn*, but any connected client
      could previously take the current player's turn *for* them.
      `should_apply` has no catch-all arm, so a new action has to state its own
      authorization instead of defaulting to allowed.
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
- [x] **A re-deal seats people who are actually connected.** Re-dealing a
      4-player game as 3 benched a player at the table and seated a member who
      wasn't there: members are never removed, a join without a saved token
      (another device, a private window) mints a new one, and the ordering
      was host-then-newest with no idea who was connected. `Room::live`
      (in memory, `serde(skip)`) counts open sockets per member token via a
      drop guard in `handle_socket`, and `reassign_seats` now orders host,
      then connected, then newest. Seats are compacted, so someone at seat 3
      of a 4-seat game moves into an empty player seat rather than being
      benched. (Also reported as "NewGame re-deals the same seat numbers".)
- [x] **An open connection follows its player to a new seat.** The socket
      resolved its seat once, on connect, so after a re-deal that moved seats
      every open connection was shown - and authorized as - whoever inherited
      its old seat number until it reconnected. It now looks the seat up from
      the token on every use, and authorizes and applies an action under one
      lock.
- [x] **Rooms persisted before seat tokens are playable again.** Their members
      load with an empty token, which authenticates nobody, so those seats were
      held forever. A joiner now reclaims one: a matching name takes that
      member's seat (and host flag) first, otherwise a genuinely free seat is
      preferred, and a legacy player seat is used before the joiner is made a
      spectator. The member is taken over in place with a fresh token.

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
- [x] **Draw animation**: a drawn card flies from the Tavern deck into its
      sorted hand slot, starting at the deck's size. Measured in a layout
      effect before paint; cards already in hand on first render (the deal, a
      reconnect) don't animate.
- [x] **Enemy defeat preview**: a "Defeated by" panel shows the killing play
      over the beaten enemy before its card flies to the pile (the hold is now
      1.1s, up from 0.45s). The board lags the server during that hold, so the
      in-play area still showed the old state and the winning cards were never
      seen.
- [x] **Turn alerts by Web Push, including iPhone.** When the turn reaches a
      player with no open connection (iOS closes a suspended page's socket),
      the server pushes through the platform's push service to the service
      worker. `king-killer-api/src/push.rs` implements RFC 8291 encryption and
      RFC 8292 VAPID on RustCrypto (no OpenSSL), checked byte for byte against
      `http_ece`. Subscriptions are per room and seat token, validated against
      a push-service allowlist (the server POSTs to them), persisted, never in
      snapshots, and dropped when the push service reports them gone. The app
      has a web manifest and icons so it can be added to the Home Screen, and
      iOS Safari players see a tip explaining that's how to get alerts.
- [x] **Empty hand slots are visible**: a dashed, lighter outline with a faint
      fill instead of a 30%-opacity border that vanished on the dark board.
- [x] **Raised cards no longer hide the discard count.** A selected card lifts
      16% of its height; on wide screens that pushed it over the status pill.
      `.hand-status` reserves the largest possible lift below the pill.
- [x] **Discarded and Last Play in a row on wide screens.** From 1024px both
      side columns are 240px (equal, so the enemy stays centred) and their card
      rows don't wrap; four cards fit on one line.
- [x] **Chat and the game log dock beside the board on wide screens.** From
      1280px they open in a column to the right of the board instead of
      covering it, both can be open at once (log above chat), and the game
      stays playable. The 📜/💬 buttons toggle and show when a panel is open.
      Narrower screens keep the full-screen overlays. `panels.spec.ts` checks
      the docked panels clear the board, a card can still be selected, and
      chat sends from the docked panel.
- [x] **Text fields don't trigger password managers.** A lone name box read
      as a username field. Every input spreads `NO_AUTOFILL`
      (`autocomplete="off"` plus the 1Password, LastPass, Bitwarden and
      Dashlane opt-outs, since managers ignore `autocomplete` alone). (Also
      reported as "the player name shouldn't be a username field".)
- [x] **"Tap to turn on the turn sound" hint.** Browsers only let a page play
      audio after it has been interacted with since it loaded, so after a
      reload, a reopened link or a discarded-and-restored tab the chime was
      silently swallowed until the player happened to click. The HUD now says
      so while audio is blocked; one tap unblocks it and rings to confirm. The
      unlock listener also stays armed, so audio the browser or OS suspends
      later comes back on the next tap. `turn-chime.spec.ts` checks every seat
      (host included) gets a chime per turn arrival, and the hint's behaviour
      under an emulated gesture policy (headless Chromium ignores the real one).
- [x] **Turn notifications for a hidden tab.** A HUD toggle asks for
      notification permission from the click itself; when the turn arrives
      while the page is hidden, a system notification is shown (one tag, so it
      replaces rather than stacks; cleared when the page is visible again).
      `public/sw.js` exists only because Chrome on Android shows notifications
      solely through a service worker - it has no fetch handler. Page-only, so
      it works on desktop and briefly on Android, not on iPhone (see Open).

### Tests & docs

- [x] Rust: 37 rules-engine tests + 3 shared-fixture tests; 71 server tests
      covering persistence, seats, legacy seat reclaim, host gating, `SetName`
      authorization, chat, startup recovery, seat reassignment, REST error
      responses, and the socket handler's authorization/dispatch decisions.
- [x] **Playwright starts its own servers.** A shared fixture
      (`frontend/tests/fixtures.ts`) boots a fresh API with a throwaway
      database for every test, automatically, and `webServer` starts or reuses
      Vite. `join` and `resume` lost their copies of the spawn code (`resume`
      uses the fixture's `stop()`/`restart()`). Specs run one at a time since
      each owns :3000.
- [x] **The HTTP and WebSocket layers are tested end to end.** `api_router`
      is split out of `main`; HTTP tests drive it with tower's `oneshot`
      (routing, body extraction, real status codes, redaction of an anonymous
      read), and socket tests serve it on an ephemeral port and connect with
      `tokio-tungstenite` (token-derived seat, per-seat redaction of the first
      frame, fan-out, sender-only errors, silent refusals, write-through to
      the database). Checked by breaking the first frame's redaction: the
      test fails.
- [x] Frontend: 71 unit tests (32 from the shared fixture, plus reconnect,
      chime, spectator numbering, chat unread, seat/observer state) and a
      Playwright layout spec.
- [x] **Flaky tests fixed**: several assumed player 0 starts, which stopped
      being true once the starting player became random, and one drew the immune
      Jack of Diamonds about one run in four.
- [x] **Shared rule fixtures.** `shared/rule-fixtures.json` holds 32 cases -
      attack values, combo legality, clubs doubling - read by *both*
      `king-killer-core/tests/shared_rules.rs` and
      `frontend/unit/sharedRules.test.ts`. The TypeScript mirror of the rules
      can no longer drift from the engine without a test failing (verified by
      deliberately breaking one side). `is_valid_combo` and
      `calculate_attack_value` became public associated functions to make this
      possible - both took `&self` and never used it.
- [x] **README** plus module docs on both crates, covering the invariants that
      aren't visible from the code: `RULES_VERSION`, `Room` vs `GameState`
      lifetimes, the single `state_json` column, idle shutdown, and identity
      coming from the socket rather than a payload.
- [x] Lint clean: 0 errors, 0 warnings.
