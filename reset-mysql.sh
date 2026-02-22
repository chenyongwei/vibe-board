#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILES=(-f "$ROOT_DIR/docker-compose.yml")

DB_NAME="${MYSQL_DATABASE:-vibe_board}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-vibe_root}"

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

if [[ ! "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "[error] MYSQL_DATABASE contains unsupported characters: $DB_NAME"
  exit 1
fi

if ! (cd "$ROOT_DIR" && compose ps --services --status running | grep -qx mysql); then
  echo "[start] mysql service is not running, starting it..."
  (cd "$ROOT_DIR" && compose up -d mysql)
fi

echo "[wait] waiting for mysql to become ready..."
ready=0
for _ in $(seq 1 30); do
  if (cd "$ROOT_DIR" && compose exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql mysqladmin -uroot ping >/dev/null 2>&1); then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" != "1" ]; then
  echo "[error] mysql is not ready after timeout."
  exit 1
fi

echo "[reset] Dropping and recreating database: $DB_NAME"
(cd "$ROOT_DIR" && compose exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql sh -c "mysql -uroot -e \"DROP DATABASE IF EXISTS \\\`$DB_NAME\\\`; CREATE DATABASE \\\`$DB_NAME\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\"")

echo "[reset] Restarting api service to reinitialize schema..."
(cd "$ROOT_DIR" && compose restart api >/dev/null)

echo "[done] mysql database reset complete: $DB_NAME"
