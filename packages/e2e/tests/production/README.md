# Production-container acceptance suite

Real production-image acceptance for the Docker production topology. The suite
builds the repository `Dockerfile` and runs the real `docker-compose.prod.yml`
services — **api, worker, custody, postgres, redis** — under a disposable,
uniquely named compose project.

Caddy and backup are intentionally not started. The acceptance run does not
depend on a public domain, TLS certificates or scheduled backups; the only
public entry point is the randomly assigned loopback API port.

## Run

```sh
# from the repository root
scripts/run-production-acceptance.sh

# keep the generated environment for debugging (prints its path)
scripts/run-production-acceptance.sh --keep

# pass extra vitest args
scripts/run-production-acceptance.sh -t "ASSET competition"
```

Requirements: Docker + Compose v2.24+ (for `!override`), Foundry (`anvil`,
`forge`), Node >= 24, `curl`, `openssl`.

The runner:

1. starts an isolated **ephemeral-port** Anvil node (never `8545`, so it cannot
   collide with other suites) with automine. Block height only advances when
   the suite mines explicitly (deposit confirmations, withdrawal deep finality),
   so the two independent quorum endpoints always agree on `eth_blockNumber`
   and a critical quorum read can never freeze the chain;
2. generates every test-only override in a private temporary directory outside
   the repository (mode 0700/0600): compose env, compose overlay, and a
   custody-only signing env file. The custody signing key is the public,
   valueless Anvil account zero; no repository `.env.custody` is read or copied;
3. builds `@pokertools/types`, `@pokertools/sdk` (host test process) and the
   production image once, tagged uniquely for this run;
4. runs `packages/e2e/tests/production` via
   `tests/production/vitest.production.config.ts`;
5. always tears down the compose project (`down -v`, including named volumes)
   and stops Anvil — even on failure.

Test-only overrides never touch the repository or the production compose file:

- `api`/`postgres` publish random `127.0.0.1` ports only;
- `api`/`worker`/`custody` get `host.docker.internal:host-gateway` so the
  containers reach the host Anvil node through two independent RPC proxies
  (distinct URLs satisfy the canonical ChainRegistry quorum rule);
- `custody.env_file` is `!override`-replaced with the generated custody-only
  file, so the API process never receives signing material;
- `NODE_ENV=production` and `ENABLE_TEST_ROUTES` is never set.

Database mounts, worker configuration and health checks come unchanged from the
production compose file; acceptance does not patch deployment defects through
its overlay.

## Scenarios

| Test                   | Covers                                                                                                            |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------- |
| topology               | real compose services running; API is production; custody-only secrets; `ENABLE_TEST_ROUTES` never enabled        |
| SIWE + admin bootstrap | two real SIWE wallets through the SDK; one ADMIN role via PostgreSQL; no balance fixture                          |
| registry + readiness   | canonical asset row via PostgreSQL; custody heartbeat, RPC quorum and reconciliation; `/ready` financial READY    |
| deposits               | MockUSDC mint → wallet transfer to treasury → public exact-log claim; on-chain and journal assertions             |
| 2-seat gameplay        | real SIWE SDK + WebSocket; competition start auto-deals; a completed hand with live state updates                 |
| ASSET cancel           | real entries: reserve, opt-in, SDK `cancel()` (natural idempotency, no key), refunds + prize release + replay     |
| ASSET settle           | start, complete, `settle()` pays the WALLET winner exactly once; replay is durably idempotent                     |
| withdrawal             | EIP-712 intent through the public API; custody container signs/broadcasts; receipt, deep finality, reconciliation |
| restart                | `api` + `custody` restarted: finalized receipt preserved, reconciliation MATCHED, no double value                 |

## Bootstrap ordering

The canonical asset registry row is a PostgreSQL bootstrap fixture inserted
after the API/custody containers are healthy. The `worker` service is
restarted at that point: its canonical deposit monitor builds its chain
registry once at process start, so the registry fixture must exist first
(mirroring a production seed-before-workers order). The `custody` service is
restarted at the same point so its startup reconciliation pass records the
first `MATCHED` treasury reconciliation for the route.

## Money model

All balances under assertion come from real on-chain transfers and real exact-log
claims. PostgreSQL bootstrap is limited to the canonical asset registry row and
an ADMIN role on an already-authenticated wallet.

One declared infrastructure fixture exists: **sponsor budget classification**
(`classifySponsorBudget`). ASSET prize reservation debits the sponsor's
`OPERATOR` ledger account, but there is no public route that classifies a
wallet's claimed funds as operator/sponsor budget. The fixture posts a balanced,
net-zero `USER_AVAILABLE -> OPERATOR` journal of already claimed funds for the
same principal. It creates no value, changes neither the principal's total nor
the on-chain backing, and is verified by the PostgreSQL financial invariants
(`expectLedgerBalanced`).
