#!/bin/bash
# ============================================================================
# Database reset script
# Usage: bash scripts/db-reset.sh docker
# ============================================================================

set -e

MODE=${1:-local}

if [ "$MODE" == "docker" ]; then
  echo "Resetting Docker database..."
  docker compose -f docker-compose.infra.yml down -v
  docker compose -f docker-compose.infra.yml up -d
  echo "Waiting for PostgreSQL to be ready..."
  sleep 5
  echo "Running migrations..."
  yarn db:migrate
  echo "✅ Database reset complete."
else
  echo "Usage: bash scripts/db-reset.sh docker"
  echo "  docker  — Recreate the Docker PostgreSQL container and re-run migrations"
fi
