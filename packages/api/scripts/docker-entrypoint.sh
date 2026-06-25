#!/bin/bash
# ---------------------------------------------------------------------------
# docker-entrypoint.sh — @pokertools/api container startup
#
# 1. Synchronises the Prisma schema for the configured datasource.
# 2. Starts the compiled API server.
#
# Environment variables expected:
#   DATABASE_URL   – Prisma datasource URL (e.g. file:.runtime/app.db)
#   NODE_ENV       – set to "production" by the Dockerfile
#   PORT, HOST, REDIS_URL, JWT_SECRET, COOKIE_SECRET, WALLET_ENCRYPTION_SECRET
# ---------------------------------------------------------------------------
set -euo pipefail

echo "=== @pokertools/api container starting ==="
echo "    NODE_ENV  = ${NODE_ENV:-production}"
echo "    PORT      = ${PORT:-3000}"

# ----- Resolve DATABASE_URL default for SQLite local dev --------------------
if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="file:.runtime/app.db"
  echo "    DATABASE_URL not set — defaulting to ${DATABASE_URL}"
fi

# Ensure the runtime directory exists (SQLite file parent)
RUNTIME_DIR="$(dirname "$(echo "$DATABASE_URL" | sed 's|^file:||')")"
mkdir -p "/app/packages/api/${RUNTIME_DIR#../}" 2>/dev/null || true
mkdir -p "/app/packages/api/.runtime" 2>/dev/null || true

# ----- Synchronise Prisma schema ------------------------------------------
echo "--- Syncing database schema ---"
cd /app/packages/api

# prisma db push synchronises the Prisma schema with the database without
# requiring a complete migration history.  --accept-data-loss allows
# non-destructive column/table drops that the schema file no longer defines.
# This is the same approach used by packages/api/scripts/ensure-db.sh and is
# safe for local development with SQLite.  In a PostgreSQL production
# environment, replace with `npx prisma migrate deploy` after ensuring a
# complete migration history exists.
npx prisma db push --accept-data-loss

echo "--- Schema sync complete ---"

# ----- Start the API server -------------------------------------------------
echo "--- Starting API server on 0.0.0.0:${PORT:-3000} ---"
exec node /app/packages/api/dist/server.js
