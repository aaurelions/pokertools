# Configuration

Validated runtime settings live in `packages/api/src/config.ts` and
`packages/custody/src/config.ts` (envalid). Names below are canonical; missing
required settings fail startup. Numeric defaults are product/operational policy,
not poker or blockchain protocol rules. `_MS` means milliseconds, `_SECONDS`
seconds, `_COUNT` attempts, `_SIZE` rows, and `_LIMIT` counts in the configured
risk window. Do not log environment values or pass one package's secrets to another.

## API and room workers

| Setting                                                                        | Type / default                                | Meaning / production constraint                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`                                                                     | enum development/production/test; development | Production enables fail-closed deployment checks                             |
| `HOST`, `PORT`                                                                 | string `0.0.0.0`, number `3000`               | Listen address/port; production API stays internal                           |
| `DATABASE_URL`                                                                 | required string                               | Production requires PostgreSQL; `file:` is disposable local-test only        |
| `REDIS_URL`                                                                    | string `redis://localhost:6379`               | Required explicitly in production; cache/queue, never authority              |
| `JWT_SECRET`, `COOKIE_SECRET`                                                  | required strings                              | Production ≥32 characters, reject known dev defaults; generate independently |
| `CORS_ORIGIN`                                                                  | string empty                                  | Required explicit production origin                                          |
| `LOG_LEVEL`                                                                    | debug/info/warn/error; info                   | Never log tokens/keys/private state                                          |
| `ALLOWED_SIWE_CHAIN_IDS`                                                       | CSV string `1,31337`                          | EIP-155 login chains; set actual supported chains in production              |
| `SESSION_TTL_SECONDS`, `NONCE_TTL_SECONDS`                                     | numbers `604800`, `300`                       | Session lifetime and single-use SIWE nonce TTL                               |
| `METRICS_TOKEN`                                                                | string empty                                  | Empty disables production metrics; otherwise bearer-protected                |
| `ENABLE_TEST_ROUTES`                                                           | true/false string; false                      | Only isolated tests; production rejects true                                 |
| `RATE_LIMIT_MAX`                                                               | number `100`                                  | Global requests/minute/IP                                                    |
| `AUTH_NONCE_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_MAX`                       | numbers `5`, `10`                             | Auth requests/minute/IP                                                      |
| `TABLE_REDIS_TTL_SECONDS`                                                      | number `86400`                                | Cache TTL, not durable retention                                             |
| `TABLE_LOCK_TTL_MS`, `TABLE_LOCK_TTL_MS_TEST`                                  | numbers `10000`, `15000`                      | Coordination lock TTLs                                                       |
| `ACTION_TIMEOUT_SECONDS`, `AUTO_DEAL_DELAY_MS`                                 | numbers `30`, `5000`                          | Turn default and next-hand delay                                             |
| `TABLE_LISTING_PAGE_SIZE`, `TOURNAMENT_LISTING_PAGE_SIZE`                      | numbers `50`, `100`                           | Listing bounds                                                               |
| `TOURNAMENT_BLIND_INTERVAL_MS`, `TOURNAMENT_BLIND_SCAN_INTERVAL_MS`            | numbers `900000`, `15000`                     | Blind level default and worker cadence                                       |
| `MAX_TOURNAMENT_TABLES`                                                        | number `10`                                   | Multi-table product limit                                                    |
| `TOURNAMENT_LOCK_TTL_MS`                                                       | number `30000`                                | Tournament coordination TTL                                                  |
| `SETTLE_HAND_LOCK_TTL_MS`, `NEXT_HAND_LOCK_TTL_MS`                             | numbers `5000`, `3000`                        | Worker lock TTLs                                                             |
| `GAME_OUTBOX_SWEEP_INTERVAL_MS`                                                | number `5000`                                 | Durable delivery recovery cadence                                            |
| `CANONICAL_DEPOSIT_MONITOR_INTERVAL_MS`                                        | number `30000`                                | Deposit finality/reorg scan cadence                                          |
| `RECONCILIATION_INTERVAL_MS`, `RECONCILIATION_BATCH_SIZE`                      | numbers `300000`, `100`                       | Reconciliation cadence/batch rows                                            |
| `REDLOCK_RETRY_COUNT`, `REDLOCK_RETRY_COUNT_TEST`                              | numbers `50`, `5000`                          | Coordination retry attempts                                                  |
| `REDLOCK_RETRY_DELAY_MS`, `REDLOCK_RETRY_DELAY_MS_TEST`                        | numbers `100`, `2`                            | Retry delay                                                                  |
| `REDLOCK_RETRY_JITTER_MS`, `REDLOCK_RETRY_JITTER_MS_TEST`                      | numbers `100`, `2`                            | Retry jitter                                                                 |
| `REDLOCK_DRIFT_FACTOR`                                                         | number `0.01`                                 | Clock-drift allowance                                                        |
| `RETRY_TRANSIENT_ATTEMPTS`, `RETRY_TRANSIENT_BACKOFF_BASE_MS`                  | numbers `10`, `100`                           | Safe read retry policy, not blockchain replacement                           |
| `WS_MAX_CONNECTIONS_PER_USER`, `WS_MAX_PRE_AUTH_QUEUE`                         | numbers `4`, `32`                             | Socket connection/pre-auth buffering limits                                  |
| `WS_HEARTBEAT_INTERVAL_MS`                                                     | number `30000`                                | Socket heartbeat cadence                                                     |
| `RISK_SCORE_THRESHOLD`, `RISK_SCORING_WINDOW_MS`                               | numbers `70`, `60000`                         | Velocity scoring cutoff/window                                               |
| `RISK_WITHDRAW_USER_LIMIT`, `RISK_BUY_IN_USER_LIMIT`, `RISK_ACTION_USER_LIMIT` | numbers `5`, `12`, `60`                       | Per-principal request limits                                                 |
| `RISK_WITHDRAW_IP_LIMIT`, `RISK_BUY_IN_IP_LIMIT`, `RISK_ACTION_IP_LIMIT`       | numbers `20`, `40`, `200`                     | Per-IP request limits                                                        |
| `RISK_USER_COUNT_THRESHOLD`, `RISK_USER_COUNT_SCORE`                           | numbers `20`, `40`                            | Principal velocity score                                                     |
| `RISK_IP_COUNT_THRESHOLD`, `RISK_IP_COUNT_SCORE`                               | numbers `80`, `25`                            | IP velocity score                                                            |
| `RISK_MEDIUM_CHIP_AMOUNT_THRESHOLD`, `RISK_MEDIUM_CHIP_AMOUNT_SCORE`           | numbers `100000`, `20`                        | Chip-sized request score, not atomic assets/cents                            |
| `RISK_HIGH_CHIP_AMOUNT_THRESHOLD`, `RISK_HIGH_CHIP_AMOUNT_SCORE`               | numbers `500000`, `30`                        | High chip-sized request score                                                |

Amount-risk settings use chips. The obsolete `RISK_*_AMOUNT_CENTS_*` names are
not aliases. Asset limits, addresses, RPC pools, gas atomic thresholds and
confirmation/finality block depths belong to validated `Asset`/policy records,
not scattered environment overrides. EIP-712 fields/domain version are protocol
invariants and cannot be overridden.

`SQLITE_BUSY_TIMEOUT_MS` is an adapter-only local-test setting (default `15000`),
read when constructing the SQLite adapter; it never affects PostgreSQL.

## Custody only

| Setting                                          | Type / default    | Constraint                                                              |
| ------------------------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`                                       | enum; development | Production is explicit                                                  |
| `DATABASE_URL`                                   | required string   | Production PostgreSQL; separate worker access                           |
| `LOG_LEVEL`                                      | string info       | Signing values must never be logged                                     |
| `TREASURY_SIGNING_KEYS_JSON`                     | JSON string empty | `{chainId: "0x…"}` treasury keys; required valid nonempty in production |
| `CUSTODY_WORKER_INTERVAL_MS`                     | number `5000`     | Withdrawal/recovery cadence                                             |
| `CUSTODY_RECONCILE_INTERVAL_MS`                  | number `300000`   | Treasury reconciliation cadence                                         |
| `CUSTODY_QUORUM_THRESHOLD`, `CUSTODY_MIN_QUORUM` | numbers `2`, `2`  | Independent endpoint agreement requirements                             |

Monitoring-only empty keys are development/test only. Custody does not consume
API JWT/cookie secrets, Redis, mnemonic/xpriv or Telegram configuration.
The API rejects configured custody key/decryption names even outside production;
forbidden names are guards, not supported configuration options.

## Deployment and tooling

Root `.env.example` configures Compose API/workers/backup/Caddy only.
`deploy/.env.custody.example` is copied to required `.env.custody`, supplied only
to custody. See the [runbook](../../deploy/README.md) for `CADDY_DOMAIN`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`,
`BACKUP_INTERVAL_SECONDS`, `BACKUP_RETENTION_DAYS` and volume policy. These are
container/tool settings, not silently consumed application secrets.

Tests/benchmarks have explicitly isolated controls (`POKERTOOLS_LOOPBACK_TEST`,
`ENABLE_HEAVY_TESTS`, `POKERTOOLS_PLAYWRIGHT_MODULE`, `POKERTOOLS_E2E_RUNTIME`,
`PT_FINANCE_*`, `BENCH_*`); never use them to admit production.
Secret scanning uses `GITLEAKS_BIN` and optional `POKERTOOLS_TEST_TMPDIR` as
documented in [secret scanning](../SECRET_SCANNING.md).
