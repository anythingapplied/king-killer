use axum::{
    extract::{Path, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::services::{ServeDir, ServeFile};
use king_killer_core::GameState;
use serde::{Deserialize, Serialize};
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
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "payload")]
enum ServerMessage {
    State(GameState),
    Shutdown { reason: String },
}

fn idle_timeout() -> Duration {
    let minutes = std::env::var("IDLE_TIMEOUT_MINUTES")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(40.0);
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

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let state = AppState {
        games: Arc::new(RwLock::new(HashMap::new())),
        broadcasts: Arc::new(RwLock::new(HashMap::new())),
        occupied_seats: Arc::new(RwLock::new(HashMap::new())),
        last_activity: Arc::new(RwLock::new(Instant::now())),
    };

    let idle_check_state = state.clone();
    tokio::spawn(async move {
        let timeout = idle_timeout();
        let mut check = tokio::time::interval(Duration::from_secs(5));
        loop {
            check.tick().await;
            let idle = idle_check_state.last_activity.read().unwrap().elapsed();
            if idle >= timeout {
                let minutes = (idle.as_secs() / 60).max(1);
                    let unit = if minutes == 1 { "minute" } else { "minutes" };
                    let reason = format!(
                        "No play for {} {} — the server stopped itself to keep costs near zero. Start a new game to play again.",
                        minutes, unit
                    );
                let broadcasts = idle_check_state.broadcasts.read().unwrap();
                for tx in broadcasts.values() {
                    let _ = tx.send(ServerMessage::Shutdown {
                        reason: reason.clone(),
                    });
                }
                *idle_check_state.last_activity.write().unwrap() = Instant::now();
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
    UseSoloJester,
    Reset,
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

    let game_state = GameState::new(payload.num_players);
    state.games.write().unwrap().insert(id.clone(), game_state.clone());
    
    let (tx, _) = broadcast::channel(100);
    state.broadcasts.write().unwrap().insert(id.clone(), tx);
    
    // Mark seat 0 as taken by creator
    let mut seats = vec![false; payload.num_players as usize];
    seats[0] = true;
    state.occupied_seats.write().unwrap().insert(id.clone(), seats);
    
    Json(GameResponse { id, state: game_state })
}

#[derive(Serialize)]
struct JoinResponse {
    seat_index: usize,
}

async fn join_game_seat(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<JoinResponse>, axum::http::StatusCode> {
    let mut all_occupied = state.occupied_seats.write().unwrap();
    if let Some(seats) = all_occupied.get_mut(&id) {
        let free_seats: Vec<usize> = seats.iter().enumerate()
            .filter(|&(_, &occupied)| !occupied)
            .map(|(i, _)| i)
            .collect();
        
        if let Some(&seat) = free_seats.choose(&mut rand::rng()) {
            seats[seat] = true;
            touch(&state.last_activity);
            Ok(Json(JoinResponse { seat_index: seat }))
        } else {
            Err(axum::http::StatusCode::FORBIDDEN)
        }
    } else {
        Err(axum::http::StatusCode::NOT_FOUND)
    }
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
                let mut games = state_recv.games.write().unwrap();
                if let Some(game) = games.get_mut(&id) {
                    let _ = match action {
                        GameAction::PlayCards { indices } => game.play_cards(indices),
                        GameAction::Yield => game.yield_turn(),
                        GameAction::DiscardCards { indices } => game.discard_cards(indices),
                        GameAction::UseSoloJester => game.use_solo_jester(),
                        GameAction::Reset => {
                            let num_players = game.players.len() as u32;
                            *game = GameState::new(num_players);
                            Ok(())
                        }
                    };

                    let broadcasts = state_recv.broadcasts.read().unwrap();
                    if let Some(tx) = broadcasts.get(&id) {
                        let _ = tx.send(ServerMessage::State(game.clone()));
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
