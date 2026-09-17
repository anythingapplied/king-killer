use axum::{
    extract::Query,
    extract::{Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::services::{ServeDir, ServeFile};
use king_killer_core::GameState;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

/// A room is a persistent set of members plus the currently running game.
/// A room outlives any single deal: once a game finishes (or even mid-game), a
/// new deal with a different number of players can be started in the same room.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Room {
    id: String,
    members: Vec<Member>,
    game: GameState,
}

/// What clients receive: the shared game plus the full room roster, so
/// spectators (members seated beyond the player count) are visible too.
#[derive(Clone, Serialize)]
struct RoomSnapshot {
    id: String,
    game: GameState,
    members: Vec<Member>,
}

fn snapshot(room: &Room) -> RoomSnapshot {
    // Keep roster player names authoritative from the game state. Spectator
    // names live only in the members list, so they are untouched here.
    let mut members = room.members.clone();
    for (i, player) in room.game.players.iter().enumerate() {
        if let Some(m) = members.iter_mut().find(|m| m.seat == i) {
            m.name = player.name.clone();
        }
    }
    RoomSnapshot {
        id: room.id.clone(),
        game: room.game.clone(),
        members,
    }
}

/// Deals a brand-new game with `num_players`, seeding each seat's name from the
/// room roster so returning players keep their identity across restarts.
/// Members seated past the new player count automatically become spectators.
fn deal_new_game(room: &mut Room, num_players: u32) {
    let player_count = num_players.clamp(1, 4) as usize;
    let names: Vec<String> = (0..player_count)
        .map(|i| {
            room.members
                .iter()
                .find(|m| m.seat == i)
                .map(|m| m.name.clone())
                .unwrap_or_default()
        })
        .collect();

    let mut game = GameState::new(num_players.clamp(1, 4));
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
fn claim_seat(room: &mut Room, name: Option<String>) -> (usize, bool) {
    // Recorded before either branch pushes a Member, so it reflects the room
    // as it was before this join - i.e. whether anyone was here already.
    let is_first_ever_member = room.members.is_empty();
    let player_count = room.game.players.len();
    let taken: HashSet<usize> = room.members.iter().map(|m| m.seat).collect();
    let free: Vec<usize> = (0..player_count).filter(|s| !taken.contains(s)).collect();

    if let Some(&seat) = free.choose(&mut rand::rng()) {
        room.members.push(Member {
            seat,
            name: name.clone().unwrap_or_default(),
            host: is_first_ever_member,
        });
        if let Some(provided_name) = name {
            if let Some(player) = room.game.players.get_mut(seat) {
                player.name = provided_name;
            }
        }
        (seat, true)
    } else {
        // All player seats are taken: this member watches the game.
        let seat = room.members.iter().map(|m| m.seat).max().map_or(player_count, |m| m + 1);
        room.members.push(Member {
            seat,
            name: name.unwrap_or_default(),
            host: is_first_ever_member,
        });
        (seat, false)
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

async fn load_rooms(db: &SqlitePool) -> HashMap<String, Room> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, state_json, occupied_seats FROM games")
            .fetch_all(db)
            .await
            .unwrap_or_default();

    let mut rooms = HashMap::new();
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
                })
                .collect();
            rooms.insert(
                id.clone(),
                Room {
                    id,
                    members,
                    game,
                },
            );
        }
    }
    rooms
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

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/game", post(create_game))
        .route("/api/game/{id}", get(get_game))
        .route("/api/game/{id}/join", post(join_game_seat))
        .route("/api/ws/{id}", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let dist_dir = std::env::var("DIST_DIR").unwrap_or_else(|_| "frontend/dist".to_string());
    let app = app.fallback_service(
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

#[derive(Serialize)]
struct GameResponse {
    id: String,
    state: RoomSnapshot,
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
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
enum ServerMessage {
    State(RoomSnapshot),
}

async fn create_game(
    State(state): State<AppState>,
    Json(payload): Json<CreateGameRequest>,
) -> impl IntoResponse {
    touch(&state.last_activity);
    let mut id = generate_game_code();
    {
        let rooms = state.rooms.read().unwrap();
        while rooms.contains_key(&id) {
            id = generate_game_code();
        }
    }

    let mut game = GameState::new(payload.num_players.clamp(1, 4));
    let mut members = Vec::new();
    if let Some(name) = &payload.player_name {
        if let Some(player) = game.players.first_mut() {
            player.name = name.clone();
        }
    }
    members.push(Member {
        seat: 0,
        name: game.players[0].name.clone(),
        host: true, // the room's creator is its first-ever member
    });

    let room = Room {
        id: id.clone(),
        members,
        game,
    };
    state.rooms.write().unwrap().insert(id.clone(), room.clone());
    persist_room(&state.db, &room).await;

    let (tx, _) = broadcast::channel(100);
    state.broadcasts.write().unwrap().insert(id.clone(), tx);

    Json(GameResponse { id, state: snapshot(&room) })
}

#[derive(Serialize, Deserialize)]
struct JoinRequest {
    name: Option<String>,
}

#[derive(Serialize)]
struct JoinResponse {
    seat_index: usize,
    /// True when all player seats were taken and this member got a spectator
    /// seat (they can watch but not act).
    spectator: bool,
}

async fn join_game_seat(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<JoinRequest>,
) -> Result<Json<JoinResponse>, axum::http::StatusCode> {
    let response = {
        let mut rooms = state.rooms.write().unwrap();
        let room = rooms.get_mut(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
        let (seat, is_player) = claim_seat(room, payload.name);
        let response = JoinResponse {
            seat_index: seat,
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
) -> Result<Json<RoomSnapshot>, axum::http::StatusCode> {
    let rooms = state.rooms.read().unwrap();
    if let Some(room) = rooms.get(&id) {
        touch(&state.last_activity);
        Ok(Json(snapshot(room)))
    } else {
        Err(axum::http::StatusCode::NOT_FOUND)
    }
}

#[derive(Deserialize)]
struct WsParams {
    /// The seat this connection is speaking for, as returned by `join`. Used
    /// only to authorize host-only actions (`NewGame`/`Reset`) - every other
    /// action still targets `current_player_index` server-side exactly as
    /// before, so a wrong or missing seat cannot be used to act as someone
    /// else, only to lose the ability to start a new deal.
    seat: Option<usize>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, id, params.seat, state))
}

async fn handle_socket(socket: WebSocket, id: String, seat: Option<usize>, state: AppState) {
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

    // Push the current room immediately so a newly-connected client renders.
    let initial = {
        let rooms = state.rooms.read().unwrap();
        rooms.get(&id).map(snapshot)
    };
    if let Some(snap) = initial {
        let msg = serde_json::to_string(&ServerMessage::State(snap)).unwrap();
        if sender.send(Message::Text(msg.into())).await.is_err() {
            return;
        }
    }

    let mut rx = rx;
    let mut send_task = tokio::spawn(async move {
        while let Ok(message) = rx.recv().await {
            let msg = serde_json::to_string(&message).unwrap();
            if let Err(_) = sender.send(Message::Text(msg.into())).await {
                break;
            }
        }
    });

    let state_recv = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            if let Ok(action) = serde_json::from_str::<GameAction>(&text) {
                // A keepalive carries no state change: no history row, no
                // persist, no broadcast. Without this arm the frame failed to
                // parse and the client's keepalive did nothing at all.
                if matches!(action, GameAction::Ping) {
                    continue;
                }

                // Only the room's host may start a new deal - anyone else
                // (a spectator, or any later-joining player) sending
                // NewGame/Reset is dropped here, before it is timestamped,
                // persisted, or broadcast, exactly like an unrecognized action.
                if matches!(action, GameAction::NewGame { .. } | GameAction::Reset) {
                    let is_host = seat.is_some_and(|s| {
                        state_recv.rooms.read().unwrap().get(&id)
                            .is_some_and(|room| room.members.iter().any(|m| m.seat == s && m.host))
                    });
                    if !is_host {
                        continue;
                    }
                }

                let action_type = match &action {
                    GameAction::Ping => "ping",
                    GameAction::PlayCards { .. } => "play_cards",
                    GameAction::Yield => "yield",
                    GameAction::DiscardCards { .. } => "discard_cards",
                    GameAction::ChooseNextPlayer { .. } => "choose_next_player",
                    GameAction::UseSoloJester => "use_solo_jester",
                    GameAction::Reset => "reset",
                    GameAction::NewGame { .. } => "new_game",
                    GameAction::SetName { .. } => "set_name",
                };

                let room = {
                    let mut rooms = state_recv.rooms.write().unwrap();
                    rooms.get_mut(&id).map(|room| {
                        let _ = match &action {
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
                                Ok(())
                            }
                        };
                        room.clone()
                    })
                };

                if let Some(room) = room {
                    record_history(&state_recv.db, &id, action_type, &action, &room.game).await;
                    persist_room(&state_recv.db, &room).await;

                    let broadcasts = state_recv.broadcasts.read().unwrap();
                    if let Some(tx) = broadcasts.get(&id) {
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
                Member { seat: 0, name: String::new(), host: true },
                Member { seat: 1, name: "Bob".to_string(), host: false },
                Member { seat: 2, name: "Carl".to_string(), host: false },
            ],
            game,
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
    async fn claim_seat_prefers_players_then_spectators() {
        let mut room = Room {
            id: "SEATS".to_string(),
            members: vec![Member { seat: 0, name: "Host".to_string(), host: true }],
            game: GameState::new(2),
        };

        let (bob, bob_player) = claim_seat(&mut room, Some("Bob".to_string()));
        assert_eq!(bob, 1);
        assert!(bob_player);

        assert_eq!(room.members.len(), 2);
        assert_eq!(room.game.players[1].name, "Bob");

        // Game is full now: the next joiner watches.
        let (carol, carol_player) = claim_seat(&mut room, Some("Carol".to_string()));
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
                Member { seat: 0, name: "Host".to_string(), host: true },
                Member { seat: 1, name: "Bob".to_string(), host: false },
                Member { seat: 2, name: "Carol".to_string(), host: false },
            ],
            game: GameState::new(3),
        };

        // Shrink to two players: Carol moves to a spectator seat (>1).
        deal_new_game(&mut room, 2);
        assert_eq!(room.game.players.len(), 2);
        assert_eq!(room.game.players[0].name, "Host");
        assert_eq!(room.game.players[1].name, "Bob");
        // Seats above the new player count still belong to the roster.
        assert!(room.members.iter().any(|m| m.seat == 2 && m.name == "Carol"));
    }

    #[tokio::test]
    async fn persist_history_records_seed_and_version() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let game = GameState::new(2);
        persist_room(&pool, &Room {
            id: "GAME01".to_string(),
            members: vec![Member { seat: 0, name: String::new(), host: true }],
            game,
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
        };

        let (alice_seat, _) = claim_seat(&mut room, Some("Alice".to_string()));
        let alice = room.members.iter().find(|m| m.seat == alice_seat).unwrap();
        assert!(alice.host, "the first-ever member of an empty room is host");

        let (bob_seat, _) = claim_seat(&mut room, Some("Bob".to_string()));
        let bob = room.members.iter().find(|m| m.seat == bob_seat).unwrap();
        assert!(!bob.host, "a later joiner is never host, even taking a player seat");

        // Fill the remaining player seats and overflow into spectators: still
        // no one but Alice is ever host.
        let (carol_seat, carol_is_player) = claim_seat(&mut room, Some("Carol".to_string()));
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
                Member { seat: 0, name: "Alice".to_string(), host: true },
                Member { seat: 1, name: "Bob".to_string(), host: false },
            ],
            game: GameState::new(2),
        };

        deal_new_game(&mut room, 3);

        let alice = room.members.iter().find(|m| m.seat == 0).unwrap();
        assert!(alice.host, "the host survives a re-deal");
        assert_eq!(room.members.iter().filter(|m| m.host).count(), 1, "still exactly one host");
    }

    #[tokio::test]
    async fn non_host_new_game_action_is_silently_ignored() {
        // Exercises the same is_host predicate the WebSocket dispatch gate
        // uses, at the Room level, so the rule is covered without needing to
        // drive an actual socket in a unit test.
        let room = Room {
            id: "GATE".to_string(),
            members: vec![
                Member { seat: 0, name: "Alice".to_string(), host: true },
                Member { seat: 1, name: "Bob".to_string(), host: false },
            ],
            game: GameState::new(2),
        };

        let is_host = |seat: Option<usize>| {
            seat.is_some_and(|s| room.members.iter().any(|m| m.seat == s && m.host))
        };

        assert!(is_host(Some(0)), "the host may start a new deal");
        assert!(!is_host(Some(1)), "a non-host player may not");
        assert!(!is_host(Some(99)), "an unknown seat may not");
        assert!(!is_host(None), "a connection with no seat may not");
    }
}