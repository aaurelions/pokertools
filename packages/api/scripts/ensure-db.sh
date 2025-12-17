#!/bin/bash
# Ensures database and Redis are ready before starting the API
# This script checks if the database file exists and creates it if needed

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

# Parse DATABASE_URL from appropriate .env file to get the database path
DB_PATH=$(grep "^DATABASE_URL=" "$ENV_FILE" 2>/dev/null | cut -d'"' -f2 | sed 's/file://')

# If DATABASE_URL not found, use default
if [ -z "$DB_PATH" ]; then
  DB_PATH="$DEFAULT_DB_PATH"
fi

# Convert relative path to absolute from prisma directory
DB_FILE="prisma/$DB_PATH"

# Check if database file exists
if [ ! -f "$DB_FILE" ]; then
  echo "📦 Database not found at $DB_FILE, creating..."
  npx prisma db push --skip-generate --accept-data-loss
  echo "✅ Database created successfully!"
else
  echo "✅ Database found at $DB_FILE"
fi
