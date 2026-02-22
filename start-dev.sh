#!/usr/bin/env bash
set -euo pipefail
set -m

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$ROOT_DIR/agent"
COMPOSE_FILES=(-f "$ROOT_DIR/docker-compose.yml" -f "$ROOT_DIR/docker-compose.dev.yml")

SERVER_LOG="${SERVER_LOG:-$ROOT_DIR/.dev-server.log}"
AGENT_LOG="${AGENT_LOG:-$ROOT_DIR/.dev-agent.log}"
AGENT_CONFIG_PATH="${AGENT_CONFIG_PATH:-$AGENT_DIR/agent.config.json}"
AGENT_CONFIG_TEMPLATE="$AGENT_DIR/agent.config.example.json"
KEEP_DOCKER_ON_EXIT="${KEEP_DOCKER_ON_EXIT:-0}"

DOCKER_LOG_PID=""
AGENT_PID=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1"
    exit 1
  fi
}

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

cleanup() {
  set +e
  if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
    kill -- "-$AGENT_PID" 2>/dev/null || kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
  if [ -n "$DOCKER_LOG_PID" ] && kill -0 "$DOCKER_LOG_PID" 2>/dev/null; then
    kill -- "-$DOCKER_LOG_PID" 2>/dev/null || kill "$DOCKER_LOG_PID" 2>/dev/null || true
    wait "$DOCKER_LOG_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_DOCKER_ON_EXIT" != "1" ]; then
    (cd "$ROOT_DIR" && compose down --remove-orphans >/dev/null 2>&1) || true
  fi
}

trap cleanup EXIT
trap 'exit 0' INT TERM

require_cmd docker
require_cmd npm

if ! docker compose version >/dev/null 2>&1; then
  echo "[error] docker compose is unavailable. Please install Docker Compose v2."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[error] Docker daemon is not running."
  exit 1
fi

if [ ! -f "$AGENT_CONFIG_PATH" ]; then
  if [ ! -f "$AGENT_CONFIG_TEMPLATE" ]; then
    echo "[error] Missing template: $AGENT_CONFIG_TEMPLATE"
    exit 1
  fi
  cp "$AGENT_CONFIG_TEMPLATE" "$AGENT_CONFIG_PATH"
  echo "[setup] Created agent config: $AGENT_CONFIG_PATH"
fi

if [ ! -d "$AGENT_DIR/node_modules" ] || [ ! -x "$AGENT_DIR/node_modules/.bin/nodemon" ]; then
  echo "[setup] Installing agent dependencies..."
  (cd "$AGENT_DIR" && npm install)
fi

: > "$SERVER_LOG"
: > "$AGENT_LOG"

echo "[start] Starting docker services in dev mode (mysql/api/ui/gateway)..."
(cd "$ROOT_DIR" && compose up -d --remove-orphans)

echo "[start] Streaming docker logs -> $SERVER_LOG"
(
  cd "$ROOT_DIR"
  compose logs -f --no-color mysql api ui gateway
) >>"$SERVER_LOG" 2>&1 &
DOCKER_LOG_PID=$!

echo "[start] Starting agent hot reload -> $AGENT_LOG"
(
  cd "$AGENT_DIR"
  exec env AGENT_CONFIG="$AGENT_CONFIG_PATH" npm run dev
) >>"$AGENT_LOG" 2>&1 &
AGENT_PID=$!

echo "[ready] Dashboard: http://localhost:61100/"
echo "[ready] API: http://localhost:61100/api/*"
echo "[ready] Agent config: $AGENT_CONFIG_PATH"
echo "[ready] Server log: $SERVER_LOG"
echo "[ready] Agent log:  $AGENT_LOG"
echo "[info] Press Ctrl+C to stop. Set KEEP_DOCKER_ON_EXIT=1 to keep docker services running."

while true; do
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    echo "[exit] agent stopped unexpectedly. See $AGENT_LOG"
    exit 1
  fi
  if ! kill -0 "$DOCKER_LOG_PID" 2>/dev/null; then
    echo "[exit] docker log stream stopped unexpectedly. See $SERVER_LOG"
    exit 1
  fi
  sleep 1
done
