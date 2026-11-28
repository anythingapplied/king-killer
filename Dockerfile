# Build frontend
FROM node:26-bookworm AS frontend
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
RUN mkdir -p /data
COPY --from=backend /app/target/release/king-killer-api /app/king-killer-api
COPY --from=frontend /app/frontend/dist /app/frontend/dist
ENV PORT=3000
ENV DATA_DIR=/data
# The commit this image was built from, reported by GET /api/health so a
# deployment can be checked against what was meant to ship. Pass it in:
#   fly deploy --build-arg GIT_COMMIT=$(git rev-parse HEAD)
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
EXPOSE 3000
CMD ["/app/king-killer-api"]