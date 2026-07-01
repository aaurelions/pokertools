#!/bin/sh
# =============================================================================
# postgres-restore.sh — Restore a PostgreSQL database from a compressed backup
#
# Designed to run on a host with psql/gunzip and network access to the DB.
# Can target the local Docker Postgres (via the compose network) or any
# accessible PostgreSQL instance.
#
# Usage:
#   # Restore the latest backup:
#   BACKUP_DIR=/backups ./deploy/postgres-restore.sh
#
#   # Restore a specific backup file:
#   BACKUP_DIR=/backups BACKUP_FILE=backup-20260701-120000.sql.gz ./deploy/postgres-restore.sh
#
# Environment variables:
#   PGHOST               PostgreSQL hostname (required)
#   PGPORT               PostgreSQL port (default 5432)
#   PGUSER               PostgreSQL user (required)
#   PGPASSWORD            PostgreSQL password (required)
#   PGDATABASE           Target database name (required)
#   BACKUP_DIR           Directory containing backup files (required)
#   BACKUP_FILE          Specific backup file to restore. If unset, the latest
#                         backup-*.sql.gz file in BACKUP_DIR is used.
#
# Exit codes:
#   0 — restore completed successfully
#   1 — missing required environment variable
#   2 — no backup files found
#   3 — psql restore failed
# =============================================================================

set -eu

# ---- Validate required environment variables ----
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

PGPORT="${PGPORT:-5432}"

export PGPASSWORD

# ---- Determine which backup file to restore ----
if [ -n "${BACKUP_FILE:-}" ]; then
    BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILE}"
    if [ ! -f "${BACKUP_PATH}" ]; then
        echo "ERROR: Specified backup file not found: ${BACKUP_PATH}" >&2
        exit 2
    fi
else
    BACKUP_PATH="$(find "${BACKUP_DIR}" -name "backup-*.sql.gz" -type f | sort | tail -1)"
    if [ -z "${BACKUP_PATH}" ]; then
        echo "ERROR: No backup files found in ${BACKUP_DIR}" >&2
        exit 2
    fi
fi

BACKUP_SIZE="$(du -h "${BACKUP_PATH}" | cut -f1)"
BACKUP_NAME="$(basename "${BACKUP_PATH}")"

echo "============================================================================="
echo "  PostgreSQL Restore"
echo "  Target:   ${PGHOST}:${PGPORT}/${PGDATABASE}"
echo "  Backup:   ${BACKUP_NAME} (${BACKUP_SIZE})"
echo "  Time:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================================="

# ---- Confirm before proceeding when connected to a real database ----
if [ -z "${SKIP_CONFIRM:-}" ]; then
    printf "\nWARNING: This will DROP and recreate all data in '%s'!\n" "${PGDATABASE}"
    printf "Are you sure you want to continue? (yes/no): "
    read -r CONFIRM
    if [ "${CONFIRM}" != "yes" ]; then
        echo "Restore cancelled."
        exit 0
    fi
fi

# ---- Restore ----
echo ""
echo "--- Restoring ${BACKUP_NAME} to ${PGDATABASE} ---"

if gunzip -c "${BACKUP_PATH}" | psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="${PGDATABASE}" \
    --echo-errors \
    --set=ON_ERROR_STOP=1 \
    2>&1; then
    echo ""
    echo "--- Restore completed successfully ---"
else
    echo ""
    echo "ERROR: psql restore failed — database may be in an inconsistent state." >&2
    exit 3
fi
