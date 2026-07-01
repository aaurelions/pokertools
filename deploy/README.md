# PokerTools Production Deployment

## Architecture

```
Internet ──► Caddy (:80/443) ──► API (:3000) ──► PostgreSQL (:5432)
                 │                     │
                 │                ┌────┴──────┐
                 │                │  Worker    │
                 │                │ (BullMQ)   │
                 │                └────┬───────┘
                 │                     │
                 │                Redis (:6379)
                 │
            Backup Service ────► PostgreSQL (:5432)
```

- **Caddy**: Reverse proxy with automatic TLS (Let's Encrypt), HSTS, and security headers. The _only_ service with public port exposure (80/443).
- **API**: Fastify REST + WebSocket server. Internal network only.
- **Worker**: Separate process running BullMQ job consumers (deposit monitor, hand settlement, etc.).
- **PostgreSQL 17**: Primary relational database with persistent named volume.
- **Redis 8**: Caching, pub/sub, and BullMQ backing store with AOF persistence (`appendfsync everysec`).
- **Backup**: Scheduled `pg_dump` service with configurable interval and retention.

## Quick Start

### 1. Configure environment

```bash
cp .env.production.example .env.production
# Edit .env.production — generate secrets with:
#   openssl rand -base64 32
```

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

| Service  | Internal Port | Public? | Description                          |
| -------- | ------------- | ------- | ------------------------------------ |
| caddy    | 80, 443       | Yes     | TLS termination, reverse proxy, HSTS |
| api      | 3000          | No      | REST + WebSocket API server          |
| worker   | —             | No      | BullMQ job processors                |
| postgres | 5432          | No      | Primary database                     |
| redis    | 6379          | No      | Cache, pub/sub, queue backend        |
| backup   | —             | No      | Scheduled pg_dump with retention     |

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
RESTORE TEST PASSED — all 18 core tables verified.
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
- **Production secret guard.** The Docker entrypoint refuses to start if any secret matches a known dev/test default.
- **Read-only rootfs.** API and worker containers run with `read_only: true` and minimal capabilities.
