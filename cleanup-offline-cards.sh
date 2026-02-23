#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILES=(-f "$ROOT_DIR/docker-compose.yml")

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

if ! docker compose version >/dev/null 2>&1; then
  echo "[error] docker compose is unavailable. Please install Docker Compose v2."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[error] Docker daemon is not running."
  exit 1
fi

if ! (cd "$ROOT_DIR" && compose ps --services --status running | grep -qx api); then
  echo "[error] api service is not running."
  echo "[hint] Start services first, e.g. ./start-dev.sh or ./start-prod.sh"
  exit 1
fi

echo "[run] Cleaning offline card data via api container..."
(cd "$ROOT_DIR" && compose exec -T api node scripts/cleanup-offline-cards.js "$@")
