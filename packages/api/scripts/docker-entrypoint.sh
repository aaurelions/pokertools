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

# ----- Synchronise database schema ---------------------------------------
echo "--- Syncing database schema ---"
cd /app/packages/api

# Runtime sync via the JS helper (better-sqlite3 + schema.sql).
# For SQLite it bootstraps the database if empty; for other datasources
# (e.g. PostgreSQL) it logs a message and exits cleanly — external
# migration tooling should be used in those environments.
node scripts/sync-db.mjs

echo "--- Schema sync complete ---"

# ----- Start the API server -------------------------------------------------
echo "--- Starting API server on 0.0.0.0:${PORT:-3000} ---"
exec node /app/packages/api/dist/server.js
