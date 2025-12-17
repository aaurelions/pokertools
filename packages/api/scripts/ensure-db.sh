#!/bin/bash
# Ensures database and Redis are ready before starting the API
# This script ensures the database schema is in sync with Prisma schema

set -e

# Ensure Redis is running first
bash "$(dirname "$0")/ensure-redis.sh"

# Create runtime directory for all temporary/generated files
RUNTIME_DIR="$PWD/.runtime"
mkdir -p "$RUNTIME_DIR"

# Determine which .env file to use based on NODE_ENV
if [ "$NODE_ENV" = "test" ]; then
  ENV_FILE=".env.test"
  DEFAULT_DB_PATH="../.runtime/test.db"
else
  ENV_FILE=".env"
  DEFAULT_DB_PATH="../.runtime/dev.db"
fi

# Use DATABASE_URL from environment if set, otherwise parse from .env file
if [ -n "$DATABASE_URL" ]; then
  # Extract path from DATABASE_URL (handles both file:./path and file:path formats)
  DB_PATH=$(echo "$DATABASE_URL" | sed 's|^file:||')
  # Normalize: remove leading ./ if present
  DB_PATH=$(echo "$DB_PATH" | sed 's|^\./||')
  
  # If path starts with packages/api/, normalize it to be relative to packages/api directory
  # This handles GitHub Actions where DATABASE_URL is set relative to workspace root
  if [[ "$DB_PATH" == packages/api/* ]]; then
    DB_PATH="${DB_PATH#packages/api/}"
    # Convert to absolute path to ensure consistency
    ABS_DB_PATH="$(pwd)/$DB_PATH"
    export DATABASE_URL="file:$ABS_DB_PATH"
  elif [[ "$DB_PATH" != /* ]]; then
    # If it's a relative path (not absolute), convert to absolute from current directory
    ABS_DB_PATH="$(pwd)/$DB_PATH"
    export DATABASE_URL="file:$ABS_DB_PATH"
  else
    # Already absolute path, keep as is
    export DATABASE_URL
  fi
else
  # Parse DATABASE_URL from appropriate .env file to get the database path
  ENV_DB_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null | cut -d'"' -f2 || cut -d'=' -f2- | tr -d ' ' || echo "")
  if [ -n "$ENV_DB_URL" ]; then
    DB_PATH=$(echo "$ENV_DB_URL" | sed 's|^file:||' | sed 's|^\./||')
    # Convert relative paths to absolute
    if [[ "$DB_PATH" != /* ]]; then
      ABS_DB_PATH="$(pwd)/$DB_PATH"
      export DATABASE_URL="file:$ABS_DB_PATH"
    else
      export DATABASE_URL="$ENV_DB_URL"
    fi
  else
    DB_PATH="$DEFAULT_DB_PATH"
    ABS_DB_PATH="$(pwd)/$DB_PATH"
    export DATABASE_URL="file:$ABS_DB_PATH"
  fi
fi

# Extract absolute path from DATABASE_URL for file operations
DB_FILE=$(echo "$DATABASE_URL" | sed 's|^file:||')

# Ensure the directory for the database file exists
DB_DIR=$(dirname "$DB_FILE")
mkdir -p "$DB_DIR"

# Check if database file exists
if [ ! -f "$DB_FILE" ]; then
  echo "📦 Database not found at $DB_FILE, creating..."
else
  echo "✅ Database found at $DB_FILE"
fi

# Always run prisma db push to ensure schema is in sync
# This is safe because --accept-data-loss only affects data, not schema
echo "🔄 Syncing database schema..."
echo "   Using DATABASE_URL: $DATABASE_URL"
echo "   Database file: $DB_FILE"

# Ensure Prisma client is generated (it should be from build, but verify)
if [ ! -d "generated/prisma" ]; then
  echo "📦 Generating Prisma client..."
  npx prisma generate
fi

# Run prisma db push to sync schema
# We use --skip-generate since we just generated above (or it was already generated)
PUSH_OUTPUT=$(npx prisma db push --skip-generate --accept-data-loss 2>&1)
PUSH_EXIT_CODE=$?

if [ $PUSH_EXIT_CODE -ne 0 ]; then
  echo "❌ Failed to sync database schema!"
  echo "$PUSH_OUTPUT"
  exit 1
fi

# Verify that the schema was actually applied by checking if key tables exist
# This helps catch cases where db push appears to succeed but doesn't create tables
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB_FILE" ]; then
  TABLE_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='AdminWallet';" 2>/dev/null || echo "0")
  if [ "$TABLE_COUNT" = "0" ]; then
    echo "⚠️  Warning: AdminWallet table not found after db push"
    echo "   Attempting to verify all tables..."
    sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null || true
    echo "   Re-running db push without --skip-generate to ensure schema is applied..."
    npx prisma db push --accept-data-loss || exit 1
  fi
fi

echo "✅ Database schema synced successfully!"
