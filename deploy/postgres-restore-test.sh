#!/bin/sh
# =============================================================================
# postgres-restore-test.sh — Verify backup integrity in a throwaway database
#
# Creates a throwaway database, restores the latest backup into it, verifies
# that all expected core tables exist, then drops the throwaway database.
#
# This script should be run regularly (e.g. weekly cron) to validate that
# backups are restorable and contain the expected schema.
#
# Usage:
#   # Run against the compose-network Postgres:
#   PGHOST=localhost PGPORT=5432 PGUSER=pokertools PGPASSWORD=... \
#     BACKUP_DIR=./pg_backups ./deploy/postgres-restore-test.sh
#
#   # Run inside the backup container:
#   docker compose -f docker-compose.prod.yml exec backup \
#     sh -c "BACKUP_DIR=/backups ./deploy/postgres-restore-test.sh"
#
# Environment variables:
#   PGHOST               PostgreSQL hostname (required)
#   PGPORT               PostgreSQL port (default 5432)
#   PGUSER               PostgreSQL user (required, must have CREATEDB privilege)
#   PGPASSWORD            PostgreSQL password (required)
#   BACKUP_DIR           Directory containing backup files (required)
#   TEST_DB_NAME         Name of the throwaway database (default: _restore_test)
#
# Exit codes:
#   0 — restore test passed (all core tables verified)
#   1 — missing required environment variable
#   2 — no backup files found
#   3 — restore failed
#   4 — table verification failed
# =============================================================================

set -eu

# ---- Validate required environment variables ----
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

PGPORT="${PGPORT:-5432}"
TEST_DB_NAME="${TEST_DB_NAME:-_restore_test}"

export PGPASSWORD

# ---- Core tables expected in every PokerTools database ----
# These tables correspond to the Prisma schema models. Add or remove entries
# as the schema evolves.
EXPECTED_TABLES="User Session Account LedgerEntry PaymentTransaction Blockchain Token AdminWallet UserWallet DepositSession Table HandHistory Tournament TournamentEntry PlayerNote IdempotencyRecord AuditLog"

# ---- Find the latest backup ----
BACKUP_PATH="$(find "${BACKUP_DIR}" -name "backup-*.sql.gz" -type f 2>/dev/null | sort | tail -1)"
if [ -z "${BACKUP_PATH}" ]; then
    echo "FATAL: No backup files found in ${BACKUP_DIR}" >&2
    exit 2
fi

BACKUP_SIZE="$(du -h "${BACKUP_PATH}" | cut -f1)"
BACKUP_NAME="$(basename "${BACKUP_PATH}")"

echo "============================================================================="
echo "  PostgreSQL Restore Test"
echo "  Host:     ${PGHOST}:${PGPORT}"
echo "  Backup:   ${BACKUP_NAME} (${BACKUP_SIZE})"
echo "  Test DB:  ${TEST_DB_NAME}"
echo "  Time:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================================="

# ---- Clean up any previous throwaway DB ----
echo ""
echo "--- Step 1/5: Cleaning up previous throwaway database (if any) ---"
PGPASSWORD="${PGPASSWORD}" psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="postgres" \
    --command="DROP DATABASE IF EXISTS \"${TEST_DB_NAME}\";" \
    2>/dev/null || true
echo "  Done."

# ---- Create throwaway database ----
echo ""
echo "--- Step 2/5: Creating throwaway database '${TEST_DB_NAME}' ---"
if ! PGPASSWORD="${PGPASSWORD}" psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="postgres" \
    --command="CREATE DATABASE \"${TEST_DB_NAME}\";" \
    2>&1; then
    echo "FATAL: Could not create test database. Does '${PGUSER}' have CREATEDB?" >&2
    exit 3
fi
echo "  Created."

# ---- Restore the backup into the throwaway database ----
echo ""
echo "--- Step 3/5: Restoring backup into '${TEST_DB_NAME}' ---"
if ! gunzip -c "${BACKUP_PATH}" | PGPASSWORD="${PGPASSWORD}" psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="${TEST_DB_NAME}" \
    --echo-errors \
    --set=ON_ERROR_STOP=1 \
    > /dev/null 2>&1; then
    echo "FATAL: Restore into test database failed." >&2
    # Attempt cleanup
    PGPASSWORD="${PGPASSWORD}" psql \
        --host="${PGHOST}" --port="${PGPORT}" --username="${PGUSER}" \
        --dbname="postgres" \
        --command="DROP DATABASE IF EXISTS \"${TEST_DB_NAME}\";" \
        2>/dev/null || true
    exit 3
fi
echo "  Restored successfully."

# ---- Verify expected core tables exist ----
echo ""
echo "--- Step 4/5: Verifying core tables ---"
FAILED_TABLES=""
PASSED_COUNT=0
FAILED_COUNT=0

for TABLE in ${EXPECTED_TABLES}; do
    EXISTS="$(PGPASSWORD="${PGPASSWORD}" psql \
        --host="${PGHOST}" \
        --port="${PGPORT}" \
        --username="${PGUSER}" \
        --dbname="${TEST_DB_NAME}" \
        --tuples-only \
        --no-align \
        --command="SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${TABLE}';" \
        2>/dev/null || echo "0")"

    if [ "${EXISTS}" -ge 1 ] 2>/dev/null; then
        echo "  [PASS] ${TABLE}"
        PASSED_COUNT=$((PASSED_COUNT + 1))
    else
        echo "  [FAIL] ${TABLE} — table not found in restored database"
        FAILED_TABLES="${FAILED_TABLES} ${TABLE}"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
done

echo ""
echo "  Results: ${PASSED_COUNT} passed, ${FAILED_COUNT} failed out of $((PASSED_COUNT + FAILED_COUNT)) expected tables."

# ---- Drop the throwaway database ----
echo ""
echo "--- Step 5/5: Dropping throwaway database '${TEST_DB_NAME}' ---"
PGPASSWORD="${PGPASSWORD}" psql \
    --host="${PGHOST}" \
    --port="${PGPORT}" \
    --username="${PGUSER}" \
    --dbname="postgres" \
    --command="DROP DATABASE IF EXISTS \"${TEST_DB_NAME}\";" \
    2>/dev/null || true
echo "  Dropped."

# ---- Report overall result ----
echo ""
if [ "${FAILED_COUNT}" -eq 0 ]; then
    echo "============================================================================="
    echo "  RESTORE TEST PASSED — all ${PASSED_COUNT} core tables verified."
    echo "============================================================================="
    exit 0
else
    echo "============================================================================="
    echo "  RESTORE TEST FAILED — ${FAILED_COUNT} table(s) missing:${FAILED_TABLES}"
    echo "============================================================================="
    exit 4
fi
