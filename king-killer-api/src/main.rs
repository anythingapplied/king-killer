//! King Killer game server: HTTP + WebSocket transport, SQLite persistence.
//!
//! # Rooms vs games
//!
//! A [`Room`] outlives any single deal. Members hold a `seat` and keep it
//! across re-deals, so `NewGame` can change the player count without anyone
//! losing their identity. Seats below the current player count are players;
//! seats at or above it are spectators.
//!
//! # Authority
//!
//! The socket authenticates with `?token=...`, the secret issued once by
//! `join`/`create`, and the seat is *derived* from it - a seat number is
//! public, so nothing a client asserts about which seat it holds is trusted.
//! That identity gates host-only actions (`NewGame`/`Reset`), acting as
//! yourself (`SetName`, `SendChat`) and taking your own turn, and it decides
//! how much of the state a connection is shown (see `redact_for`).
//!
//! Rejected actions are dropped *before* being timestamped, persisted, or
//! broadcast, and the client is not told. That is deliberate — the UI hides
//! or disables what you may not do — but it means a client/server rule
//! divergence looks like an unresponsive button, not an error.
//!
//! # Lifecycle
//!
//! The whole [`Room`] is serialized into `state_json` on every action, so new
//! room-level fields need `#[serde(default)]` but no migration. The process
//! exits after [`idle_timeout`] with no activity (scale-to-zero); clients
//! reconnect transparently and replay any buffered actions, so a shutdown
//! mid-game is invisible. Chat and game state therefore have to survive in the
//! database, not in memory.

use axum::{
    extract::Query,
    extract::{Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::services::{ServeDir, ServeFile};
use king_killer_core::{Card, GameState, Rank};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc};
use futures::{SinkExt, StreamExt};
use tower_http::cors::{Any, CorsLayer};
use rand::seq::IndexedRandom;
use rand::RngExt;

#[derive(Clone)]
struct AppState {
    rooms: Arc<RwLock<HashMap<String, Room>>>,
    broadcasts: Arc<RwLock<HashMap<String, broadcast::Sender<ServerMessage>>>>,
    last_activity: Arc<RwLock<Instant>>,
    db: SqlitePool,
}

/// A person attached to a room. Seats below the current game's player count
/// are that game's players; seats at or above it are spectators ("watching").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Member {
    seat: usize,
    name: String,
    /// True for whoever first joined this room. The host is the only member
    /// allowed to start a new deal (`NewGame`/`Reset`) — a spectator, or any
    /// later-joining player, could otherwise reset the table out from under
    /// everyone mid-game. `#[serde(default)]` keeps a room persisted before
    /// this field existed loadable, as `false`, i.e. no host.
    #[serde(default)]
    host: bool,
    /// Secret proving a connection owns this seat. Issued once by `join` (or
    /// `create`), stored by that client, and presented on the WebSocket.
    ///
    /// This is the only thing that makes a seat *yours*: a seat number is
    /// public, so before tokens a client could simply claim to be somebody
    /// else. Never leaves the server except in the one response that issues it
    /// — in particular `RoomSnapshot` carries [`MemberView`], not this.
    ///
    /// `#[serde(default)]` loads rooms persisted before tokens existed; an
    /// empty token matches nothing, so those members cannot be authenticated.
    /// Their player seats are reclaimed by the next joiner instead - see
    /// [`legacy_member_to_reclaim`].
    #[serde(default)]
    token: String,
    /// Monotonic per room, in the order members arrived. Used to pick who
    /// plays when a new deal has fewer seats than the room has people: the
    /// host, then the most recent arrivals. Seats can't stand in for this,
    /// since a re-deal reassigns them.
    #[serde(default)]
    joined_seq: u64,
}

/// The public face of a member: everything except the seat's secret.
///
/// Deliberately a separate type rather than `#[serde(skip)]` on the token —
/// the whole `Room` is serialized to `state_json` for persistence, so skipping
/// the field would silently stop saving it. This way the compiler enforces
/// that what goes to clients cannot carry it.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct MemberView {
    seat: usize,
    name: String,
    host: bool,
}

impl From<&Member> for MemberView {
    fn from(m: &Member) -> Self {
        MemberView { seat: m.seat, name: m.name.clone(), host: m.host }
    }
}

/// A seat secret. 32 chars from the same alphabet as room codes.
fn new_token() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rng();
    (0..32).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

/// The seat a connection is entitled to act as, proven by its token.
///
/// An absent, empty or unrecognised token is nobody: such a connection may
/// watch, but `should_apply` will refuse every action it sends.
fn seat_for_token(room: &Room, token: Option<&str>) -> Option<usize> {
    let token = token?;
    if token.is_empty() {
        return None;
    }
    room.members.iter().find(|m| m.token == token).map(|m| m.seat)
}

/// Room chat is capped: the whole room is serialized into `state_json` on
/// every action and pushed to every client in each snapshot, so an unbounded
/// backlog would grow both the DB row and every broadcast for the session.
const CHAT_CAP: usize = 100;
/// Per-message ceiling, applied in `chars` so a multi-byte message can never be
/// cut mid-codepoint (slicing bytes would panic).
const CHAT_MAX_LEN: usize = 300;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ChatMessage {
    /// Seat of the sender, taken from the socket's authenticated seat - never
    /// from the message body.
    seat: usize,
    /// The sender's current name. Stamped at send time and rewritten by
    /// `SetName`, so a rename is reflected across the whole log.
    name: String,
    text: String,
    /// Unix epoch millis. Clients format it; the server just stamps it.
    at: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A room is a persistent set of members plus the currently running game.
/// A room outlives any single deal: once a game finishes (or even mid-game), a
/// new deal with a different number of players can be started in the same room.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Room {
    id: String,
    members: Vec<Member>,
    game: GameState,
    /// Room-level, not game-level: chat survives a new deal. `#[serde(default)]`
    /// keeps rooms persisted before chat existed loadable.
    #[serde(default)]
    chat: Vec<ChatMessage>,
    /// Open WebSocket connections per member token, so a re-deal can tell who
    /// is actually here. Members are never removed, and a join without a saved
    /// token (another device, a private window, cleared storage) mints a new
    /// one - so the roster fills with seats nobody is sitting in.
    ///
    /// In memory only: after a restart nobody is connected until clients
    /// reconnect, which they do on their own.
    #[serde(skip)]
    live: HashMap<String, usize>,
}

impl Room {
    /// Whether this member has at least one open connection right now.
    fn is_live(&self, member: &Member) -> bool {
        !member.token.is_empty() && self.live.get(&member.token).is_some_and(|&n| n > 0)
    }

    /// Appends a chat message from `seat`.
    ///
    /// The sender must actually be in the roster - the seat arrives from a
    /// query param, so an arbitrary one must not be able to post. Empty or
    /// whitespace-only messages are dropped rather than stored.
    fn push_chat(&mut self, seat: usize, text: &str) {
        let Some(member) = self.members.iter().find(|m| m.seat == seat) else {
            return;
        };
        let name = member.name.clone();

        // `chars().take()` rather than byte slicing: `&text[..CHAT_MAX_LEN]`
        // panics if the boundary lands inside a multi-byte character.
        let text: String = text.trim().chars().take(CHAT_MAX_LEN).collect();
        if text.is_empty() {
            return;
        }

        self.chat.push(ChatMessage { seat, name, text, at: now_millis() });
        if self.chat.len() > CHAT_CAP {
            let excess = self.chat.len() - CHAT_CAP;
            self.chat.drain(0..excess);
        }
    }
}

/// What clients receive: the shared game plus the full room roster, so
/// spectators (members seated beyond the player count) are visible too.
#[derive(Clone, Serialize, Debug)]
struct RoomSnapshot {
    id: String,
    game: GameState,
    members: Vec<MemberView>,
    /// The receiving connection's own seat, or `None` for a spectator or an
    /// anonymous reader. Filled in per-connection by [`redact_for`].
    ///
    /// Without this the client only knows the seat it was given at join, which
    /// a re-deal can move - it would keep rendering someone else's position as
    /// its own. The server already resolves the seat from the token, so this
    /// just tells the client what the server already decided.
    you: Option<usize>,
    #[serde(default)]
    chat: Vec<ChatMessage>,
}

/// Stand-in for a card the viewer is not entitled to see.
///
/// Card ids are handed out in deck-construction order, so a real id identifies
/// a card as precisely as its face does — the placeholder takes a synthetic id
/// from the top of the range instead. Only the *count* of these ever reaches
/// the UI, and the id is derived from the position so a redacted snapshot is
/// byte-stable: the client compares snapshot JSON to decide whether anything
/// moved, and ids that churned would make every frame look like a change.
fn face_down(index: usize) -> Card {
    Card {
        suit: None,
        rank: Rank::Joker,
        id: u32::MAX - index as u32,
    }
}

/// The view of a room that `seat` is entitled to. `None` sees no hidden cards
/// at all, which is what an anonymous reader gets.
///
/// What is hidden, and why the UI doesn't miss it:
/// * **Other players' hands** — the client only ever reads `.length` for these
///   (the roster count and the draw-animation total).
/// * **Tavern deck** — the count is public; the order *is* the next few draws.
/// * **Castle deck order** — which enemies remain in the tier is public and the
///   UI shows them, but it filters and sorts them itself, so the shuffled order
///   (i.e. which enemy comes next) never needs to leave the server.
///
/// Note the seat is self-asserted on the WebSocket, so this defends against
/// reading another player's hand out of your own client — not against someone
/// deliberately connecting as a seat that isn't theirs. Closing that needs a
/// per-seat token issued at join; see todo.md.
fn redact_for(snapshot: &RoomSnapshot, seat: Option<usize>) -> RoomSnapshot {
    let mut view = snapshot.clone();
    view.you = seat;

    for (i, player) in view.game.players.iter_mut().enumerate() {
        if Some(i) != seat {
            player.hand = (0..player.hand.len()).map(face_down).collect();
        }
    }

    view.game.tavern_deck = (0..view.game.tavern_deck.len()).map(face_down).collect();

    // Sorting by id is a canonical order unrelated to the shuffle, so it
    // reveals nothing about draw order while keeping the tier strip intact.
    view.game.castle_deck.sort_by_key(|c| c.id);

    view
}

fn snapshot(room: &Room) -> RoomSnapshot {
    // Keep roster player names authoritative from the game state. Spectator
    // names live only in the members list, so they are untouched here.
    let mut members: Vec<MemberView> = room.members.iter().map(MemberView::from).collect();
    for (i, player) in room.game.players.iter().enumerate() {
        if let Some(m) = members.iter_mut().find(|m| m.seat == i) {
            m.name = player.name.clone();
        }
    }
    RoomSnapshot {
        id: room.id.clone(),
        game: room.game.clone(),
        members,
        // Filled in by redact_for, which is the only place that knows who is
        // being sent to.
        you: None,
        chat: room.chat.clone(),
    }
}

/// Deals a brand-new game with `num_players`, seeding each seat's name from the
/// room roster so returning players keep their identity across restarts.
/// Members seated past the new player count automatically become spectators.
/// Reassigns seats so a new deal seats the host plus the most recent arrivals.
///
/// A re-deal can have fewer seats than the room has people, and the old
/// behaviour just kept whoever happened to hold seats `0..player_count` -
/// so someone who joined early and had been spectating for hours stayed in,
/// while the person who arrived to play sat out.
///
/// Seats move, members don't: identity lives on the token, so a player keeps
/// their seat *token* and simply learns their new seat number from
/// `RoomSnapshot::you`.
fn reassign_seats(room: &mut Room, player_count: usize) {
    let mut order: Vec<usize> = (0..room.members.len()).collect();
    order.sort_by_key(|&i| {
        let m = &room.members[i];
        // Host first, then whoever is connected right now, then newest arrival
        // first. Recency alone let a member who had left - often a stale seat
        // from an earlier join on another device - outrank someone at the
        // table, who was then benched to watch. `!` puts true at 0; Reverse
        // makes a higher joined_seq sort earlier.
        (!m.host, !room.is_live(m), std::cmp::Reverse(m.joined_seq))
    });

    // Old seat -> new seat, built before anything moves.
    let mut moved: HashMap<usize, usize> = HashMap::new();
    for (position, &member_index) in order.iter().enumerate() {
        moved.insert(room.members[member_index].seat, position);
        room.members[member_index].seat = position;
    }

    // Chat outlives a deal, and every message records the seat that sent it.
    // Leaving those pointing at a seat number whose occupant just changed
    // would re-attribute old messages to whoever inherited the seat - the
    // client decides which messages are "yours" by exactly this comparison.
    // Keeping this pointer accurate is also what lets `SetName` rename an
    // author's past messages.
    for message in room.chat.iter_mut() {
        if let Some(&new_seat) = moved.get(&message.seat) {
            message.seat = new_seat;
        }
    }

    let _ = player_count; // seats above it are spectators by definition
}

fn deal_new_game(room: &mut Room, num_players: u32) {
    let player_count = num_players.clamp(1, 4) as usize;
    reassign_seats(room, player_count);
    let names: Vec<String> = (0..player_count)
        .map(|i| {
            room.members
                .iter()
                .find(|m| m.seat == i)
                .map(|m| m.name.clone())
                .unwrap_or_default()
        })
        .collect();

    // GameState::new() picks a random starting player every time, which
    // sends the same seat first often enough to read as favoritism (usually
    // seat 0 - the host - since that is the seat people notice). A new deal
    // instead rotates from whoever went first last game, so it visibly
    // advances around the table.
    //
    // Solo has no rotation (there's only one seat). The modulo below is
    // enough on its own if the table shrank past the previous starter's
    // seat - no explicit fallback needed, since "next seat after N" is
    // always in range for whatever the new player_count is.
    let previous_starter = room.game.current_player_index;
    let mut game = GameState::new(num_players.clamp(1, 4));
    if player_count > 1 {
        game.current_player_index = (previous_starter + 1) % player_count;
    }
    for (i, name) in names.into_iter().enumerate() {
        if let Some(p) = game.players.get_mut(i) {
            p.name = name;
        }
    }
    room.game = game;
}

/// Claims a seat for a new joiner. Prefers a random free player seat; when the
/// game is full the joiner watches instead, receiving a monotonic seat at or
/// above the player count. Returns the seat and whether it is a player seat.
/// Next arrival number for a room. Members are never removed, so this only
/// ever grows.
fn next_joined_seq(room: &Room) -> u64 {
    room.members.iter().map(|m| m.joined_seq).max().map_or(0, |max| max + 1)
}

/// Index of a legacy member this joiner should take over, if any.
///
/// Rooms persisted before seat tokens existed load their members with an empty
/// token, which authenticates nobody - so those player seats are held forever
/// by people who can never connect as them. Such a seat is up for grabs:
/// a joiner whose name matches the legacy member reclaims it first (that is
/// almost certainly the same person coming back), and otherwise any legacy
/// player seat is used before the joiner is turned into a spectator. A genuinely
/// free seat still wins over a non-matching legacy one, so a reclaim never
/// displaces a seat someone might still come back for when it isn't needed.
fn legacy_member_to_reclaim(room: &Room, name: Option<&str>, has_free_seat: bool) -> Option<usize> {
    let player_count = room.game.players.len();
    let is_legacy_player = |m: &Member| m.token.is_empty() && m.seat < player_count;

    let wanted = name.map(str::trim).filter(|n| !n.is_empty());
    if let Some(wanted) = wanted {
        if let Some(i) = room
            .members
            .iter()
            .position(|m| is_legacy_player(m) && m.name.trim().eq_ignore_ascii_case(wanted))
        {
            return Some(i);
        }
    }
    if has_free_seat {
        return None;
    }
    room.members.iter().position(is_legacy_player)
}

fn claim_seat(room: &mut Room, name: Option<String>) -> (usize, bool, String) {
    // Recorded before either branch pushes a Member, so it reflects the room
    // as it was before this join - i.e. whether anyone was here already.
    let is_first_ever_member = room.members.is_empty();
    let joined_seq = next_joined_seq(room);
    let player_count = room.game.players.len();
    let taken: HashSet<usize> = room.members.iter().map(|m| m.seat).collect();
    let free: Vec<usize> = (0..player_count).filter(|s| !taken.contains(s)).collect();

    if let Some(i) = legacy_member_to_reclaim(room, name.as_deref(), !free.is_empty()) {
        // Take over the legacy member in place: same seat, and the host flag
        // carries over so a migrated room keeps someone able to re-deal. It is
        // a fresh arrival as far as re-deal ordering is concerned.
        let token = new_token();
        let member = &mut room.members[i];
        member.token = token.clone();
        member.joined_seq = joined_seq;
        if let Some(provided_name) = name {
            member.name = provided_name.clone();
            if let Some(player) = room.game.players.get_mut(member.seat) {
                player.name = provided_name;
            }
        }
        return (member.seat, true, token);
    }

    if let Some(&seat) = free.choose(&mut rand::rng()) {
        let token = new_token();
        room.members.push(Member {
            seat,
            name: name.clone().unwrap_or_default(),
            host: is_first_ever_member,
            token: token.clone(),
            joined_seq,
        });
        if let Some(provided_name) = name {
            if let Some(player) = room.game.players.get_mut(seat) {
                player.name = provided_name;
            }
        }
        (seat, true, token)
    } else {
        // All player seats are taken: this member watches the game.
        let seat = room.members.iter().map(|m| m.seat).max().map_or(player_count, |m| m + 1);
        let token = new_token();
        room.members.push(Member {
            seat,
            name: name.unwrap_or_default(),
            host: is_first_ever_member,
            token: token.clone(),
            joined_seq,
        });
        (seat, false, token)
    }
}

fn idle_timeout() -> Duration {
    let minutes = std::env::var("IDLE_TIMEOUT_MINUTES")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(2.0);
    Duration::from_secs((minutes * 60.0).max(1.0) as u64)
}

fn touch(last_activity: &Arc<RwLock<Instant>>) {
    *last_activity.write().unwrap() = Instant::now();
}

fn generate_game_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::rng();
    (0..6).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

/// Seats 0..player_count are game players; this writes the occupied masks for
/// the legacy column (kept for compatibility with existing snapshots).
fn occupied_seats_json(room: &Room) -> String {
    let occupied: Vec<bool> = (0..room.game.players.len())
        .map(|i| room.members.iter().any(|m| m.seat == i))
        .collect();
    serde_json::to_string(&occupied).unwrap()
}

async fn persist_room(db: &SqlitePool, room: &Room) {
    let room_json = serde_json::to_string(room).unwrap();
    let _ = sqlx::query(
        "INSERT INTO games (id, state_json, occupied_seats, updated_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP) \
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, occupied_seats = excluded.occupied_seats, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(&room.id)
    .bind(&room_json)
    .bind(&occupied_seats_json(room))
    .execute(db)
    .await;
}

async fn record_history(db: &SqlitePool, game_id: &str, action_type: &str, action: &GameAction, game: &GameState) {
    let action_json = serde_json::to_string(action).unwrap();
    let _ = sqlx::query(
        "INSERT INTO game_history (game_id, action_type, action_json, seed, version) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(game_id)
    .bind(action_type)
    .bind(&action_json)
    .bind(game.seed as i64)
    .bind(game.version as i64)
    .execute(db)
    .await;
}

/// Loads every persisted room at startup.
///
/// The query is allowed to panic. Failing it means the database is unreadable
/// as a whole - and starting anyway is worse than not starting, because the
/// server would come up believing it has no rooms and `persist_room`'s
/// `ON CONFLICT DO UPDATE` would then overwrite rooms that were merely
/// unreadable. A transient read failure would become permanent data loss.
/// Every other startup step (data dir, pool, migrations) already `expect`s.
///
/// An individual row is different: one unparseable room must not stop the
/// server, so it is skipped - but loudly. The silent version hid a nasty
/// failure mode: adding a required (non-`serde(default)`) field to `Room`
/// makes every stored room fail this parse, fall through the legacy branch,
/// and vanish on the next boot with nothing in the logs.
async fn load_rooms(db: &SqlitePool) -> HashMap<String, Room> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, state_json, occupied_seats FROM games")
            .fetch_all(db)
            .await
            .expect("Failed to load rooms from the database");

    let mut rooms = HashMap::new();
    let mut skipped = 0usize;
    for (id, state_json, seats_json) in rows {
        if let Ok(room) = serde_json::from_str::<Room>(&state_json) {
            rooms.insert(id, room);
        } else if let Ok(game) = serde_json::from_str::<GameState>(&state_json) {
            // Legacy snapshot (pre-room): rebuild the roster from the seat map.
            let seats: Vec<bool> = serde_json::from_str(&seats_json)
                .unwrap_or_else(|_| game.players.iter().map(|p| !p.name.is_empty()).collect());
            let members = game
                .players
                .iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    seats.get(i).copied().unwrap_or(false).then_some((i, p))
                })
                // The lowest occupied seat becomes host. These rooms predate the
                // host field entirely, so there is no real "who joined first" to
                // recover - this just picks a consistent, non-arbitrary member
                // rather than leaving every migrated room without a host (and
                // therefore unable to ever start a new deal).
                .enumerate()
                .map(|(order, (i, p))| Member {
                    seat: i,
                    name: p.name.clone(),
                    host: order == 0,
                    // Predates tokens; nobody can authenticate as these seats.
                    // A joiner reclaims them - see legacy_member_to_reclaim.
                    token: String::new(),
                    // No arrival order was recorded; seat order is the only
                    // approximation available.
                    joined_seq: i as u64,
                })
                .collect();
            rooms.insert(
                id.clone(),
                Room {
                    id,
                    members,
                    game,
                    chat: Vec::new(),
                    live: HashMap::new(),
                },
            );
        } else {
            // Neither a Room nor a legacy GameState. Keep serving the rooms
            // that did load, but never drop one without saying so - the row
            // itself is left untouched in the database for inspection.
            skipped += 1;
            tracing::error!(
                room_id = %id,
                "could not deserialize stored room; skipping it. The row is left \
                 in the database. If this fires for every room, a required field \
                 was probably added to Room without #[serde(default)]."
            );
        }
    }
    if skipped > 0 {
        tracing::error!("skipped {} unreadable room(s) at startup", skipped);
    }
    rooms
}

/// Every API and socket route, without the static-file fallback. Split out of
/// `main` so tests can drive the real routing, extraction and status codes -
/// not just call the handler functions - and stand the socket up on a port.
fn api_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/game", post(create_game))
        .route("/api/game/{id}", get(get_game))
        .route("/api/game/{id}/join", post(join_game_seat))
        .route("/api/ws/{id}", get(ws_handler))
        .layer(cors)
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");
    let db_url = format!("sqlite:{}/kingkiller.db?mode=rwc", data_dir);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .expect("Failed to connect to SQLite");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    let loaded_rooms = load_rooms(&pool).await;
    tracing::info!("loaded {} rooms from database", loaded_rooms.len());

    let mut broadcasts = HashMap::new();
    for id in loaded_rooms.keys() {
        let (tx, _) = broadcast::channel(100);
        broadcasts.insert(id.clone(), tx);
    }

    let state = AppState {
        rooms: Arc::new(RwLock::new(loaded_rooms)),
        broadcasts: Arc::new(RwLock::new(broadcasts)),
        last_activity: Arc::new(RwLock::new(Instant::now())),
        db: pool,
    };

    let idle_check_state = state.clone();
    tokio::spawn(async move {
        let timeout = idle_timeout();
        let mut check = tokio::time::interval(Duration::from_secs(5));
        loop {
            check.tick().await;
            let idle = idle_check_state.last_activity.read().unwrap().elapsed();
            if idle >= timeout {
                tracing::info!("idle for {:.0?}, shutting down", timeout);
                std::process::exit(0);
            }
        }
    });

    let dist_dir = std::env::var("DIST_DIR").unwrap_or_else(|_| "frontend/dist".to_string());
    let app = api_router(state).fallback_service(
        ServeDir::new(&dist_dir)
            .not_found_service(ServeFile::new(format!("{dist_dir}/index.html"))),
    );

    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.unwrap();
    tracing::info!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

#[derive(Serialize, Deserialize)]
struct CreateGameRequest {
    num_players: u32,
    player_name: Option<String>,
}

#[derive(Serialize, Debug)]
struct GameResponse {
    id: String,
    state: RoomSnapshot,
    /// The creator's seat-0 token, issued here and nowhere else.
    token: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum GameAction {
    /// Keepalive from the client, sent every 30s. Deliberately does NOT refresh
    /// the idle timer: the server is meant to scale to zero while nobody is
    /// actually playing, and the client reconnects transparently. It only keeps
    /// the socket itself from being dropped by an intermediary.
    Ping,
    PlayCards { indices: Vec<usize> },
    Yield,
    DiscardCards { indices: Vec<usize> },
    ChooseNextPlayer { index: usize },
    UseSoloJester,
    Reset,
    NewGame { num_players: u32 },
    SetName { seat: usize, name: String },
    /// Carries no seat: the sender is taken from the socket's authenticated
    /// seat, so a client cannot post as anyone but itself.
    SendChat { text: String },
}

/// Error body for a failed REST call, so a non-2xx status carries the same
/// kind of explanation `ServerMessage::Error` already gives on the socket -
/// the reason a request was refused, not just that it was.
#[derive(Serialize, Debug)]
struct ApiError {
    message: String,
}

impl ApiError {
    fn new(message: impl Into<String>) -> Self {
        ApiError { message: message.into() }
    }
}

/// (status, body) - the ergonomic axum return shape for a REST error.
type ApiErrorResponse = (axum::http::StatusCode, Json<ApiError>);

fn api_error(status: axum::http::StatusCode, message: impl Into<String>) -> ApiErrorResponse {
    (status, Json(ApiError::new(message)))
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
enum ServerMessage {
    State(RoomSnapshot),
    /// Sent only to the connection whose action was rejected — never
    /// broadcast, so a refused action isn't announced to the whole table.
    /// Carries the `Err` string `apply_action` returns; the outer field names
    /// the action that failed, since the client can have several pending.
    Error { action: &'static str, message: String },
}

async fn create_game(
    State(state): State<AppState>,
    Json(payload): Json<CreateGameRequest>,
) -> Result<Json<GameResponse>, ApiErrorResponse> {
    if !(1..=4).contains(&payload.num_players) {
        return Err(api_error(
            axum::http::StatusCode::BAD_REQUEST,
            format!("num_players must be 1-4, got {}", payload.num_players),
        ));
    }

    touch(&state.last_activity);
    let mut id = generate_game_code();
    {
        let rooms = state.rooms.read().unwrap();
        while rooms.contains_key(&id) {
            id = generate_game_code();
        }
    }

    // Already validated above; num_players is known to be 1-4 here.
    let mut game = GameState::new(payload.num_players);
    let mut members = Vec::new();
    if let Some(name) = &payload.player_name {
        if let Some(player) = game.players.first_mut() {
            player.name = name.clone();
        }
    }
    let creator_token = new_token();
    members.push(Member {
        seat: 0,
        name: game.players[0].name.clone(),
        host: true, // the room's creator is its first-ever member
        token: creator_token.clone(),
        joined_seq: 0,
    });

    let room = Room {
        id: id.clone(),
        members,
        game,
        chat: Vec::new(),
        live: HashMap::new(),
    };
    state.rooms.write().unwrap().insert(id.clone(), room.clone());
    persist_room(&state.db, &room).await;

    let (tx, _) = broadcast::channel(100);
    state.broadcasts.write().unwrap().insert(id.clone(), tx);

    // Seat 0 is the creator's, assigned here rather than claimed by them.
    Ok(Json(GameResponse {
        id,
        state: redact_for(&snapshot(&room), Some(0)),
        token: creator_token,
    }))
}

#[derive(Serialize, Deserialize)]
struct JoinRequest {
    name: Option<String>,
}

#[derive(Serialize, Debug)]
struct JoinResponse {
    seat_index: usize,
    /// The seat's secret. The client stores it and presents it on the socket;
    /// this response is the only time the server ever sends it.
    token: String,
    /// True when all player seats were taken and this member got a spectator
    /// seat (they can watch but not act).
    spectator: bool,
}

async fn join_game_seat(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<JoinRequest>,
) -> Result<Json<JoinResponse>, ApiErrorResponse> {
    let response = {
        let mut rooms = state.rooms.write().unwrap();
        let room = rooms.get_mut(&id).ok_or_else(|| {
            api_error(
                axum::http::StatusCode::NOT_FOUND,
                format!("No game with code {id}"),
            )
        })?;
        let (seat, is_player, token) = claim_seat(room, payload.name);
        let response = JoinResponse {
            seat_index: seat,
            token,
            spectator: !is_player,
        };
        (response, room.clone())
    };

    persist_room(&state.db, &response.1).await;
    touch(&state.last_activity);
    Ok(Json(response.0))
}

async fn get_game(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<RoomSnapshot>, ApiErrorResponse> {
    let rooms = state.rooms.read().unwrap();
    if let Some(room) = rooms.get(&id) {
        touch(&state.last_activity);
        // No caller identity on this route at all, so it gets the
        // everyone-can-see view. A resuming player's own hand arrives on the
        // socket a moment later, redacted for their seat.
        Ok(Json(redact_for(&snapshot(room), None)))
    } else {
        Err(api_error(
            axum::http::StatusCode::NOT_FOUND,
            format!("No game with code {id}"),
        ))
    }
}

#[derive(Deserialize)]
struct WsParams {
    /// The seat secret issued by `join`/`create`.
    ///
    /// The seat itself is *derived* from this rather than sent alongside it:
    /// a seat number is public, so anything the client asserts about which
    /// seat it holds is worthless. An absent or unrecognised token connects
    /// as nobody - able to watch, refused every action.
    token: Option<String>,
}

/// Whether a frame should be applied to the room at all.
///
/// Identity comes from the socket's authenticated `seat`, never from anything
/// in the message body — a client may not nominate who it is acting as.
/// Everything this rejects is dropped before being timestamped, persisted or
/// broadcast, so a refused frame leaves no trace at all.
///
/// Pure so it can be tested without standing up a WebSocket.
fn should_apply(action: &GameAction, seat: Option<usize>, room: Option<&Room>) -> bool {
    match action {
        // A keepalive is not an action: no state change, no history, no
        // broadcast. Rejecting it here keeps the caller to a single check.
        GameAction::Ping => false,
        // Only the room's host may start a new deal - otherwise a spectator or
        // any later-joining player could reset the table mid-game.
        GameAction::NewGame { .. } | GameAction::Reset => seat.is_some_and(|s| {
            room.is_some_and(|r| r.members.iter().any(|m| m.seat == s && m.host))
        }),
        // You may only rename the seat you connected as.
        GameAction::SetName { seat: requested, .. } => seat == Some(*requested),
        // Turn actions belong to whoever's turn it is. The rules engine already
        // enforces that a turn action resolves against `current_player_index`,
        // so nobody could act *out of turn* - but without this check any
        // connected client could take the current player's turn *for* them,
        // playing their cards or yielding on their behalf.
        GameAction::PlayCards { .. }
        | GameAction::Yield
        | GameAction::DiscardCards { .. }
        | GameAction::ChooseNextPlayer { .. }
        | GameAction::UseSoloJester => seat
            .is_some_and(|s| room.is_some_and(|r| r.game.current_player_index == s)),
        // Anyone seated in the room may chat, spectators included. The sender is
        // taken from the socket seat in apply_action, so there is nothing to
        // spoof; a seatless connection is refused here so it can't cause a
        // pointless history row, persist and broadcast for a message that
        // apply_action would then drop.
        GameAction::SendChat { .. } => seat.is_some(),
        // Deliberately no catch-all: a new action must state its own
        // authorization rather than defaulting to "allowed".
    }
}

/// Label stored in `game_history.action_type`.
fn action_type(action: &GameAction) -> &'static str {
    match action {
        GameAction::Ping => "ping",
        GameAction::PlayCards { .. } => "play_cards",
        GameAction::Yield => "yield",
        GameAction::DiscardCards { .. } => "discard_cards",
        GameAction::ChooseNextPlayer { .. } => "choose_next_player",
        GameAction::UseSoloJester => "use_solo_jester",
        GameAction::Reset => "reset",
        GameAction::NewGame { .. } => "new_game",
        GameAction::SetName { .. } => "set_name",
        GameAction::SendChat { .. } => "send_chat",
    }
}

/// Applies an already-authorized action to the room.
///
/// `seat` is the socket's authenticated seat, used for actions that act *as*
/// the caller. The `Result` is currently discarded by the caller, but it is
/// returned rather than swallowed here so the planned `ServerMessage::Error`
/// has something to report.
fn apply_action(room: &mut Room, action: &GameAction, seat: Option<usize>) -> Result<(), String> {
    match action {
        GameAction::PlayCards { indices } => room.game.play_cards(indices.clone()),
        GameAction::Yield => room.game.yield_turn(),
        GameAction::DiscardCards { indices } => room.game.discard_cards(indices.clone()),
        GameAction::ChooseNextPlayer { index } => room.game.choose_next_player(*index),
        GameAction::UseSoloJester => room.game.use_solo_jester(),
        GameAction::Reset => {
            deal_new_game(room, room.game.players.len() as u32);
            Ok(())
        }
        GameAction::NewGame { num_players } => {
            deal_new_game(room, *num_players);
            Ok(())
        }
        GameAction::SetName { seat, name } => {
            if let Some(player) = room.game.players.get_mut(*seat) {
                player.name = name.clone();
            }
            if let Some(member) = room.members.iter_mut().find(|m| m.seat == *seat) {
                member.name = name.clone();
            }
            // Chat names follow the author, so a rename shows on their past
            // messages too. `message.seat` tracks the author across re-deals
            // (see reassign_seats), so it identifies them reliably.
            for message in room.chat.iter_mut().filter(|m| m.seat == *seat) {
                message.name = name.clone();
            }
            Ok(())
        }
        GameAction::SendChat { text } => {
            // Sender comes from the socket, never the body. A connection with
            // no seat cannot post.
            if let Some(sender_seat) = seat {
                room.push_chat(sender_seat, text);
            }
            Ok(())
        }
        // Rejected by should_apply before reaching here; the arm keeps the
        // match total so adding a variant can't silently break the build.
        GameAction::Ping => Ok(()),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, id, params.token, state))
}

/// Counts one open connection toward its member's `Room::live` for as long as
/// it exists. Dropping it (however `handle_socket` ends) takes the count back.
struct LiveGuard {
    rooms: Arc<RwLock<HashMap<String, Room>>>,
    room_id: String,
    token: String,
}

impl LiveGuard {
    fn new(rooms: &Arc<RwLock<HashMap<String, Room>>>, room_id: &str, token: &str) -> Self {
        if let Some(room) = rooms.write().unwrap().get_mut(room_id) {
            *room.live.entry(token.to_string()).or_insert(0) += 1;
        }
        LiveGuard { rooms: rooms.clone(), room_id: room_id.to_string(), token: token.to_string() }
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        // A poisoned lock means the server is already failing; don't panic
        // again inside a destructor.
        let Ok(mut rooms) = self.rooms.write() else { return };
        if let Some(room) = rooms.get_mut(&self.room_id) {
            if let Some(n) = room.live.get_mut(&self.token) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    room.live.remove(&self.token);
                }
            }
        }
    }
}

async fn handle_socket(socket: WebSocket, id: String, token: Option<String>, state: AppState) {
    // Resolve identity once, from the token. Seats never move between members,
    // so this stays valid for the life of the connection.
    let seat = {
        let rooms = state.rooms.read().unwrap();
        rooms.get(&id).and_then(|room| seat_for_token(room, token.as_deref()))
    };
    // Held until this function returns, i.e. for the life of the connection.
    // Only an authenticated member counts; an observer isn't anyone to seat.
    let _live = seat.and(token.as_deref()).map(|t| LiveGuard::new(&state.rooms, &id, t));
    touch(&state.last_activity);
    let rx = {
        let broadcasts = state.broadcasts.read().unwrap();
        if let Some(tx) = broadcasts.get(&id) {
            tx.subscribe()
        } else {
            return;
        }
    };

    let (mut sender, mut receiver) = socket.split();

    // Errors are this connection's alone, so they need a path the shared
    // broadcast channel can't provide - it fans one message out to every seat,
    // and a rejection announced to the whole table would out a bad guess, a
    // stale click, or a lost race to everyone else at it.
    let (err_tx, mut err_rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Push the current room immediately so a newly-connected client renders.
    let initial = {
        let rooms = state.rooms.read().unwrap();
        rooms.get(&id).map(snapshot)
    };
    if let Some(snap) = initial {
        let msg = serde_json::to_string(&ServerMessage::State(redact_for(&snap, seat))).unwrap();
        if sender.send(Message::Text(msg.into())).await.is_err() {
            return;
        }
    }

    let mut rx = rx;
    let mut send_task = tokio::spawn(async move {
        loop {
            // A private error and a room update can arrive at the same instant
            // (a rejected action still triggers no broadcast, but an unrelated
            // action from another player might land right after); select! picks
            // whichever is ready without starving the other.
            let outgoing = tokio::select! {
                biased;
                Some(err) = err_rx.recv() => Some(err),
                room_state = rx.recv() => match room_state {
                    Ok(ServerMessage::State(snap)) => {
                        // The channel carries one unredacted snapshot; each
                        // connection narrows it before serializing.
                        Some(ServerMessage::State(redact_for(&snap, seat)))
                    }
                    Ok(ServerMessage::Error { .. }) => None, // never broadcast; unreachable
                    // Fell behind and missed some updates - not fatal. The very
                    // next State message carries the room's current shape in
                    // full, so recovery is automatic; only Closed ends the
                    // connection. A pattern of Ok(_)/Err(Lagged)/else here
                    // previously broke the socket on this, since neither branch
                    // matched and it fell to the else arm below.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => None,
                },
                else => None,
            };
            let Some(outgoing) = outgoing else { break };
            let msg = serde_json::to_string(&outgoing).unwrap();
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let state_recv = state.clone();
    let recv_err_tx = err_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        let err_tx = recv_err_tx;
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            if let Ok(action) = serde_json::from_str::<GameAction>(&text) {
                // Authorization and dispatch both live in pure functions above,
                // so the handler itself is only frames, locks and I/O.
                let authorized = {
                    let rooms = state_recv.rooms.read().unwrap();
                    should_apply(&action, seat, rooms.get(&id))
                };
                if !authorized {
                    // Distinct from a rejection inside apply_action: this is a
                    // permission the player was never going to have (someone
                    // else's turn, a non-host trying to redeal), not a mistake
                    // in a legal attempt, so it's left silent rather than
                    // narrating what the UI already hides or disables.
                    continue;
                }

                let type_label = action_type(&action);

                let (room, result) = {
                    let mut rooms = state_recv.rooms.write().unwrap();
                    match rooms.get_mut(&id) {
                        Some(room) => {
                            let result = apply_action(room, &action, seat);
                            (Some(room.clone()), result)
                        }
                        None => (None, Err("Room no longer exists".to_string())),
                    }
                };

                if let Err(message) = result {
                    // The player attempted something legal-looking that the
                    // rules engine refused - e.g. a combo that isn't valid, an
                    // insufficient discard. Reported only to them: broadcasting
                    // it would announce a wrong guess to the whole table.
                    let _ = err_tx.send(ServerMessage::Error { action: type_label, message });
                }

                if let Some(room) = room {
                    record_history(&state_recv.db, &id, type_label, &action, &room.game).await;
                    persist_room(&state_recv.db, &room).await;

                    let broadcasts = state_recv.broadcasts.read().unwrap();
                    if let Some(tx) = broadcasts.get(&id) {
                        // Unredacted on purpose: one snapshot goes onto the
                        // channel and each connection's send task narrows it to
                        // its own seat. Redacting here would flatten everyone's
                        // view to a single seat's.
                        let _ = tx.send(ServerMessage::State(snapshot(&room)));
                    }
                    touch(&state_recv.last_activity);
                }
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use king_killer_core::Suit;

    // A single-connection in-memory pool keeps the same SQLite database alive
    // for the whole test (each :memory: connection would otherwise be its own DB).
    async fn test_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn persist_and_reload_roundtrip() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // A 2-player room with a NAMELESS creator (the resume case), a joiner,
        // a spectator, and an in-progress game must survive a reload unchanged.
        let mut game = GameState::new(2);
        let _ = game.play_cards(vec![game.current_player_index]);
        let room = Room {
            id: "TEST01".to_string(),
            members: vec![
                Member { seat: 0, name: String::new(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Carl".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 },
            ],
            game,
            chat: Vec::new(),
            live: HashMap::new(),
        };

        persist_room(&pool, &room).await;

        // Simulate a server restart: everything must be reconstructed from the DB.
        let loaded = load_rooms(&pool).await;
        let from_db = loaded.get("TEST01").expect("room must be loaded");
        // Members (including spectators) persist across a restart...
        assert_eq!(
            serde_json::to_string(&room.members).unwrap(),
            serde_json::to_string(&from_db.members).unwrap()
        );
        // ...along with the game state.
        assert_eq!(
            serde_json::to_string(&room.game).unwrap(),
            serde_json::to_string(&from_db.game).unwrap()
        );

        // A later action must also survive a reload unchanged.
        let mut room = room;
        room.game.discard_cards(vec![0]).unwrap_or_default();
        persist_room(&pool, &room).await;
        let loaded = load_rooms(&pool).await;
        assert_eq!(
            serde_json::to_string(&room.game).unwrap(),
            serde_json::to_string(&loaded.get("TEST01").unwrap().game).unwrap()
        );
    }

    #[tokio::test]
    async fn legacy_snapshot_migrates_to_room() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // A pre-room snapshot stores only the GameState JSON plus a seat map.
        let mut game = GameState::new(3);
        game.players[0].name = "Host".to_string();
        let state_json = serde_json::to_string(&game).unwrap();
        let seats = serde_json::to_string(&vec![true, false, true]).unwrap();
        let _ = sqlx::query("INSERT INTO games (id, state_json, occupied_seats) VALUES (?1, ?2, ?3)")
            .bind("LEGACY")
            .bind(&state_json)
            .bind(&seats)
            .execute(&pool)
            .await;

        let loaded = load_rooms(&pool).await;
        let room = loaded.get("LEGACY").expect("legacy room must load");
        // Seat 0 (named) and seat 2 (nameless but claimed) are members; seat 1
        // was never claimed and stays free for a future joiner.
        assert_eq!(room.members.len(), 2);
        assert_eq!(room.members[0].name, "Host");
        assert_eq!(room.members[1].seat, 2);
    }

    #[tokio::test]
    async fn an_unreadable_row_is_skipped_without_taking_the_others_with_it() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        // One row that is neither a Room nor a legacy GameState.
        let _ = sqlx::query("INSERT INTO games (id, state_json, occupied_seats) VALUES (?1, ?2, ?3)")
            .bind("BROKEN")
            .bind("{\"not\":\"a room\"}")
            .bind("[]")
            .execute(&pool)
            .await;

        // ...alongside a perfectly good one.
        let good = Room {
            id: "GOOD01".to_string(),
            members: vec![Member { seat: 0, name: "Alice".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 }],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        persist_room(&pool, &good).await;

        let loaded = load_rooms(&pool).await;
        assert!(loaded.contains_key("GOOD01"), "a bad row must not block good ones");
        assert!(!loaded.contains_key("BROKEN"));
        assert_eq!(loaded.len(), 1);

        // The row is skipped in memory, not deleted: it stays available for
        // inspection rather than being quietly destroyed on startup.
        let (still_there,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM games WHERE id = 'BROKEN'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(still_there, 1);
    }

    #[tokio::test]
    async fn claim_seat_prefers_players_then_spectators() {
        let mut room = Room {
            id: "SEATS".to_string(),
            members: vec![Member { seat: 0, name: "Host".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 }],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        let (bob, bob_player, _) = claim_seat(&mut room, Some("Bob".to_string()));
        assert_eq!(bob, 1);
        assert!(bob_player);

        assert_eq!(room.members.len(), 2);
        assert_eq!(room.game.players[1].name, "Bob");

        // Game is full now: the next joiner watches.
        let (carol, carol_player, _) = claim_seat(&mut room, Some("Carol".to_string()));
        assert_eq!(carol, 2);
        assert!(!carol_player);
        assert_eq!(room.members.len(), 3);
        // Spectators are not game players.
        assert!(room.game.players.iter().all(|p| p.name != "Carol"));
    }

    #[tokio::test]
    async fn deal_new_game_keeps_names_and_moves_extra_members_to_watch() {
        let mut room = Room {
            id: "RESTART".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Carol".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        // Shrink to two players. Seats are reassigned by host-then-recency, so
        // Carol (the latest arrival) plays and Bob moves to a spectator seat -
        // this test previously asserted the opposite, back when a re-deal just
        // kept whoever happened to hold the low seats.
        deal_new_game(&mut room, 2);
        assert_eq!(room.game.players.len(), 2);
        assert_eq!(room.game.players[0].name, "Host");
        assert_eq!(room.game.players[1].name, "Carol");
        // Nobody is dropped from the roster; the displaced member watches.
        assert!(room.members.iter().any(|m| m.seat == 2 && m.name == "Bob"));
        assert_eq!(room.members.len(), 3);
    }

    #[tokio::test]
    async fn a_new_deal_starts_with_the_player_after_whoever_went_first_last_time() {
        let mut room = Room {
            id: "ROTATE".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Carol".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        room.game.current_player_index = 1; // Bob went first last time

        deal_new_game(&mut room, 3);
        assert_eq!(room.game.current_player_index, 2, "Carol follows Bob");

        room.game.current_player_index = 2; // wrap around
        deal_new_game(&mut room, 3);
        assert_eq!(room.game.current_player_index, 0, "wraps back to the host");
    }

    #[tokio::test]
    async fn rotation_stays_in_range_if_the_table_shrank_past_the_last_starter() {
        // The modulo in deal_new_game means "the next seat after the previous
        // starter" is always well-defined in the *new* table, even when that
        // exact seat no longer exists - (2 + 1) % 2 is 1, not an out-of-range
        // 3. Nothing needs an explicit fallback; this pins that the formula
        // alone is enough.
        let mut room = Room {
            id: "SHRINK".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Carol".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        room.game.current_player_index = 2; // Carol went first

        deal_new_game(&mut room, 2); // Carol's own seat no longer exists

        assert_eq!(room.game.current_player_index, 1, "wraps within the new, smaller table");
        assert!(room.game.current_player_index < room.game.players.len());
    }

    #[tokio::test]
    async fn solo_deals_do_not_rotate() {
        let mut room = Room {
            id: "SOLOROT".to_string(),
            members: vec![Member { seat: 0, name: "Alone".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 }],
            game: GameState::new(1),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        deal_new_game(&mut room, 1);
        assert_eq!(room.game.current_player_index, 0, "there is only one seat to rotate to");
    }

    /// A minimal AppState for calling handlers directly, without a router.
    async fn test_state() -> AppState {
        let db = test_pool().await;
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        AppState {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            broadcasts: Arc::new(RwLock::new(HashMap::new())),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            db,
        }
    }

    #[tokio::test]
    async fn create_game_rejects_a_bad_player_count_with_a_reason() {
        let state = test_state().await;
        let payload = CreateGameRequest { num_players: 0, player_name: None };
        let err = create_game(State(state), Json(payload)).await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);
        assert!(err.1.0.message.contains('0'), "the offending value appears in the message");
    }

    #[tokio::test]
    async fn create_game_rejects_five_players_too() {
        let state = test_state().await;
        let payload = CreateGameRequest { num_players: 5, player_name: None };
        let err = create_game(State(state), Json(payload)).await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn create_game_succeeds_for_every_valid_player_count() {
        for n in 1..=4u32 {
            let state = test_state().await;
            let payload = CreateGameRequest { num_players: n, player_name: None };
            let response = create_game(State(state), Json(payload)).await.unwrap();
            assert_eq!(response.0.state.game.players.len(), n as usize);
        }
    }

    #[tokio::test]
    async fn join_unknown_game_reports_the_code_that_was_not_found() {
        let state = test_state().await;
        let payload = JoinRequest { name: None };
        let err = join_game_seat(Path("NOSUCH".to_string()), State(state), Json(payload))
            .await
            .unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::NOT_FOUND);
        assert!(err.1.0.message.contains("NOSUCH"), "the room code appears in the message");
    }

    #[tokio::test]
    async fn get_unknown_game_reports_the_code_that_was_not_found() {
        let state = test_state().await;
        let err = get_game(Path("GHOST99".to_string()), State(state)).await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::NOT_FOUND);
        assert!(err.1.0.message.contains("GHOST99"));
    }

    #[tokio::test]
    async fn join_a_real_game_succeeds_and_issues_a_token() {
        let state = test_state().await;
        let create_payload = CreateGameRequest { num_players: 2, player_name: None };
        let created = create_game(State(state.clone()), Json(create_payload)).await.unwrap();

        let join_payload = JoinRequest { name: Some("Newcomer".to_string()) };
        let joined = join_game_seat(Path(created.0.id.clone()), State(state), Json(join_payload))
            .await
            .unwrap();
        assert_eq!(joined.0.seat_index, 1);
        assert!(!joined.0.token.is_empty());
    }

    #[tokio::test]
    async fn a_smaller_new_deal_seats_the_host_and_the_most_recent_arrivals() {
        // Four people, re-dealt as a 2-player game. The old behaviour kept
        // whoever held seats 0 and 1 - so an early joiner who had been
        // spectating stayed in while the person who just arrived to play
        // sat out.
        let mut room = Room {
            id: "RECENCY".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "t0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Early".to_string(), host: false, token: "t1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Later".to_string(), host: false, token: "t2".to_string(), joined_seq: 2 },
                Member { seat: 3, name: "Newest".to_string(), host: false, token: "t3".to_string(), joined_seq: 3 },
            ],
            game: GameState::new(4),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        deal_new_game(&mut room, 2);

        let seat_of = |name: &str| room.members.iter().find(|m| m.name == name).unwrap().seat;
        assert_eq!(seat_of("Host"), 0, "the host always plays");
        assert_eq!(seat_of("Newest"), 1, "the most recent arrival takes the other seat");
        assert!(seat_of("Later") >= 2, "earlier arrivals move to spectator seats");
        assert!(seat_of("Early") >= 2);
        assert_eq!(room.game.players.len(), 2);
    }

    #[tokio::test]
    async fn a_re_deal_does_not_re_attribute_old_chat_messages() {
        // Chat outlives a deal and records the sender's seat. When seats move,
        // an un-remapped message would be credited to whoever inherited the
        // seat - and the client decides which messages are "yours" by exactly
        // that comparison, so your opponent's old lines would render as yours.
        let mut room = Room {
            id: "CHATSEAT".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "t0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Early".to_string(), host: false, token: "t1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Newest".to_string(), host: false, token: "t2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        room.push_chat(1, "said by Early");
        room.push_chat(2, "said by Newest");

        deal_new_game(&mut room, 2);

        // Newest moved 2 -> 1 and Early 1 -> 2; each message follows its author.
        let seat_of = |name: &str| room.members.iter().find(|m| m.name == name).unwrap().seat;
        let early = room.chat.iter().find(|m| m.text == "said by Early").unwrap();
        let newest = room.chat.iter().find(|m| m.text == "said by Newest").unwrap();
        assert_eq!(early.seat, seat_of("Early"));
        assert_eq!(newest.seat, seat_of("Newest"));
        assert_ne!(early.seat, newest.seat, "two authors never collapse onto one seat");

        // The displayed name is still the one captured at send time.
        assert_eq!(early.name, "Early");
        assert_eq!(newest.name, "Newest");
    }

    #[tokio::test]
    async fn reassigning_seats_keeps_every_token_working() {
        // Seats move; identity doesn't. A player whose seat changed must still
        // authenticate - on their *new* seat.
        let mut room = Room {
            id: "TOKMOVE".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "t0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Early".to_string(), host: false, token: "t1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Newest".to_string(), host: false, token: "t2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        deal_new_game(&mut room, 2);

        assert_eq!(seat_for_token(&room, Some("t0")), Some(0));
        assert_eq!(seat_for_token(&room, Some("t2")), Some(1), "Newest moved up and its token follows");
        assert_eq!(seat_for_token(&room, Some("t1")), Some(2), "Early moved down, still authenticates");
        // Every seat is distinct - a duplicate would let two people act as one.
        let mut seats: Vec<usize> = room.members.iter().map(|m| m.seat).collect();
        seats.sort();
        assert_eq!(seats, vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn the_snapshot_tells_each_connection_which_seat_is_theirs() {
        // The client can't work this out itself: MemberView carries no token,
        // and a re-deal can move the seat it was given at join.
        let room = host_room();
        let truth = snapshot(&room);
        assert_eq!(redact_for(&truth, Some(1)).you, Some(1));
        assert_eq!(redact_for(&truth, Some(2)).you, Some(2));
        assert_eq!(redact_for(&truth, None).you, None, "an anonymous reader is nobody");
    }

    #[tokio::test]
    async fn arrival_order_keeps_increasing_as_people_join() {
        let mut room = Room {
            id: "SEQ".to_string(),
            members: vec![],
            game: GameState::new(4),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        for _ in 0..4 {
            claim_seat(&mut room, None);
        }
        let mut seqs: Vec<u64> = room.members.iter().map(|m| m.joined_seq).collect();
        seqs.sort();
        assert_eq!(seqs, vec![0, 1, 2, 3], "each arrival gets a later number");
    }

    #[tokio::test]
    async fn persist_history_records_seed_and_version() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let game = GameState::new(2);
        persist_room(&pool, &Room {
            id: "GAME01".to_string(),
            members: vec![Member { seat: 0, name: String::new(), host: true, token: "tok0".to_string(), joined_seq: 0 }],
            game,
            chat: Vec::new(),
            live: HashMap::new(),
        })
        .await;
        let game = GameState::new(2);
        record_history(&pool, "GAME01", "yield", &GameAction::Yield, &game).await;

        let (seed, version): (i64, i64) =
            sqlx::query_as("SELECT seed, version FROM game_history")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(seed, game.seed as i64);
        assert_eq!(version, game.version as i64);
    }

    #[tokio::test]
    async fn only_the_first_ever_joiner_is_host() {
        let mut room = Room {
            id: "HOSTTEST".to_string(),
            members: vec![],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        let (alice_seat, _, alice_token) = claim_seat(&mut room, Some("Alice".to_string()));
        let alice = room.members.iter().find(|m| m.seat == alice_seat).unwrap();
        assert!(alice.host, "the first-ever member of an empty room is host");
        assert!(!alice_token.is_empty(), "joining issues a seat token");
        assert_eq!(seat_for_token(&room, Some(&alice_token)), Some(alice_seat));

        let (bob_seat, _, _) = claim_seat(&mut room, Some("Bob".to_string()));
        let bob = room.members.iter().find(|m| m.seat == bob_seat).unwrap();
        assert!(!bob.host, "a later joiner is never host, even taking a player seat");

        // Fill the remaining player seats and overflow into spectators: still
        // no one but Alice is ever host.
        let (carol_seat, carol_is_player, _) = claim_seat(&mut room, Some("Carol".to_string()));
        assert!(!carol_is_player, "2-player room: Carol is a spectator");
        let carol = room.members.iter().find(|m| m.seat == carol_seat).unwrap();
        assert!(!carol.host);
    }

    #[tokio::test]
    async fn host_survives_a_new_deal() {
        // Member.host is keyed by seat and deal_new_game never touches
        // `members`, so a new deal must not silently demote or lose the host.
        let mut room = Room {
            id: "HOSTPERSIST".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
            ],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };

        deal_new_game(&mut room, 3);

        let alice = room.members.iter().find(|m| m.seat == 0).unwrap();
        assert!(alice.host, "the host survives a re-deal");
        assert_eq!(room.members.iter().filter(|m| m.host).count(), 1, "still exactly one host");
    }



    fn host_room() -> Room {
        Room {
            id: "SOCK".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Wanda".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        }
    }

    // ---- should_apply: the socket's authorization decision ----

    #[test]
    fn a_seat_is_reached_only_by_its_own_token() {
        let room = host_room();
        assert_eq!(seat_for_token(&room, Some("tok0")), Some(0));
        assert_eq!(seat_for_token(&room, Some("tok1")), Some(1));
        assert_eq!(seat_for_token(&room, Some("tok2")), Some(2));
    }

    #[test]
    fn an_absent_empty_or_wrong_token_is_nobody() {
        // A seat number is public, so identity has to rest on something that
        // isn't. Anything unrecognised connects as an observer.
        let room = host_room();
        assert_eq!(seat_for_token(&room, None), None);
        assert_eq!(seat_for_token(&room, Some("")), None, "an empty token matches nothing");
        assert_eq!(seat_for_token(&room, Some("guess")), None);
        assert_eq!(seat_for_token(&room, Some("TOK0")), None, "tokens are compared exactly");
    }

    #[test]
    fn a_room_predating_tokens_authenticates_nobody() {
        // Members recovered from a pre-token snapshot have empty tokens. That
        // must not become a skeleton key that matches an absent token.
        let mut room = host_room();
        for m in room.members.iter_mut() {
            m.token = String::new();
        }
        assert_eq!(seat_for_token(&room, Some("")), None);
        assert_eq!(seat_for_token(&room, None), None);
        assert_eq!(seat_for_token(&room, Some("tok0")), None);
    }

    #[test]
    fn tokens_are_unique_per_seat_and_hard_to_guess() {
        let mut room = Room {
            id: "TOK".to_string(),
            members: vec![],
            game: GameState::new(4),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        let mut issued = Vec::new();
        for name in ["a", "b", "c", "d"] {
            let (_, _, token) = claim_seat(&mut room, Some(name.to_string()));
            assert!(token.len() >= 32, "a guessable token is no token at all");
            assert!(!issued.contains(&token), "every seat gets its own");
            issued.push(token);
        }
    }

    /// A 2-player room as `load_rooms` rebuilds one persisted before seat
    /// tokens: both seats held by members nobody can authenticate as.
    fn legacy_room() -> Room {
        Room {
            id: "LEGACY".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true, token: String::new(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: String::new(), joined_seq: 1 },
            ],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        }
    }

    #[test]
    fn a_joiner_reclaims_a_legacy_seat_instead_of_watching() {
        let mut room = legacy_room();
        let (seat, is_player, token) = claim_seat(&mut room, Some("Carol".to_string()));
        assert!(is_player, "a tokenless seat is reclaimed, not left to block the game");
        assert!(seat < 2);
        assert_eq!(seat_for_token(&room, Some(&token)), Some(seat), "the new token authenticates");
        assert_eq!(room.members.len(), 2, "the legacy member is taken over, not duplicated");
        let member = room.members.iter().find(|m| m.seat == seat).unwrap();
        assert_eq!(member.name, "Carol");
        assert_eq!(room.game.players[seat].name, "Carol");
    }

    #[test]
    fn a_returning_player_reclaims_their_own_legacy_seat_and_host() {
        let mut room = legacy_room();
        // Case and surrounding space differ from the stored name.
        let (seat, is_player, token) = claim_seat(&mut room, Some(" alice ".to_string()));
        assert!(is_player);
        assert_eq!(seat, 0, "the name match wins over the other legacy seat");
        assert!(room.members[0].host, "the host flag carries over, so the room can still re-deal");
        assert_eq!(seat_for_token(&room, Some(&token)), Some(0));
        // Bob's seat is untouched and still unclaimed.
        assert!(room.members[1].token.is_empty());
    }

    #[test]
    fn a_free_seat_is_preferred_over_an_unmatched_legacy_one() {
        let mut room = Room {
            id: "LEGACY3".to_string(),
            members: vec![Member { seat: 0, name: "Alice".to_string(), host: true, token: String::new(), joined_seq: 0 }],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        let (seat, is_player, _) = claim_seat(&mut room, Some("Dave".to_string()));
        assert!(is_player);
        assert_eq!(seat, 1, "Alice may still come back for seat 0");
        assert!(room.members[0].token.is_empty());
        assert_eq!(room.members.len(), 2);
    }

    #[test]
    fn a_reclaimed_seat_counts_as_a_fresh_arrival() {
        let mut room = legacy_room();
        let (seat, _, _) = claim_seat(&mut room, Some("Carol".to_string()));
        let member = room.members.iter().find(|m| m.seat == seat).unwrap();
        assert_eq!(member.joined_seq, 2, "re-deal ordering sees the reclaimer as the newest arrival");
    }

    #[test]
    fn legacy_spectators_are_not_reclaimed_as_player_seats() {
        let mut room = legacy_room();
        room.members[0].token = "tok0".to_string();
        room.members[1].token = "tok1".to_string();
        room.members.push(Member { seat: 2, name: "Wanda".to_string(), host: false, token: String::new(), joined_seq: 2 });
        let (seat, is_player, _) = claim_seat(&mut room, Some("Wanda".to_string()));
        assert!(!is_player, "a full table still turns a joiner into a spectator");
        assert_eq!(seat, 3);
    }

    #[test]
    fn the_snapshot_never_carries_a_token() {
        // RoomSnapshot goes to every client, so a token on it would hand every
        // seat's secret to everyone - the exact opposite of the point.
        let room = host_room();
        let json = serde_json::to_string(&snapshot(&room)).unwrap();
        for m in &room.members {
            assert!(!json.contains(&m.token), "token for seat {} leaked", m.seat);
        }
        assert!(!json.contains("token"), "no token field at all on the wire");
    }

    #[test]
    fn api_error_carries_the_given_message() {
        let (status, Json(body)) = api_error(axum::http::StatusCode::NOT_FOUND, "no such room");
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body.message, "no such room");
    }

    #[test]
    fn api_error_accepts_a_formatted_message() {
        let id = "ABC123";
        let (_, Json(body)) = api_error(
            axum::http::StatusCode::NOT_FOUND,
            format!("No game with code {id}"),
        );
        assert_eq!(body.message, "No game with code ABC123");
    }

    #[test]
    fn keepalive_is_never_applied() {
        // Not an action: no state change, no history row, no broadcast.
        let room = host_room();
        assert!(!should_apply(&GameAction::Ping, Some(0), Some(&room)));
    }

    #[test]
    fn only_the_host_may_start_a_new_deal() {
        let room = host_room();
        for action in [GameAction::Reset, GameAction::NewGame { num_players: 3 }] {
            assert!(should_apply(&action, Some(0), Some(&room)), "host may");
            assert!(!should_apply(&action, Some(1), Some(&room)), "a seated non-host may not");
            assert!(!should_apply(&action, Some(2), Some(&room)), "a spectator may not");
            assert!(!should_apply(&action, None, Some(&room)), "a seatless connection may not");
            assert!(!should_apply(&action, Some(0), None), "not for an unknown room");
        }
    }

    #[test]
    fn set_name_may_only_target_the_connected_seat() {
        let room = host_room();
        let rename = |seat: usize| GameAction::SetName { seat, name: "X".to_string() };
        assert!(should_apply(&rename(1), Some(1), Some(&room)));
        assert!(!should_apply(&rename(0), Some(1), Some(&room)), "cannot rename another seat");
        assert!(!should_apply(&rename(0), None, Some(&room)), "a seatless connection renames nobody");
    }

    #[test]
    fn turn_actions_are_restricted_to_whoever_s_turn_it_is() {
        // The rules engine already resolves these against current_player_index,
        // so nobody could act out of turn - but before this gate any connected
        // client could take the current player's turn for them.
        let mut room = host_room();
        room.game.current_player_index = 1; // new() randomises the starting seat

        for action in [
            GameAction::Yield,
            GameAction::PlayCards { indices: vec![0] },
            GameAction::DiscardCards { indices: vec![0] },
            GameAction::ChooseNextPlayer { index: 0 },
            GameAction::UseSoloJester,
        ] {
            assert!(should_apply(&action, Some(1), Some(&room)), "the current player may act");
            assert!(!should_apply(&action, Some(0), Some(&room)), "another seat may not act for them");
            assert!(!should_apply(&action, Some(2), Some(&room)), "a spectator may not act");
            assert!(!should_apply(&action, None, Some(&room)), "a seatless connection may not act");
            assert!(!should_apply(&action, Some(1), None), "not for an unknown room");
        }
    }

    #[test]
    fn the_jester_player_may_choose_any_seat_including_their_own() {
        // "[rules wording removed]" - any
        // includes themselves. should_apply only checks that the chooser is
        // the current player; it does not, and must not, care which index
        // they picked - that legality lives in choose_next_player itself.
        let mut room = host_room();
        room.game.current_player_index = 0; // new() randomises the starting seat
        for target in 0..room.members.len() {
            assert!(
                should_apply(&GameAction::ChooseNextPlayer { index: target }, Some(0), Some(&room)),
                "seat 0 choosing seat {target} (self-choice included) must be allowed through the gate"
            );
        }
    }

    #[test]
    fn the_gate_follows_the_turn_as_it_moves() {
        let mut room = host_room();
        room.game.current_player_index = 0;
        assert!(should_apply(&GameAction::Yield, Some(0), Some(&room)));
        assert!(!should_apply(&GameAction::Yield, Some(1), Some(&room)));

        room.game.current_player_index = 1;
        assert!(!should_apply(&GameAction::Yield, Some(0), Some(&room)));
        assert!(should_apply(&GameAction::Yield, Some(1), Some(&room)));
    }

    fn dealt_room() -> Room {
        let mut room = Room {
            id: "REDACT".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
            ],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        room.push_chat(0, "hello");
        room
    }

    #[test]
    fn a_seat_sees_its_own_hand_and_nobody_else_s() {
        let room = dealt_room();
        let truth = snapshot(&room);
        let view = redact_for(&truth, Some(0));

        assert_eq!(view.game.players[0].hand, truth.game.players[0].hand, "own hand is intact");
        assert_ne!(view.game.players[1].hand, truth.game.players[1].hand, "the other hand is hidden");
        assert_eq!(
            view.game.players[1].hand.len(),
            truth.game.players[1].hand.len(),
            "the count is public - the roster shows it"
        );
        assert!(
            view.game.players[1].hand.iter().all(|c| c.suit.is_none()),
            "no suit survives redaction"
        );
    }

    #[test]
    fn a_spectator_and_an_anonymous_reader_see_no_hands_at_all() {
        let room = dealt_room();
        let truth = snapshot(&room);
        for seat in [Some(5usize), None] {
            let view = redact_for(&truth, seat);
            for (i, p) in view.game.players.iter().enumerate() {
                assert_ne!(p.hand, truth.game.players[i].hand, "seat {i} hidden from {seat:?}");
                assert_eq!(p.hand.len(), truth.game.players[i].hand.len());
            }
        }
    }

    #[test]
    fn the_tavern_order_never_leaves_the_server() {
        let room = dealt_room();
        let truth = snapshot(&room);
        let view = redact_for(&truth, Some(0));
        assert_eq!(view.game.tavern_deck.len(), truth.game.tavern_deck.len(), "count is public");
        assert!(
            view.game.tavern_deck.iter().all(|c| c.suit.is_none()),
            "the order is the next few draws, so none of it is sent"
        );
    }

    #[test]
    fn the_castle_keeps_its_contents_but_loses_its_order() {
        let room = dealt_room();
        let truth = snapshot(&room);
        let view = redact_for(&truth, Some(0));

        let mut expected: Vec<u32> = truth.game.castle_deck.iter().map(|c| c.id).collect();
        let actual: Vec<u32> = view.game.castle_deck.iter().map(|c| c.id).collect();
        expected.sort();
        assert_eq!(actual, expected, "same enemies, canonical order - the UI sorts them itself");
        assert!(actual.windows(2).all(|w| w[0] <= w[1]), "order reveals nothing about the shuffle");
    }

    #[test]
    fn public_information_is_left_alone() {
        let mut room = dealt_room();
        room.game.discard_pile = vec![Card::new(Suit::Hearts, Rank::Number(4), 7001)];
        room.game.played_cards = vec![Card::new(Suit::Spades, Rank::Number(9), 7002)];
        room.game.last_played = Some(vec![Card::new(Suit::Clubs, Rank::Ace, 7003)]);
        let truth = snapshot(&room);
        let view = redact_for(&truth, Some(1));

        assert_eq!(view.game.discard_pile, truth.game.discard_pile);
        assert_eq!(view.game.played_cards, truth.game.played_cards);
        assert_eq!(view.game.last_played, truth.game.last_played);
        assert_eq!(view.game.active_enemy, truth.game.active_enemy);
        assert_eq!(view.chat.len(), truth.chat.len());
        assert_eq!(view.members, truth.members);
    }

    #[test]
    fn redaction_is_byte_stable_for_the_same_state() {
        // The client diffs snapshot JSON to decide whether anything moved, so
        // placeholder ids must not churn between frames.
        let room = dealt_room();
        let truth = snapshot(&room);
        let a = serde_json::to_string(&redact_for(&truth, Some(0))).unwrap();
        let b = serde_json::to_string(&redact_for(&truth, Some(0))).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn anyone_seated_may_chat_including_spectators() {
        let room = host_room();
        let msg = GameAction::SendChat { text: "hi".into() };
        assert!(should_apply(&msg, Some(0), Some(&room)));
        assert!(should_apply(&msg, Some(2), Some(&room)), "watching is not a reason to be silent");
        assert!(
            !should_apply(&msg, None, Some(&room)),
            "a seatless connection is refused here so it cannot cause a pointless persist and broadcast"
        );
    }

    // ---- action_type: the label written to game_history ----

    #[test]
    fn every_action_has_a_stable_history_label() {
        let cases = [
            (GameAction::Ping, "ping"),
            (GameAction::PlayCards { indices: vec![] }, "play_cards"),
            (GameAction::Yield, "yield"),
            (GameAction::DiscardCards { indices: vec![] }, "discard_cards"),
            (GameAction::ChooseNextPlayer { index: 0 }, "choose_next_player"),
            (GameAction::UseSoloJester, "use_solo_jester"),
            (GameAction::Reset, "reset"),
            (GameAction::NewGame { num_players: 2 }, "new_game"),
            (GameAction::SetName { seat: 0, name: String::new() }, "set_name"),
            (GameAction::SendChat { text: String::new() }, "send_chat"),
        ];
        for (action, expected) in cases {
            assert_eq!(action_type(&action), expected);
        }
    }

    // ---- apply_action: dispatch ----

    #[test]
    fn set_name_updates_both_the_player_and_the_member() {
        // Two records carry a name; updating only one leaves the roster and the
        // board disagreeing about who you are.
        let mut room = host_room();
        apply_action(&mut room, &GameAction::SetName { seat: 1, name: "Robert".into() }, Some(1)).unwrap();
        assert_eq!(room.members.iter().find(|m| m.seat == 1).unwrap().name, "Robert");
        assert_eq!(room.game.players[1].name, "Robert");
    }

    #[test]
    fn chat_is_attributed_to_the_socket_seat_not_the_payload() {
        let mut room = host_room();
        apply_action(&mut room, &GameAction::SendChat { text: "hello".into() }, Some(1)).unwrap();
        assert_eq!(room.chat.len(), 1);
        assert_eq!(room.chat[0].seat, 1, "the sender is the connection, not anything sent");
        assert_eq!(room.chat[0].name, "Bob");
    }

    #[test]
    fn a_seatless_connection_cannot_chat() {
        let mut room = host_room();
        apply_action(&mut room, &GameAction::SendChat { text: "hello".into() }, None).unwrap();
        assert!(room.chat.is_empty());
    }

    #[test]
    fn new_game_redeals_at_the_requested_size_and_keeps_the_host() {
        let mut room = host_room();
        apply_action(&mut room, &GameAction::NewGame { num_players: 3 }, Some(0)).unwrap();
        assert_eq!(room.game.players.len(), 3);
        assert_eq!(room.members.iter().filter(|m| m.host).count(), 1);
        assert!(room.members.iter().find(|m| m.seat == 0).unwrap().host);
    }

    #[test]
    fn an_illegal_play_reports_an_error_and_leaves_the_game_alone() {
        // apply_action's Result reaches the player as ServerMessage::Error,
        // sent privately rather than broadcast (see should_apply's caller in
        // handle_socket).
        let mut room = host_room();
        let before = room.game.players[room.game.current_player_index].hand.clone();
        let err = apply_action(&mut room, &GameAction::PlayCards { indices: vec![99] }, Some(0));
        assert!(err.is_err(), "an out-of-range index is rejected");
        assert_eq!(room.game.players[room.game.current_player_index].hand, before);
    }


    fn chat_room() -> Room {
        Room {
            id: "CHAT".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true, token: "tok0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "tok1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Wanda".to_string(), host: false, token: "tok2".to_string(), joined_seq: 2 }, // spectator
            ],
            game: GameState::new(2),
            chat: Vec::new(),
            live: HashMap::new(),
        }
    }

    #[test]
    fn chat_is_attributed_to_the_sending_seat() {
        let mut room = chat_room();
        room.push_chat(1, "hello");
        assert_eq!(room.chat.len(), 1);
        assert_eq!(room.chat[0].seat, 1);
        assert_eq!(room.chat[0].name, "Bob");
        assert_eq!(room.chat[0].text, "hello");
    }

    #[test]
    fn spectators_can_chat() {
        // Watching a game and being unable to say anything would make the
        // feature useless for exactly the people most likely to use it.
        let mut room = chat_room();
        room.push_chat(2, "nice play");
        assert_eq!(room.chat.len(), 1);
        assert_eq!(room.chat[0].name, "Wanda");
    }

    #[test]
    fn a_seat_outside_the_roster_cannot_post() {
        // `seat` arrives from a query param, so an arbitrary value must not be
        // able to inject messages.
        let mut room = chat_room();
        room.push_chat(99, "i am nobody");
        assert!(room.chat.is_empty());
    }

    #[test]
    fn blank_messages_are_dropped_and_text_is_trimmed() {
        let mut room = chat_room();
        room.push_chat(0, "   ");
        room.push_chat(0, "\n\t");
        assert!(room.chat.is_empty(), "whitespace-only messages are not stored");

        room.push_chat(0, "  padded  ");
        assert_eq!(room.chat[0].text, "padded");
    }

    #[test]
    fn long_multibyte_messages_are_truncated_without_panicking() {
        // Byte-slicing at CHAT_MAX_LEN would panic here: these are 4-byte
        // characters, so the boundary lands mid-codepoint.
        let mut room = chat_room();
        let long_emoji = "🂡".repeat(CHAT_MAX_LEN + 50);
        room.push_chat(0, &long_emoji);
        assert_eq!(room.chat[0].text.chars().count(), CHAT_MAX_LEN);
    }

    #[test]
    fn chat_history_is_capped() {
        let mut room = chat_room();
        for i in 0..(CHAT_CAP + 25) {
            room.push_chat(0, &format!("msg {}", i));
        }
        assert_eq!(room.chat.len(), CHAT_CAP);
        // The newest survive, the oldest fall off the front.
        assert_eq!(room.chat.last().unwrap().text, format!("msg {}", CHAT_CAP + 24));
    }

    #[test]
    fn a_rename_is_reflected_across_the_chat_log() {
        let mut room = chat_room();
        room.push_chat(1, "before");
        room.push_chat(0, "from alice");
        apply_action(&mut room, &GameAction::SetName { seat: 1, name: "Robert".into() }, Some(1)).unwrap();
        room.push_chat(1, "after");
        assert_eq!(room.chat[0].name, "Robert", "past messages take the new name");
        assert_eq!(room.chat[1].name, "Alice", "other seats are untouched");
        assert_eq!(room.chat[2].name, "Robert");
    }

    // ---- HTTP: the real router, not just the handler functions ----
    //
    // The tests above call handlers directly, which skips routing, body
    // extraction and the status line a client actually sees. These go through
    // `api_router` with tower's `oneshot`, so no port is needed.

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn http(state: &AppState, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = api_router(state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn post_json(uri: &str, body: &str) -> Request<Body> {
        Request::post(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    /// True when no card in any hand, the Tavern or the castle names a suit -
    /// i.e. everything a reader isn't entitled to is a face-down placeholder.
    fn hands_are_hidden(game: &serde_json::Value, except_seat: Option<usize>) -> bool {
        game["players"].as_array().unwrap().iter().enumerate().all(|(i, p)| {
            Some(i) == except_seat || p["hand"].as_array().unwrap().iter().all(|c| c["suit"].is_null())
        })
    }

    #[tokio::test]
    async fn http_create_returns_the_room_the_creator_and_a_token() {
        let state = test_state().await;
        let (status, body) = http(&state, post_json("/api/game", r#"{"num_players":2,"player_name":"Alice"}"#)).await;
        assert_eq!(status, StatusCode::OK);
        let id = body["id"].as_str().unwrap();
        let token = body["token"].as_str().unwrap();
        assert_eq!(id.len(), 6);
        assert!(token.len() >= 32);
        assert_eq!(body["state"]["you"], 0, "the creator is told they hold seat 0");
        assert_eq!(body["state"]["game"]["players"][0]["name"], "Alice");
        // The token is issued in its own field and nowhere inside the room view.
        assert!(!body["state"].to_string().contains(token), "the snapshot never carries a token");
        assert!(hands_are_hidden(&body["state"]["game"], Some(0)), "only the creator's own hand is visible");
        assert!(state.rooms.read().unwrap().contains_key(id), "the room is registered");
    }

    #[tokio::test]
    async fn http_create_with_a_bad_player_count_is_a_400_with_a_reason() {
        let state = test_state().await;
        let (status, body) = http(&state, post_json("/api/game", r#"{"num_players":9}"#)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["message"].as_str().unwrap().contains('9'));
        assert!(state.rooms.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn http_create_with_a_malformed_body_is_refused_and_creates_nothing() {
        let state = test_state().await;
        let (status, _) = http(&state, post_json("/api/game", "not json")).await;
        assert!(status.is_client_error(), "got {status}");
        let (status, _) = http(&state, post_json("/api/game", r#"{"player_name":"no count"}"#)).await;
        assert!(status.is_client_error(), "a missing num_players is refused, got {status}");
        assert!(state.rooms.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn http_join_unknown_code_is_a_404_naming_the_code() {
        let state = test_state().await;
        let (status, body) = http(&state, post_json("/api/game/NOSUCH/join", r#"{"name":"Bob"}"#)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["message"].as_str().unwrap().contains("NOSUCH"));
    }

    #[tokio::test]
    async fn http_join_then_anonymous_read_hides_every_hand() {
        let state = test_state().await;
        let (_, created) = http(&state, post_json("/api/game", r#"{"num_players":2}"#)).await;
        let id = created["id"].as_str().unwrap().to_string();

        let (status, joined) = http(&state, post_json(&format!("/api/game/{id}/join"), r#"{"name":"Bob"}"#)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(joined["seat_index"], 1);
        assert_eq!(joined["spectator"], false);
        let token = joined["token"].as_str().unwrap();
        assert_eq!(seat_for_token(&state.rooms.read().unwrap()[&id], Some(token)), Some(1));

        let (status, room) = http(&state, Request::get(format!("/api/game/{id}")).body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(room["you"].is_null(), "an anonymous reader is nobody");
        assert!(hands_are_hidden(&room["game"], None), "an anonymous GET sees no hand at all");
        assert!(room["game"]["tavern_deck"].as_array().unwrap().iter().all(|c| c["suit"].is_null()));
    }

    #[tokio::test]
    async fn http_unknown_api_route_is_a_404() {
        let state = test_state().await;
        let (status, _) = http(&state, Request::get("/api/nope").body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // ---- WebSocket: handle_socket end to end ----
    //
    // `should_apply` and `apply_action` are covered as pure functions above;
    // these cover what's left in the handler - token resolution, the initial
    // snapshot, fan-out to every connection, errors going only to the sender,
    // and persistence - against a real server on an ephemeral port.

    use tokio_tungstenite::tungstenite::Message as WsMessage;

    type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn serve(state: &AppState) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = api_router(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    async fn connect(addr: std::net::SocketAddr, id: &str, token: Option<&str>) -> Ws {
        let url = match token {
            Some(t) => format!("ws://{addr}/api/ws/{id}?token={t}"),
            None => format!("ws://{addr}/api/ws/{id}"),
        };
        tokio_tungstenite::connect_async(url).await.unwrap().0
    }

    /// Next server message as JSON, failing the test if none arrives promptly.
    async fn recv(ws: &mut Ws) -> serde_json::Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("timed out waiting for a server message")
                .expect("socket closed")
                .unwrap();
            if let WsMessage::Text(text) = frame {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }

    /// Asserts the server sends nothing on this connection for a moment.
    async fn assert_silent(ws: &mut Ws, why: &str) {
        if let Ok(Some(Ok(frame))) = tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
            panic!("{why}, but got {frame:?}");
        }
    }

    async fn send(ws: &mut Ws, action: serde_json::Value) {
        ws.send(WsMessage::Text(action.to_string().into())).await.unwrap();
    }

    /// A 2-player room with both seats claimed; returns (id, host token, joiner token).
    async fn two_seat_room(state: &AppState) -> (String, String, String) {
        let created = create_game(State(state.clone()), Json(CreateGameRequest { num_players: 2, player_name: Some("Alice".into()) }))
            .await
            .unwrap()
            .0;
        let joined = join_game_seat(Path(created.id.clone()), State(state.clone()), Json(JoinRequest { name: Some("Bob".into()) }))
            .await
            .unwrap()
            .0;
        (created.id, created.token, joined.token)
    }

    #[tokio::test]
    async fn ws_first_frame_is_the_room_as_this_seat_may_see_it() {
        let state = test_state().await;
        let (id, _, bob_token) = two_seat_room(&state).await;
        let addr = serve(&state).await;

        let mut bob = connect(addr, &id, Some(&bob_token)).await;
        let msg = recv(&mut bob).await;
        assert_eq!(msg["type"], "State");
        assert_eq!(msg["payload"]["you"], 1, "the seat comes from the token");
        let game = &msg["payload"]["game"];
        assert!(game["players"][1]["hand"].as_array().unwrap().iter().all(|c| !c["suit"].is_null()), "Bob sees his own hand");
        assert!(hands_are_hidden(game, Some(1)), "and nobody else's");
    }

    #[tokio::test]
    async fn ws_without_a_token_watches_and_is_refused_silently() {
        let state = test_state().await;
        let (id, alice_token, _) = two_seat_room(&state).await;
        let addr = serve(&state).await;

        let mut alice = connect(addr, &id, Some(&alice_token)).await;
        recv(&mut alice).await; // initial snapshot
        let mut stranger = connect(addr, &id, None).await;
        let msg = recv(&mut stranger).await;
        assert!(msg["payload"]["you"].is_null(), "no token, no seat");

        // Claiming a seat in the body buys nothing: identity is the socket's.
        send(&mut stranger, serde_json::json!({ "type": "SetName", "payload": { "seat": 0, "name": "Mallory" } })).await;
        assert_silent(&mut alice, "a refused action must not be broadcast").await;
        assert_silent(&mut stranger, "a refused action gets no reply either").await;
        assert_eq!(state.rooms.read().unwrap()[&id].members[0].name, "Alice");
    }

    #[tokio::test]
    async fn ws_a_rename_reaches_every_connection_and_is_persisted() {
        let state = test_state().await;
        let (id, alice_token, bob_token) = two_seat_room(&state).await;
        let addr = serve(&state).await;

        let mut alice = connect(addr, &id, Some(&alice_token)).await;
        let mut bob = connect(addr, &id, Some(&bob_token)).await;
        recv(&mut alice).await;
        recv(&mut bob).await;

        send(&mut bob, serde_json::json!({ "type": "SetName", "payload": { "seat": 1, "name": "Robert" } })).await;
        for ws in [&mut alice, &mut bob] {
            let msg = recv(ws).await;
            assert_eq!(msg["type"], "State");
            assert_eq!(msg["payload"]["game"]["players"][1]["name"], "Robert");
        }

        let (stored,): (String,) = sqlx::query_as("SELECT state_json FROM games WHERE id = ?1")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert!(stored.contains("Robert"), "the room is written through to the database");
        let (history,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM game_history WHERE game_id = ?1 AND action_type = 'set_name'")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(history, 1, "and recorded in the history");
    }

    #[tokio::test]
    async fn ws_a_rejected_play_is_reported_to_the_sender_only() {
        let state = test_state().await;
        let (id, alice_token, bob_token) = two_seat_room(&state).await;
        let addr = serve(&state).await;
        // GameState::new picks the starting seat at random; whoever it is acts.
        let current = state.rooms.read().unwrap()[&id].game.current_player_index;
        let (actor_token, watcher_token) = if current == 0 { (&alice_token, &bob_token) } else { (&bob_token, &alice_token) };

        let mut actor = connect(addr, &id, Some(actor_token)).await;
        let mut watcher = connect(addr, &id, Some(watcher_token)).await;
        recv(&mut actor).await;
        recv(&mut watcher).await;

        send(&mut actor, serde_json::json!({ "type": "PlayCards", "payload": { "indices": [99] } })).await;
        let reply = recv(&mut actor).await;
        assert_eq!(reply["type"], "Error");
        assert_eq!(reply["payload"]["action"], "play_cards");
        assert!(!reply["payload"]["message"].as_str().unwrap().is_empty());
        // The attempt still round-trips the (unchanged) room to everyone, but
        // the Error itself is never broadcast.
        let seen = recv(&mut watcher).await;
        assert_eq!(seen["type"], "State", "the other seat never hears about the mistake");
    }

    #[tokio::test]
    async fn ws_chat_is_credited_to_the_connection_not_the_body() {
        let state = test_state().await;
        let (id, alice_token, bob_token) = two_seat_room(&state).await;
        let addr = serve(&state).await;

        let mut alice = connect(addr, &id, Some(&alice_token)).await;
        let mut bob = connect(addr, &id, Some(&bob_token)).await;
        recv(&mut alice).await;
        recv(&mut bob).await;

        // An extra "seat" field in the payload is simply not part of SendChat.
        send(&mut bob, serde_json::json!({ "type": "SendChat", "payload": { "text": "hi all", "seat": 0 } })).await;
        let msg = recv(&mut alice).await;
        let chat = msg["payload"]["chat"].as_array().unwrap();
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0]["seat"], 1);
        assert_eq!(chat[0]["name"], "Bob");
        assert_eq!(chat[0]["text"], "hi all");
    }

    // ---- Re-deal seats people who are actually here ----

    #[test]
    fn a_smaller_redeal_seats_a_connected_player_over_a_newer_absent_one() {
        // The reported case: 4 seats re-dealt as 3. The "ghost" in seat 2
        // joined most recently but isn't connected (a stale seat from a join on
        // another device); the player in seat 3 is at the table. Recency alone
        // benched the real player and seated the ghost.
        let mut room = Room {
            id: "GHOST".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "t0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Bob".to_string(), host: false, token: "t1".to_string(), joined_seq: 1 },
                Member { seat: 3, name: "Dana".to_string(), host: false, token: "t3".to_string(), joined_seq: 2 },
                Member { seat: 2, name: "Ghost".to_string(), host: false, token: "t2".to_string(), joined_seq: 3 },
            ],
            game: GameState::new(4),
            chat: Vec::new(),
            live: HashMap::from([("t0".to_string(), 1), ("t1".to_string(), 1), ("t3".to_string(), 1)]),
        };

        deal_new_game(&mut room, 3);

        let seat_of = |name: &str| room.members.iter().find(|m| m.name == name).unwrap().seat;
        assert!(seat_of("Dana") < 3, "the connected player gets a seat at the new table");
        assert_eq!(seat_of("Ghost"), 3, "the absent member watches");
        assert!(seat_of("Host") < 3 && seat_of("Bob") < 3);
        assert!(room.game.players.iter().any(|p| p.name == "Dana"));
        assert!(room.game.players.iter().all(|p| p.name != "Ghost"));
    }

    #[test]
    fn with_nobody_connected_a_redeal_still_falls_back_to_recency() {
        // Right after a restart nobody has reconnected yet; the old ordering
        // must still apply rather than scrambling seats.
        let mut room = Room {
            id: "COLD".to_string(),
            members: vec![
                Member { seat: 0, name: "Host".to_string(), host: true, token: "t0".to_string(), joined_seq: 0 },
                Member { seat: 1, name: "Early".to_string(), host: false, token: "t1".to_string(), joined_seq: 1 },
                Member { seat: 2, name: "Late".to_string(), host: false, token: "t2".to_string(), joined_seq: 2 },
            ],
            game: GameState::new(3),
            chat: Vec::new(),
            live: HashMap::new(),
        };
        deal_new_game(&mut room, 2);
        let seat_of = |name: &str| room.members.iter().find(|m| m.name == name).unwrap().seat;
        assert_eq!(seat_of("Late"), 1);
        assert_eq!(seat_of("Early"), 2);
    }

    #[tokio::test]
    async fn ws_a_redeal_seats_the_players_who_are_connected() {
        // End to end over real sockets: four joins, one of which never
        // connects, then the host re-deals for three.
        let state = test_state().await;
        let host = create_game(State(state.clone()), Json(CreateGameRequest { num_players: 4, player_name: Some("Host".into()) }))
            .await
            .unwrap()
            .0;
        let join = |name: &'static str| {
            let state = state.clone();
            let id = host.id.clone();
            async move {
                join_game_seat(Path(id), State(state), Json(JoinRequest { name: Some(name.into()) }))
                    .await
                    .unwrap()
                    .0
            }
        };
        let bob = join("Bob").await;
        let dana = join("Dana").await;
        let _ghost = join("Ghost").await; // newest arrival, never connects

        let addr = serve(&state).await;
        let mut host_ws = connect(addr, &host.id, Some(&host.token)).await;
        let mut bob_ws = connect(addr, &host.id, Some(&bob.token)).await;
        let mut dana_ws = connect(addr, &host.id, Some(&dana.token)).await;
        for ws in [&mut host_ws, &mut bob_ws, &mut dana_ws] {
            recv(ws).await;
        }

        send(&mut host_ws, serde_json::json!({ "type": "NewGame", "payload": { "num_players": 3 } })).await;
        let msg = recv(&mut dana_ws).await;
        let you = msg["payload"]["you"].as_u64().unwrap();
        assert!(you < 3, "Dana is connected, so she plays (got seat {you})");
        let ghost_seat = msg["payload"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "Ghost")
            .unwrap()["seat"]
            .as_u64()
            .unwrap();
        assert_eq!(ghost_seat, 3, "the member who never connected watches");
    }

    #[tokio::test]
    async fn ws_closing_a_connection_stops_counting_it_as_present() {
        let state = test_state().await;
        let (id, alice_token, _) = two_seat_room(&state).await;
        let addr = serve(&state).await;

        let mut alice = connect(addr, &id, Some(&alice_token)).await;
        recv(&mut alice).await;
        assert_eq!(state.rooms.read().unwrap()[&id].live.get(&alice_token), Some(&1));

        alice.close(None).await.unwrap();
        // The server notices the close asynchronously.
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.rooms.read().unwrap()[&id].live.contains_key(&alice_token) {
            assert!(Instant::now() < deadline, "the closed connection was never un-counted");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}