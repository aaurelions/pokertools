# @pokertools/custody

Isolated withdrawal signer/worker. Custody is the only process that holds treasury
signing keys; the API reserves EIP-712 withdrawal intents and never loads key
material. There is no HTTP surface: the entrypoint (`src/index.ts`) builds the
runtime (`src/runtime.ts`) and starts a timer-driven worker.

## What runs

`CustodyWorker` (`src/workers/custody-worker.ts`) drives two loops:

- the withdrawal workflow (`WithdrawalWorkflow.runOnce`) on `CUSTODY_WORKER_INTERVAL_MS`;
- treasury reconciliation (`WithdrawalWorkflow.reconcileAsset`) on
  `CUSTODY_RECONCILE_INTERVAL_MS`.

Each pass writes per-route readiness heartbeats (`CustodyHeartbeatWriter`): the
treasury public address, whether the configured signing key derives that address,
and whether native gas covers the route floor. Only public data is persisted.

## Lifecycle

States are the shared canonical `WithdrawalStatus` values. The workflow advances
`RESERVED → PERSISTED → BROADCAST → PENDING_CONFIRMATION → CONFIRMED → FINALIZED`,
with `BLOCKED_GAS`, `AMBIGUOUS` and `REORGED` as non-terminal branches.

Invariants enforced by `src/core/withdrawal-workflow.ts`:

1. **Persist before broadcast** — the exact signed raw bytes, their hash, the
   treasury nonce and the route provenance are stored before any broadcast call.
2. **Serialized treasury nonces** — nonce selection, signing and persistence run
   under a durable lock keyed by `(chainId, treasuryAddress)`; the nonce requires
   RPC quorum and fails closed when quorum is unavailable.
3. **No automatic replacement** — signed bytes are never re-signed or refunded.
   An ambiguous broadcast keeps the obligation and recovery re-broadcasts the same
   bytes.
4. **Native-gas floor** — insufficient gas yields `BLOCKED_GAS` and a
   `GAS_STARVATION` incident; the obligation is retained, never refunded.
5. **Frozen routes stop signing** — `DEGRADED`/`FROZEN` routes accept no new risk,
   while already-signed obligations keep being monitored.
6. **Quorum confirmation** — confirmation requires quorum agreement on a canonical
   receipt containing the expected ERC-20 Transfer (token, destination, amount).
   Accounting completion runs exactly once and is recorded as `confirmedJournalId`.
7. **Reorgs** — a reorg raises `WITHDRAWAL_REORG` and freezes the route; an
   after-completion reorg restores the obligation exactly once (`reorgJournalId`).
8. **Reconciliation** — quorum ERC-20 custody is compared with accounting-expected
   net liabilities; a mismatch freezes the route and raises `TREASURY_SHORTFALL`.

## Signing isolation

- Treasury accounts come from `TREASURY_SIGNING_KEYS_JSON`, an object mapping
  `chainId` to a `0x`-prefixed 32-byte private key.
- `staticAccountResolver` resolves the key per chain and fails closed for an
  unknown chain; `ViemTreasurySigner` signs ERC-20 transfers only.
- The API never reads `TREASURY_SIGNING_KEYS_JSON`; custody exports readiness
  evidence so the API can gate payouts without seeing a key.

## Ports

Custody depends on narrow ports (`src/core/types.ts`); the durable and viem
implementations live in the package and the accounting/quorum adapters are owned
by `@pokertools/api/finance-core`.

| Port                  | Default implementation                                           |
| :-------------------- | :--------------------------------------------------------------- |
| `WithdrawalStore`     | `PrismaWithdrawalStore` (advisory-lock nonce serializer)         |
| `IncidentStore`       | `PrismaIncidentStore`                                            |
| `AssetRegistry`       | `PrismaAssetRegistry`                                            |
| `TreasuryAccounting`  | `createCustodyAccounting` (AtomicLedger, API finance-core)       |
| `RpcQuorumReader`     | `createAssetBackedCustodyQuorumReader` (validated ChainRegistry) |
| `TreasurySigner`      | `ViemTreasurySigner` (per-chain treasury key)                    |
| `TreasuryBroadcaster` | `ViemTreasuryBroadcaster`                                        |

`buildCustodyRuntime` accepts injected `accounting`/`quorum` ports; tests use the
in-memory doubles in `tests/core/fakes.ts`.

## Configuration

| Variable                        | Default       | Purpose                                                                                       |
| :------------------------------ | :------------ | :-------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      | `development` | `development` / `production` / `test`                                                         |
| `DATABASE_URL`                  | — (required)  | Prisma datasource; PostgreSQL in production                                                   |
| `CUSTODY_WORKER_INTERVAL_MS`    | `5000`        | Withdrawal pass cadence                                                                       |
| `CUSTODY_RECONCILE_INTERVAL_MS` | `300000`      | Reconciliation cadence                                                                        |
| `CUSTODY_QUORUM_THRESHOLD`      | `2`           | Agreeing RPC observations required                                                            |
| `CUSTODY_MIN_QUORUM`            | `2`           | Minimum participants for a quorum decision                                                    |
| `TREASURY_SIGNING_KEYS_JSON`    | `""`          | `{"<chainId>":"0x<32-byte key>"}`; required in production, empty monitors in development/test |
| `LOG_LEVEL`                     | `info`        | pino level                                                                                    |

Production admission (`src/safety.ts`) requires a `postgresql://`/`postgres://`
`DATABASE_URL` and a non-empty, well-formed `TREASURY_SIGNING_KEYS_JSON`.

## Tests

```bash
npm test              # vitest run tests/core tests/process-safety.test.ts
npm run test:workflow # tests/core/withdrawal-workflow.test.ts
npm run typecheck
npm run contracts:test # Forge suite in contracts/
```

Core tests cover workflow faults, the Prisma store, heartbeats, runtime wiring,
signing configuration and the production startup gate. The real viem ports and
the full API/custody boundary are exercised by the cross-package finance
acceptance suite in `@pokertools/e2e` (`packages/e2e/tests/finance`), run with
`npm run e2e:finance`.

## Related

- [Package docs](https://github.com/aaurelions/pokertools/blob/main/docs/packages/custody.md)
- [@pokertools/api](../api) — REST/WebSocket API, Prisma schema and finance-core
- [@pokertools/types](../types) — canonical wire contracts
