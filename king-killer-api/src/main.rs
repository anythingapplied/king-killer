use axum::{
    extract::{Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::services::{ServeDir, ServeFile};
use king_killer_core::GameState;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use futures::{SinkExt, StreamExt};
use tower_http::cors::{Any, CorsLayer};
use rand::seq::IndexedRandom;
use rand::RngExt;

#[derive(Clone)]
struct AppState {
    games: Arc<RwLock<HashMap<String, GameState>>>,
    broadcasts: Arc<RwLock<HashMap<String, broadcast::Sender<ServerMessage>>>>,
    occupied_seats: Arc<RwLock<HashMap<String, Vec<bool>>>>,
    last_activity: Arc<RwLock<Instant>>,
    db: SqlitePool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
enum ServerMessage {
    State(GameState),
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

async fn persist_game(db: &SqlitePool, id: &str, game: &GameState) {
    let state_json = serde_json::to_string(game).unwrap();
    let _ = sqlx::query(
        "INSERT INTO games (id, state_json, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) \
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(id)
    .bind(&state_json)
    .execute(db)
    .await;
}

async fn persist_seats(db: &SqlitePool, id: &str, seats: &[bool]) {
    let json = serde_json::to_string(seats).unwrap();
    let _ = sqlx::query(
        "UPDATE games SET occupied_seats = ?1 WHERE id = ?2",
    )
    .bind(&json)
    .bind(id)
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

async fn load_games(db: &SqlitePool) -> (HashMap<String, GameState>, HashMap<String, Vec<bool>>) {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, state_json, occupied_seats FROM games")
            .fetch_all(db)
            .await
            .unwrap_or_default();

    let mut games = HashMap::new();
    let mut occupied_seats = HashMap::new();
    for (id, state_json, seats_json) in rows {
        if let Ok(game_state) = serde_json::from_str::<GameState>(&state_json) {
            let seats: Vec<bool> = serde_json::from_str(&seats_json)
                .unwrap_or_else(|_| game_state.players.iter().map(|p| !p.name.is_empty()).collect());
            occupied_seats.insert(id.clone(), seats);
            games.insert(id, game_state);
        }
    }
    (games, occupied_seats)
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

    let (loaded_games, loaded_seats) = load_games(&pool).await;
    tracing::info!("loaded {} games from database", loaded_games.len());

    let mut broadcasts = HashMap::new();
    for id in loaded_games.keys() {
        let (tx, _) = broadcast::channel(100);
        broadcasts.insert(id.clone(), tx);
    }

    let state = AppState {
        games: Arc::new(RwLock::new(loaded_games)),
        broadcasts: Arc::new(RwLock::new(broadcasts)),
        occupied_seats: Arc::new(RwLock::new(loaded_seats)),
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

#[derive(Serialize, Deserialize)]
struct GameResponse {
    id: String,
    state: GameState,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "payload")]
enum GameAction {
    PlayCards { indices: Vec<usize> },
    Yield,
    DiscardCards { indices: Vec<usize> },
    ChooseNextPlayer { index: usize },
    UseSoloJester,
    Reset,
    SetName { seat: usize, name: String },
}

async fn create_game(
    State(state): State<AppState>,
    Json(payload): Json<CreateGameRequest>,
) -> impl IntoResponse {
    touch(&state.last_activity);
    let mut id = generate_game_code();
    {
        let games = state.games.read().unwrap();
        while games.contains_key(&id) {
            id = generate_game_code();
        }
    }

    let mut game_state = GameState::new(payload.num_players);
    if let Some(name) = &payload.player_name {
        if let Some(player) = game_state.players.first_mut() {
            player.name = name.clone();
        }
    }
    state.games.write().unwrap().insert(id.clone(), game_state.clone());
    persist_game(&state.db, &id, &game_state).await;
    
    let (tx, _) = broadcast::channel(100);
    state.broadcasts.write().unwrap().insert(id.clone(), tx);
    
    // Mark seat 0 as taken by creator
    let mut seats = vec![false; payload.num_players as usize];
    seats[0] = true;
    state.occupied_seats.write().unwrap().insert(id.clone(), seats.clone());
    persist_seats(&state.db, &id, &seats).await;
    
    Json(GameResponse { id, state: game_state })
}

#[derive(Serialize, Deserialize)]
struct JoinRequest {
    name: Option<String>,
}

#[derive(Serialize)]
struct JoinResponse {
    seat_index: usize,
}

async fn join_game_seat(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<JoinRequest>,
) -> Result<Json<JoinResponse>, axum::http::StatusCode> {
    let seat = {
        let mut all_occupied = state.occupied_seats.write().unwrap();
        match all_occupied.get_mut(&id) {
            Some(seats) => {
                let free_seats: Vec<usize> = seats.iter().enumerate()
                    .filter(|&(_, &occupied)| !occupied)
                    .map(|(i, _)| i)
                    .collect();
                if let Some(&seat) = free_seats.choose(&mut rand::rng()) {
                    seats[seat] = true;
                    Some(seat)
                } else {
                    None
                }
            }
            None => return Err(axum::http::StatusCode::NOT_FOUND),
        }
    };

    let seat = match seat {
        Some(seat) => seat,
        None => return Err(axum::http::StatusCode::FORBIDDEN),
    };

    // Persist the seat assignment; the mutation already happened under the lock.
    let persisted_seats = state.occupied_seats.read().unwrap().get(&id).cloned();
    if let Some(seats) = persisted_seats {
        persist_seats(&state.db, &id, &seats).await;
    }

    if let Some(name) = &payload.name {
        let game_clone = {
            let mut games = state.games.write().unwrap();
            games.get_mut(&id).map(|game| {
                if let Some(player) = game.players.get_mut(seat) {
                    player.name = name.clone();
                }
                game.clone()
            })
        };
        if let Some(game) = game_clone {
            persist_game(&state.db, &id, &game).await;
        }
    }

    touch(&state.last_activity);
    Ok(Json(JoinResponse { seat_index: seat }))
}

async fn get_game(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<GameState>, axum::http::StatusCode> {
    let games = state.games.read().unwrap();
    if let Some(game) = games.get(&id) {
        touch(&state.last_activity);
        Ok(Json(game.clone()))
    } else {
        Err(axum::http::StatusCode::NOT_FOUND)
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, id, state))
}

async fn handle_socket(socket: WebSocket, id: String, state: AppState) {
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

    // Push the current state immediately so a newly-connected client renders
    let initial_state = {
        let games = state.games.read().unwrap();
        games.get(&id).cloned()
    };
    if let Some(game) = initial_state {
        let msg = serde_json::to_string(&ServerMessage::State(game)).unwrap();
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
                let action_type = match &action {
                    GameAction::PlayCards { .. } => "play_cards",
                    GameAction::Yield => "yield",
                    GameAction::DiscardCards { .. } => "discard_cards",
                    GameAction::ChooseNextPlayer { .. } => "choose_next_player",
                    GameAction::UseSoloJester => "use_solo_jester",
                    GameAction::Reset => "reset",
                    GameAction::SetName { .. } => "set_name",
                };

                let game_clone = {
                    let mut games = state_recv.games.write().unwrap();
                    games.get_mut(&id).map(|game| {
                        let old_names: Vec<String> = game.players.iter().map(|p| p.name.clone()).collect();
                        let _ = match &action {
                            GameAction::PlayCards { indices } => game.play_cards(indices.clone()),
                            GameAction::Yield => game.yield_turn(),
                            GameAction::DiscardCards { indices } => game.discard_cards(indices.clone()),
                            GameAction::ChooseNextPlayer { index } => game.choose_next_player(*index),
                            GameAction::UseSoloJester => game.use_solo_jester(),
                            GameAction::Reset => {
                                let num_players = game.players.len() as u32;
                                *game = GameState::new(num_players);
                                for (i, name) in old_names.iter().enumerate() {
                                    if let Some(player) = game.players.get_mut(i) {
                                        player.name = name.clone();
                                    }
                                }
                                Ok(())
                            }
                            GameAction::SetName { seat, name } => {
                                if let Some(player) = game.players.get_mut(*seat) {
                                    player.name = name.clone();
                                }
                                Ok(())
                            }
                        };
                        game.clone()
                    })
                };

                if let Some(game) = game_clone {
                    record_history(&state_recv.db, &id, action_type, &action, &game).await;
                    persist_game(&state_recv.db, &id, &game).await;

                    let broadcasts = state_recv.broadcasts.read().unwrap();
                    if let Some(tx) = broadcasts.get(&id) {
                        let _ = tx.send(ServerMessage::State(game));
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

        // Create a 2-player game with a NAMELESS creator (the resume case),
        // fill both seats, then make a move.
        let mut game = GameState::new(2);
        let seats = vec![true, true];
        let _ = game.play_cards(vec![0]);

        persist_game(&pool, "TEST01", &game).await;
        persist_seats(&pool, "TEST01", &seats).await;

        // Simulate a server restart: everything must be reconstructed from the DB.
        let (games, seats_loaded) = load_games(&pool).await;
        let loaded = games.get("TEST01").expect("game must be loaded");
        assert_eq!(
            serde_json::to_string(&game).unwrap(),
            serde_json::to_string(loaded).unwrap()
        );
        // Seat occupancy is persisted explicitly, so a nameless player keeps
        // their seat across a restart.
        assert_eq!(seats_loaded.get("TEST01").unwrap(), &seats);

        // A later action must also survive a reload unchanged.
        let _ = game.play_cards(vec![0]);
        persist_game(&pool, "TEST01", &game).await;
        let (games2, _) = load_games(&pool).await;
        assert_eq!(
            serde_json::to_string(&game).unwrap(),
            serde_json::to_string(games2.get("TEST01").unwrap()).unwrap()
        );
    }

    #[tokio::test]
    async fn nameless_creator_keeps_seat_after_reload() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let game = GameState::new(3);
        persist_game(&pool, "SEATS", &game).await;
        persist_seats(&pool, "SEATS", &[true, false, true]).await;

        let (_, seats) = load_games(&pool).await;
        assert_eq!(seats.get("SEATS").unwrap(), &vec![true, false, true]);
    }

    #[tokio::test]
    async fn persist_history_records_seed_and_version() {
        let pool = test_pool().await;
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let game = GameState::new(2);
        persist_game(&pool, "GAME01", &game).await;
        record_history(&pool, "GAME01", "yield", &GameAction::Yield, &game).await;

        let (seed, version): (i64, i64) =
            sqlx::query_as("SELECT seed, version FROM game_history")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(seed, game.seed as i64);
        assert_eq!(version, game.version as i64);
    }
}
