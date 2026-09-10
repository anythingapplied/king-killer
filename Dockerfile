# Build frontend
FROM node:22-bookworm AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build backend
FROM rust:bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY king-killer-core ./king-killer-core
COPY king-killer-api ./king-killer-api
RUN cargo build --release --locked

# Runtime
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/king-killer-api /app/king-killer-api
COPY --from=frontend /app/frontend/dist /app/frontend/dist
ENV PORT=3000
EXPOSE 3000
CMD ["/app/king-killer-api"]