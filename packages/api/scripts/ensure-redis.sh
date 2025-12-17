#!/bin/bash
# Ensures Redis is running before starting the API
# Auto-starts Redis in the background if not running

set -e

# Create runtime directory for all temporary/generated files
RUNTIME_DIR="$PWD/.runtime"
mkdir -p "$RUNTIME_DIR"

# Check if redis-server is installed
if ! command -v redis-server &> /dev/null; then
    echo "❌ redis-server is not installed!"
    echo ""
    echo "Please install Redis:"
    echo "  macOS:   brew install redis"
    echo "  Ubuntu:  sudo apt-get install redis-server"
    echo "  Other:   https://redis.io/download"
    echo ""
    exit 1
fi

# Check if Redis is already running
if redis-cli ping &> /dev/null; then
    echo "✅ Redis is already running"
    exit 0
fi

# Start Redis in the background
echo "🚀 Starting Redis server in the background..."

# Store all Redis files in runtime directory
REDIS_PID_FILE="$RUNTIME_DIR/redis.pid"
REDIS_LOG_FILE="$RUNTIME_DIR/redis.log"
REDIS_DATA_DIR="$RUNTIME_DIR/redis-data"
mkdir -p "$REDIS_DATA_DIR"

# Start Redis with custom config for development
redis-server --daemonize yes \
             --pidfile "$REDIS_PID_FILE" \
             --logfile "$REDIS_LOG_FILE" \
             --dir "$REDIS_DATA_DIR" \
             --bind 127.0.0.1 \
             --port 6379 \
             --save "" \
             --appendonly no

# Wait for Redis to be ready
for i in {1..10}; do
    if redis-cli ping &> /dev/null; then
        echo "✅ Redis started successfully (PID: $(cat $REDIS_PID_FILE))"
        exit 0
    fi
    sleep 0.5
done

echo "❌ Failed to start Redis"
exit 1
