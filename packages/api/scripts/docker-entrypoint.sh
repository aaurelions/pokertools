#!/bin/bash
# ---------------------------------------------------------------------------
# docker-entrypoint.sh — @pokertools/api container startup
#
# 1. Validates that production secrets are NOT set to dev defaults.
# 2. Synchronises the Prisma schema for the configured datasource.
# 3. Starts the compiled API server.
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

# ---------------------------------------------------------------------------
# Production security gate — fail closed on dev/test default secrets.
# In production, every security secret MUST be explicitly provided.  Any value
# that matches a well-known dev default (from .env.example, .env.test, or the
# docker-compose fallback) will abort startup with a clear error.
# ---------------------------------------------------------------------------
if [ "${NODE_ENV:-production}" = "production" ]; then
  DEV_SECRET_PATTERNS=(
    "dev-jwt-secret-not-for-production"
    "dev-cookie-secret-not-for-production"
    "dev-wallet-encryption-secret-not-for-production"
    "CHANGE_THIS_IN_PRODUCTION"
    "test-jwt-secret"
    "e2e-jwt-secret"
  )

  check_secret() {
    local name="$1" value="$2"
    for pattern in "${DEV_SECRET_PATTERNS[@]}"; do
      if [[ "$value" == *"$pattern"* ]]; then
        echo ""
        echo "╔══════════════════════════════════════════════════════════════════╗"
        echo "║  PRODUCTION SECURITY GATE — REFUSING TO START                   ║"
        echo "╠══════════════════════════════════════════════════════════════════╣"
        echo "║  ${name} contains a dev/test default value.                ║"
        echo "║  Matched pattern: ${pattern}"
        echo "║                                                                  ║"
        echo "║  Set ${name} to a cryptographically strong random value:  ║"
        echo "║    openssl rand -base64 32                                       ║"
        echo "╚══════════════════════════════════════════════════════════════════╝"
        echo ""
        exit 1
      fi
    done
  }

  check_secret "JWT_SECRET"               "${JWT_SECRET:-}"
  check_secret "COOKIE_SECRET"            "${COOKIE_SECRET:-}"
  check_secret "WALLET_ENCRYPTION_SECRET" "${WALLET_ENCRYPTION_SECRET:-}"
fi

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
