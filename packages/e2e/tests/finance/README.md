# Finance / custody acceptance suite

Real, non-skipping acceptance for the canonical multi-asset finance and custody
boundaries. Two isolated local Anvil chains (31337/31338), a disposable
PostgreSQL + Redis pair, the actual API, and the actual custody
`WithdrawalWorkflow` over durable Prisma ports. Balances under assertion always
come from real on-chain transfers and real balanced journal postings — never a DB
credit shortcut.

## Run

```sh
# from repo root (builds Foundry fixtures, then runs the suite)
scripts/run-finance-acceptance.sh

# or directly
npm run contracts:build -w @pokertools/custody
cd packages/e2e
npx vitest run --config vitest.finance.config.ts
```

Requirements: Foundry (`anvil`, `forge`), Docker (cached `postgres:18-alpine`,
`redis:8-alpine`), Node >= 24. The suite runs with `maxWorkers: 1`,
`fileParallelism: false` and `isolate: true`; it must not run concurrently with
other SQLite Prisma suites.

## How PostgreSQL + Prisma are wired

`tests/finance/global-setup.ts` starts one fresh PostgreSQL and Redis, then
`helpers/fresh-infra.ts`:

1. writes a PostgreSQL-provider copy of `packages/api/prisma/schema.prisma` into
   a private runtime directory and runs `prisma generate` to a **private** client
   at `packages/e2e/.runtime/finance-generated/prisma`;
2. applies the reviewed migrations declared in
   `packages/api/prisma/postgres/migrations.json` (checksum-verified) through the
   production migrator (`packages/api/scripts/migrate-postgres.mjs`);
3. verifies the materialised schema includes the canonical `User.kind` column.

`vitest.finance.config.ts` redirects the workspace `generated/prisma/index.js`
import used by both API and custody source to the private client, so the shared
SQLite build output is never regenerated or clobbered. There is no
`prisma db push` fallback; reviewed migrations are the only schema source.

## Coverage

| File                                          | Covers                                                                                                                                                                                                                                                                                                                                                   |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-smoke.test.ts`                       | two-chain topology, 6/18-decimal assets, real transfers, exact ERC-20 log identity, multi-log tx, snapshot/revert, configurable quorum proxies, canonical EIP-712 domain/fields                                                                                                                                                                          |
| `quorum-disagreement.acceptance.test.ts`      | real `ChainRegistry`: distinct same-chain proxies, duplicate URL rejection, chain mismatch, quorum liveness, disagreement + freeze, minimum participants                                                                                                                                                                                                 |
| `deposit-claim.acceptance.test.ts`            | real `createCanonicalDepositVerifier` + exact-log identity: direct wallet -> treasury credit, multi-log tx, wrong chain/token/sender/recipient, missing log, confirmation depth, frozen asset                                                                                                                                                            |
| `deposit-ledger.acceptance.test.ts`           | real `CanonicalDepositService` + real verifier on fresh PG: wallet -> treasury exact log, balanced journal credit, idempotent duplicate, unverified rejection, independent logs                                                                                                                                                                          |
| `api-routes.acceptance.test.ts`               | real Fastify app + real SIWE session: `/finance/assets`, `/finance/balances`, `/finance/deposits/claim` + `/:id`, `/finance/withdrawals/intents` + `/:id`, bad signature, 404s                                                                                                                                                                           |
| `withdrawal-custody.acceptance.test.ts`       | EIP-712 intent via public API -> PG reservation -> `PrismaWithdrawalStore` persist-before-broadcast -> broadcast -> quorum finality -> `AtomicLedger` completion; true restart reading only PG; ambiguous accepted-then-dropped exact-byte reuse with a single transfer; gas starvation + replenish; genuine missing-receipt withdrawal reorg obligation |
| `reconciliation-incidents.acceptance.test.ts` | real shortfall -> `TREASURY_SHORTFALL` + freeze; restore -> matched reconciliation; operator resolution through the public API with ledger/gas health rechecks; RPC disagreement fails closed                                                                                                                                                            |

Helpers: `anvil-two-chain.ts`, `quorum-proxy.ts`, `fresh-infra.ts`,
`custody-harness.ts` (Prisma stores + real viem ports + fault decorators),
`prisma-accounting.ts` (real `AtomicLedger`-backed `TreasuryAccounting`),
`eip712.ts`, `finance-fixtures.ts`, `finance-api-harness.ts` (real SIWE),
`setup-env.ts`, `infra.ts`.

Foundry test fixture: `packages/custody/contracts/test/acceptance/MockAssetToken.sol`
(configurable-decimals mintable ERC-20). Test-only; never ships as custody code.
