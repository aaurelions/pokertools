# PokerTools Production Deployment

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Services](#services)
- [Backup & Restore](#backup--restore)
- [Restore Integrity Test](#restore-integrity-test)
- [Security Notes](#security-notes)
- [Volumes](#volumes)

## Architecture

```
Internet ──► Caddy (:80/443) ──► API (:3000) ──► PostgreSQL (:5432)
                 │                     │
                 │                ┌────┴──────────┐
                 │                │  Worker        │
                 │                │ (BullMQ)       │
                 │                └────┬───────────┘
                 │                     │
                 │                Redis (:6379)
                 │                     │
                 │                ┌────┴──────────┐
                 │                │  Custody       │
                 │                │ (signer/final) │
                 │                └───────────────┘
                 │
            Backup Service ────► PostgreSQL (:5432)
```

- **Caddy**: Reverse proxy with automatic TLS (Let's Encrypt), HSTS, CSP, and security headers; zstd/gzip compression; WebSocket passthrough for real-time game connections; JSON access logging; health-checked upstream proxy to the API. The _only_ service with public port exposure (80/443).
- **API**: Fastify REST + WebSocket server. Internal network only.
- **Worker**: Separate process running BullMQ job consumers (hand settlement, tournament blinds, canonical deposit monitor, reconciliation).
- **Custody**: Isolated signing worker. Holds the treasury signing keys, signs and persists withdrawal intents before broadcast, monitors confirmation/finality, and reconciles treasury custody. Internal network only.
- **PostgreSQL 18**: Primary relational database with persistent named volume.
- **Redis 8**: Caching, pub/sub, and BullMQ backing store with AOF persistence (`appendfsync everysec`).
- **Backup**: Scheduled `pg_dump` service with configurable interval and retention.

## Quick Start

> The production compose file (`docker-compose.prod.yml`) lives in the repository **root**, not inside `deploy/`. All `docker compose` commands below should be run from the project root.

### 1. Configure environment

The environment is split into two files so the public API never receives
signing material:

```bash
# Public API/worker/backup configuration (no signing secrets)
cp .env.example .env.production
#   Edit .env.production — generate secrets with: openssl rand -base64 32

# Custody signing configuration (read ONLY by the custody service)
cp deploy/.env.custody.example .env.custody
#   Set TREASURY_SIGNING_KEYS_JSON to your per-chain treasury keys, or leave
#   empty to run the worker in monitoring-only mode.
chmod 600 .env.custody
```

`docker-compose.prod.yml` declares the custody keys only under the `custody`
service and loads them from `.env.custody`. The API, worker, and Caddy services
never declare `TREASURY_SIGNING_KEYS_JSON`, `MASTER_MNEMONIC`, or
`WALLET_XPRIV_ENCRYPTION_SECRET`, so those values cannot leak into a public
container even if a single shared root `.env` holds them for interpolation.

### 2. Start the stack

```bash
npm run deploy:prod
```

### 3. Verify

```bash
npm run deploy:prod:ps
npm run deploy:prod:logs
curl -k https://localhost/health
```

## Services

| Service  | Internal Port | Public? | Description                                    |
| -------- | ------------- | ------- | ---------------------------------------------- |
| caddy    | 80, 443       | Yes     | TLS termination, reverse proxy, HSTS           |
| api      | 3000          | No      | REST + WebSocket API server                    |
| worker   | —             | No      | BullMQ job processors                          |
| custody  | —             | No      | Signing, finality, and treasury reconciliation |
| postgres | 5432          | No      | Primary database                               |
| redis    | 6379          | No      | Cache, pub/sub, queue backend                  |
| backup   | —             | No      | Scheduled pg_dump with retention               |

## Backup & Restore

### Automated backups

The `backup` service runs `pg_dump` on a configurable interval (default: every 24 hours).
Backup files are compressed SQL dumps stored in the `pg_backups` volume.

Configuration via `.env.production`:

- `BACKUP_INTERVAL` — seconds between backup runs (default: `86400`)
- `BACKUP_RETENTION_DAYS` — days to retain before deletion (default: `7`)

Backup files are named `backup-YYYYMMDD-HHMMSS.sql.gz`.

### Manual backup (one-off)

```bash
npm run db:backup
```

### Restore from a backup

**Option A — restore a specific backup to the production database:**

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec backup \
  sh -c "SKIP_CONFIRM=yes BACKUP_DIR=/backups BACKUP_FILE=backup-YYYYMMDD-HHMMSS.sql.gz sh /deploy/postgres-restore.sh"
```

> Note: The restore script uses the backup container's environment (`PGHOST`, `PGUSER`, etc.) which is already configured to point at the production database. Set `SKIP_CONFIRM=yes` for non-interactive runs.

**Option B — restore from the Docker host (recommended for recovery scenarios):**

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=pokertools PGPASSWORD=yourpassword PGDATABASE=pokertools
BACKUP_DIR=./pg_backups ./deploy/postgres-restore.sh
```

### Restore integrity test

Validates that the latest backup is restorable and contains all expected core tables.
Creates a throwaway database `_restore_test`, restores the backup, verifies tables, then drops it.

**From the Docker host:**

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=pokertools PGPASSWORD=yourpassword
BACKUP_DIR=./pg_backups ./deploy/postgres-restore-test.sh
```

**From within the backup container:**

```bash
npm run db:restore:test

# Equivalent raw command:
docker compose --env-file .env.production -f docker-compose.prod.yml exec backup \
  sh -c "BACKUP_DIR=/backups /deploy/postgres-restore-test.sh"
```

Expected output on success:

```
RESTORE TEST PASSED — all 32 core tables verified.
```

### Run restore test on a schedule

Add a cron job on the Docker host:

```
0 3 * * 0  PGHOST=localhost PGUSER=pokertools PGPASSWORD=... BACKUP_DIR=/path/to/pg_backups /path/to/pokertools/deploy/postgres-restore-test.sh >> /var/log/pokertools-restore-test.log 2>&1
```

## Volumes

| Volume         | Purpose                        | Backup?                   |
| -------------- | ------------------------------ | ------------------------- |
| `pg_data`      | PostgreSQL data directory      | Via backup service        |
| `redis_data`   | Redis AOF + RDB persistence    | Via `redis_data` snapshot |
| `pg_backups`   | Compressed pg_dump files       | This _is_ the backup      |
| `caddy_data`   | TLS certificates, OCSP staples | Not needed (auto-renew)   |
| `caddy_config` | Caddy auto-generated config    | Not needed                |

## Security Notes

- **No secrets in this repo.** All secrets are injected via `.env.production` (gitignored).
- **API not publicly exposed.** Only Caddy binds to host ports. The API, worker, Postgres, and Redis communicate over an internal Docker bridge network.
- **HSTS enforced.** 2-year `max-age` with `includeSubDomains` and `preload`.
- **Caddy auto-renews TLS.** Let's Encrypt certificates renew automatically 30 days before expiry.
- **CADDY_ACME_EMAIL** (`.env.production`): Email address Caddy uses when registering with Let's Encrypt. Used for expiry notifications and account recovery. Optional but strongly recommended; leave unset to use Let's Encrypt's default (zero-staging) contact.
- **Production secret guard.** The Docker entrypoint refuses to start if any secret matches a known dev/test default.
- **Read-only rootfs.** API, worker, and custody containers run with `read_only: true` and minimal capabilities.
- **Custody signing isolation.** Treasury signing keys are supplied only to the custody service via a separate `.env.custody` file. The public API, worker, and Caddy services do not declare any signing or mnemonic variable, so key material never enters a public container.

## 🔗 Related Packages

| Package                                    | Description                  |
| ------------------------------------------ | ---------------------------- |
| [@pokertools/api](../packages/api)         | REST/WebSocket API           |
| [@pokertools/custody](../packages/custody) | Private custody worker       |
| [@pokertools/e2e](../packages/e2e)         | End-to-end integration tests |

## 📄 License

MIT © A.Aurelius
