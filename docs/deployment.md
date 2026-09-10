# Deployment

## Docker

The repository ships three compose files:

| File                      | Purpose                                              |
| :------------------------ | :--------------------------------------------------- |
| `docker-compose.yml`      | Development stack                                    |
| `docker-compose.prod.yml` | Production (API, workers, Redis, PostgreSQL, backup) |
| `docker-compose.e2e.yml`  | End-to-end test stack with Anvil                     |

### Local development stack

```bash
docker compose up -d --build   # API + workers + Redis + Postgres
docker compose ps              # health of every service
docker compose logs -f api     # follow the API logs
docker compose down            # stop (data persists in named volumes)
```

### Production

```bash
# 1. Prepare environment
cp .env.example .env.production
# … fill in secrets: JWT_SECRET, DATABASE_URL=postgresql://…, RPC keys, mnemonic

# 2. Deploy
npm run deploy:prod           # docker compose up -d --build
npm run deploy:prod:ps        # status
npm run deploy:prod:logs      # logs

# 3. Operations
npm run db:backup             # containerized backup
npm run db:restore:test       # restore verification script
```

Production hard-requires PostgreSQL: the deploy scripts refuse SQLite.

## Health checks & monitoring

| Check       | Command / URL                                       | Expects         |
| :---------- | :-------------------------------------------------- | :-------------- |
| API process | `docker compose ps`                                 | `Up` + healthy  |
| HTTP        | `curl -sf http://localhost:8080/docs`               | Swagger UI HTML |
| Redis       | `redis-cli -u $REDIS_URL ping`                      | `PONG`          |
| Backups     | `npm run deploy:prod:ps` shows the `backup` service | `Up`            |
| Queue depth | `redis-cli llen bull:settle-hand` (BullMQ v6)       | < 50 under load |
| Blockchain  | Admin **GasMonitor** log lines                      | No alerts       |

Runtime health is also exercised by the e2e stack, whose runner fails fast when any
service misbehaves.

## GitHub Actions

| Workflow             | Triggers                               | Purpose                                                                                                          |
| :------------------- | :------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | push/PR to `main`, `develop`           | Lint, format, build, migrations check, full tests (Redis + Foundry service), benchmarks, multi-arch Docker build |
| `publish.yml`        | release / dispatch                     | Build + provenance-publish `types`, `sdk`, `evaluator`, `engine` to npm                                          |
| `docker-publish.yml` | release / dispatch                     | Build & push multi-arch image to GHCR                                                                            |
| `docs.yml`           | push to `main` on `docs/**` / dispatch | Build VitePress site and deploy to GitHub Pages                                                                  |

### Action versions (latest verified)

| Action                          | Version | Used in            |
| :------------------------------ | :------ | :----------------- |
| `actions/checkout`              | `v7`    | all                |
| `actions/setup-node`            | `v7`    | ci, publish, docs  |
| `actions/upload-pages-artifact` | `v5`    | docs               |
| `actions/deploy-pages`          | `v5`    | docs               |
| `docker/setup-qemu-action`      | `v4`    | ci, docker-publish |
| `docker/setup-buildx-action`    | `v4`    | ci, docker-publish |
| `docker/build-push-action`      | `v7`    | ci, docker-publish |
| `docker/login-action`           | `v4`    | docker-publish     |
| `docker/metadata-action`        | `v6`    | docker-publish     |
| `foundry-rs/foundry-toolchain`  | `v1`    | ci                 |

## Documentation site

This site is built with **VitePress 2.0.0-alpha.20** from `/docs` and deployed to
GitHub Pages:

```bash
cd docs
npm install
npm run docs:dev       # local preview at http://localhost:5173
npm run docs:build     # production build → docs/.vitepress/dist
```

- Each change under `docs/**` on `main` triggers `docs.yml` automatically
- The workflow caches npm from `docs/package-lock.json`, builds and uploads
  `docs/.vitepress/dist`, then deploys with `deploy-pages`
- Enable **Settings → Pages → Source: GitHub Actions** once, then deploys are automatic

## Release checklist

1. Run `npm run validate` locally (format + lint + tests) and `npm run bench`
2. Verify Docker e2e: `npm run e2e:docker`
3. Tag a release — `publish.yml` and `docker-publish.yml` publish npm + GHCR images
4. Validate production: restore a backup (`npm run db:restore:test`), check gas and
   withdrawal monitors

## Backups

The production stack runs a scheduled backup container (`/backup.sh`) writing dumps to
`/backups`. Restore scripts and a test-restore path are provided under `/deploy` so that
restores are validated before they are needed.
