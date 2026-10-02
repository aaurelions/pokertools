# Deployment

The full production runbook — architecture, environment files, backup/restore and
security notes — lives in
[`deploy/README.md`](https://github.com/aaurelions/pokertools/blob/main/deploy/README.md).
This page is a quick index to the actual infrastructure and scripts.

## Compose stacks

| File                      | Purpose                                                             |
| :------------------------ | :------------------------------------------------------------------ |
| `docker-compose.yml`      | Development stack                                                   |
| `docker-compose.prod.yml` | Production (Caddy, API, worker, custody, PostgreSQL, Redis, backup) |
| `docker-compose.e2e.yml`  | Docker E2E stack with Anvil (SQLite)                                |

Production hard-requires PostgreSQL.

## Production

```bash
# 1. Configure environment (two files: public config + custody signing keys)
cp .env.example .env.production
cp deploy/.env.custody.example .env.custody
chmod 600 .env.custody

# 2. Deploy and observe
npm run deploy:prod        # up -d --build
npm run deploy:prod:ps     # status
npm run deploy:prod:logs   # follow logs
npm run deploy:prod:down   # stop

# 3. Backups
npm run db:backup          # one-off pg_dump via the backup service
npm run db:restore:test    # restore the latest backup into a throwaway DB
```

Only Caddy binds host ports; the API, worker, custody, PostgreSQL and Redis run
on the internal network. Treasury signing keys are supplied only to the custody
service via `.env.custody`; the public services never declare signing material.

## Infrastructure & scripts

| Path                              | Role                                                        |
| :-------------------------------- | :---------------------------------------------------------- |
| `deploy/Caddyfile`                | Reverse proxy, TLS, security headers, WebSocket passthrough |
| `deploy/.env.custody.example`     | Template for the custody-only signing environment           |
| `deploy/postgres-backup.sh`       | Scheduled `pg_dump` (mounted as `/backup.sh`)               |
| `deploy/postgres-restore.sh`      | Restore a backup into the production database               |
| `deploy/postgres-restore-test.sh` | Restore-integrity check against a throwaway database        |

## CI/CD workflows

| Workflow             | Triggers                               | Purpose                                              |
| :------------------- | :------------------------------------- | :--------------------------------------------------- |
| `ci.yml`             | push/PR to `main`, `develop`           | Lint, format, build, migrations, tests, Docker build |
| `publish.yml`        | release / dispatch                     | Build + provenance-publish npm packages              |
| `docker-publish.yml` | release / dispatch                     | Build & push the multi-arch image to GHCR            |
| `docs.yml`           | push to `main` on `docs/**` / dispatch | Build VitePress and deploy to GitHub Pages           |

## Health checks

| Check       | Command / URL                           | Expects           |
| :---------- | :-------------------------------------- | :---------------- |
| API process | `docker compose ps`                     | `Up` + healthy    |
| HTTP        | `curl -sf https://<host>/health`        | `{"status":"ok"}` |
| Readiness   | `curl -sf https://<host>/ready`         | `200` when ready  |
| Redis       | `redis-cli -u $REDIS_URL ping`          | `PONG`            |
| Backups     | `npm run deploy:prod:ps` shows `backup` | `Up`              |

## Documentation site

The site builds with VitePress from `/docs` and is deployed to GitHub Pages by
`docs.yml`:

```bash
cd docs
npm install
npm run docs:dev       # local preview
npm run docs:build     # production build → docs/.vitepress/dist
```
