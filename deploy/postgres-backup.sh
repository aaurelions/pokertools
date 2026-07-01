#!/bin/sh
# =============================================================================
# postgres-backup.sh — Create a compressed PostgreSQL backup with pg_dump
#
# Designed to run inside the backup Docker service or directly on a host
# that has pg_dump installed and network access to the database.
#
# Environment variables (all required):
#   PGHOST               PostgreSQL hostname
#   PGPORT               PostgreSQL port (default 5432)
#   PGUSER               PostgreSQL user
#   PGPASSWORD            PostgreSQL password
#   PGDATABASE           Database name to back up
#   BACKUP_DIR           Directory to write backup files (default /backups)
#   BACKUP_RETENTION_DAYS Number of days to keep backups (default 7)
#
# Output:
#   ${BACKUP_DIR}/backup-YYYYMMDD-HHMMSS.sql.gz
#
# Exit codes:
#   0 — backup created successfully
#   1 — missing required environment variable
#   2 — pg_dump failed
# =============================================================================

set -eu

# ---- Validate required environment variables ----
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

PGPORT="${PGPORT:-5432}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

export PGPASSWORD

# ---- Create backup directory if it does not exist ----
mkdir -p "${BACKUP_DIR}"

# ---- Generate timestamped filename ----
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/backup-${TIMESTAMP}.sql.gz"
TMP_FILE="${BACKUP_DIR}/backup-${TIMESTAMP}.sql"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting backup of '${PGDATABASE}' on ${PGHOST}:${PGPORT}"

# ---- Run pg_dump ----
# --no-owner / --no-acl: omit role-dependent statements so restores are portable
# --compress=0: pipe uncompressed SQL to gzip ourselves for better control
# --clean / --if-exists: include DROP statements for idempotent restores
# --quote-all-identifiers: avoid reserved-word collisions
if pg_dump \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="${PGDATABASE}" \
    --no-owner \
    --no-acl \
    --clean \
    --if-exists \
    --quote-all-identifiers \
    --format=plain \
    --compress=0 \
    --file="${TMP_FILE}"; then

    gzip -f "${TMP_FILE}"

    BACKUP_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup written: ${BACKUP_FILE} (${BACKUP_SIZE})"
else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: pg_dump failed" >&2
    rm -f "${BACKUP_FILE}" "${TMP_FILE}"
    exit 2
fi

# ---- Remove backups older than retention period ----
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Cleaning up backups older than ${BACKUP_RETENTION_DAYS} days..."

find "${BACKUP_DIR}" -name "backup-*.sql.gz" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print | while IFS= read -r old_file; do
    echo "  Removing: ${old_file}"
    rm -f "${old_file}"
done

# Count how many backups remain
REMAINING="$(find "${BACKUP_DIR}" -name "backup-*.sql.gz" -type f | wc -l | tr -d ' ')"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Retention: ${REMAINING} backup(s) now stored."
