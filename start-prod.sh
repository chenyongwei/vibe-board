#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$ROOT_DIR/agent"
COMPOSE_FILES=(-f "$ROOT_DIR/docker-compose.yml")

SERVER_LOG="${SERVER_LOG:-$ROOT_DIR/.prod-server.log}"
AGENT_BUILD_LOG="${AGENT_BUILD_LOG:-$ROOT_DIR/.prod-agent-build.log}"
BUILD_AGENT_RELEASE="${BUILD_AGENT_RELEASE:-1}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1"
    exit 1
  fi
}

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

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

echo "[start] Building and starting production services (mysql/api/ui/gateway)..."
(cd "$ROOT_DIR" && compose up -d --build --remove-orphans)

echo "[start] Capturing service status/log snapshot -> $SERVER_LOG"
(
  cd "$ROOT_DIR"
  compose ps
  echo
  compose logs --no-color --tail=100 mysql api ui gateway
) >"$SERVER_LOG" 2>&1 || true

if [ "$BUILD_AGENT_RELEASE" = "1" ]; then
  if [ ! -d "$AGENT_DIR/node_modules" ] || [ ! -x "$AGENT_DIR/node_modules/.bin/pkg" ]; then
    echo "[setup] Installing agent dependencies..."
    (cd "$AGENT_DIR" && npm install)
  fi

  echo "[build] Building agent release packages..."
  : >"$AGENT_BUILD_LOG"
  (cd "$AGENT_DIR" && npm run package:agent) | tee -a "$AGENT_BUILD_LOG"
  echo "[ready] Agent release output: $AGENT_DIR/release"
  echo "[ready] Agent build log: $AGENT_BUILD_LOG"
fi

echo "[ready] Dashboard: http://localhost:61100/"
echo "[ready] API: http://localhost:61100/api/*"
echo "[ready] Server snapshot log: $SERVER_LOG"
echo "[info] Stop services with: docker compose -f docker-compose.yml down"
