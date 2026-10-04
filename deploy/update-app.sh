#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DV_AUTO_DIR:-/opt/DV-auto}"
COMPOSE_FILE="${DV_AUTO_COMPOSE_FILE:-docker-compose.yml}"

cd "$APP_DIR"

echo "[update-app] Updating source..."
git pull --ff-only

echo "[update-app] Validating Docker Compose configuration..."
docker compose -f "$COMPOSE_FILE" config -q

echo "[update-app] Building and restarting container..."
docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

echo "[update-app] Current status:"
docker compose -f "$COMPOSE_FILE" ps

echo "[update-app] Done."
