#!/bin/bash
# Stops the background Redis server started by ensure-redis.sh

RUNTIME_DIR="$PWD/.runtime"
REDIS_PID_FILE="$RUNTIME_DIR/redis.pid"

if [ -f "$REDIS_PID_FILE" ]; then
    PID=$(cat "$REDIS_PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "🛑 Stopping Redis (PID: $PID)..."
        redis-cli shutdown
        rm -f "$REDIS_PID_FILE"
        echo "✅ Redis stopped"
    else
        echo "⚠️  Redis PID file exists but process not running"
        rm -f "$REDIS_PID_FILE"
    fi
else
    # Try to stop Redis anyway
    if redis-cli ping &> /dev/null; then
        echo "🛑 Stopping Redis..."
        redis-cli shutdown
        echo "✅ Redis stopped"
    else
        echo "✅ Redis is not running"
    fi
fi
