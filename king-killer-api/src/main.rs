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
use uuid::Uuid;
use tokio::sync::broadcast;
use futures::{SinkExt, StreamExt};
use tower_http::cors::{Any, CorsLayer};
use rand::seq::IndexedRandom;

#[derive(Clone)]
struct AppState {
    games: Arc<RwLock<HashMap<Uuid, GameState>>>,
    broadcasts: Arc<RwLock<HashMap<Uuid, broadcast::Sender<GameState>>>>,
    occupied_seats: Arc<RwLock<HashMap<Uuid, Vec<bool>>>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let state = AppState {
        games: Arc::new(RwLock::new(HashMap::new())),
        broadcasts: Arc::new(RwLock::new(HashMap::new())),
        occupied_seats: Arc::new(RwLock::new(HashMap::new())),
    };

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
    id: Uuid,
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
    let id = Uuid::new_v4();
    let game_state = GameState::new(payload.num_players);
    state.games.write().unwrap().insert(id, game_state.clone());
    
    let (tx, _) = broadcast::channel(100);
    state.broadcasts.write().unwrap().insert(id, tx);
    
    // Mark seat 0 as taken by creator
    let mut seats = vec![false; payload.num_players as usize];
    seats[0] = true;
    state.occupied_seats.write().unwrap().insert(id, seats);
    
    Json(GameResponse { id, state: game_state })
}

#[derive(Serialize)]
struct JoinResponse {
    seat_index: usize,
}

async fn join_game_seat(
    Path(id): Path<Uuid>,
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
            Ok(Json(JoinResponse { seat_index: seat }))
        } else {
            Err(axum::http::StatusCode::FORBIDDEN)
        }
    } else {
        Err(axum::http::StatusCode::NOT_FOUND)
    }
}

async fn get_game(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<GameState>, axum::http::StatusCode> {
    let games = state.games.read().unwrap();
    if let Some(game) = games.get(&id) {
        Ok(Json(game.clone()))
    } else {
        Err(axum::http::StatusCode::NOT_FOUND)
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, id, state))
}

async fn handle_socket(socket: WebSocket, id: Uuid, state: AppState) {
    let rx = {
        let broadcasts = state.broadcasts.read().unwrap();
        if let Some(tx) = broadcasts.get(&id) {
            tx.subscribe()
        } else {
            return;
        }
    };

    let (mut sender, mut receiver) = socket.split();

    let mut rx = rx;
    let mut send_task = tokio::spawn(async move {
        while let Ok(game_state) = rx.recv().await {
            let msg = serde_json::to_string(&game_state).unwrap();
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
                        let _ = tx.send(game.clone());
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}
