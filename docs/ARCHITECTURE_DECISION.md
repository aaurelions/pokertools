# Decision: authority boundaries and production admission

Status: **accepted target; implementation incomplete**. This document is not a claim that the target is implemented.

## Ownership and dependency direction

```text
types (environment-independent wire schemas)
  ↑ engine → evaluator (deterministic poker chips only)
  ↑ API → engine (principal/seat authority, DB commits, ledger, read-only chain verification)
  ↑ SDK (browser + Node REST/WS; React only at /react)
  ↑ custody (private executable: signing, nonce/workflow persistence, monitoring)
E2E → API + SDK + custody + PostgreSQL + Redis + Anvil
bench → public package surfaces
```

Application code owns UI, decision-making policies and application-specific integrations. It must not decide poker legality, payment finality, authenticated seat ownership or ledger balances. The target API will publish authoritative turns/legal actions to wallet and scoped service principals through the same protocol. **Service-principal provisioning and that protocol are not implemented yet.** Do not create fake wallets for software clients as a substitute for acceptance.

## Current executable boundaries

- Engine/evaluator tests continue to protect deterministic rules and masking.
- Types owns operational response schemas. API and SDK use the same liveness schema; API publishes a schema-validated blocked-readiness response.
- Public API rejects configured custody decryption/signing material before connecting to infrastructure. Its xpriv encryption/decryption exports and private-wallet provisioning CLI are removed.
- Custody is private; package/path, build, Solidity, docs and E2E references use the custody name. Persisted `AdminWallet` and old finance state models still require a reviewed replacement; a package rename is not custody workflow convergence.
- Production processes are blocked **without an environment override**, before DB migration/signing. This block must only be removed by a reviewed code change after every mandatory acceptance scenario passes.
- Health is liveness. Readiness is always 503 while migration/financial evidence is unverified; Caddy probes readiness, not liveness.

## Required next-major work

The relational DB must commit engine snapshots via version compare-and-swap together with action idempotency, intrinsically scoped events and an outbox. Redis remains disposable coordination/cache infrastructure. Immutable, balanced per-asset atomic-unit postings must replace cents balances; poker chips need an explicit conversion-policy snapshot. Service credentials need hashed, revocable, expiring scopes/resources and operator-only provisioning.

Direct treasury ERC-20 claims must bind exact chain/tx/log index and use configured asset metadata with quorum/finality verification. Withdrawals need EIP-712 intents and serial signer nonces; signed bytes/hash must be persisted before broadcast. Ambiguous broadcast must never trigger a refund. These target workflows are **not available or validated** in this change.

## Migration policy

PostgreSQL remains the production target, but production is blocked. Reviewed SQL files are immutable and SHA-256-bound to the migration manifest. Concurrent runners serialize with a PostgreSQL advisory lock; each migration and tracking record commit atomically. Unknown names, changed hashes, history gaps and unhashed historical tracking tables fail closed. There is deliberately no automatic legacy hash stamping or data-loss bootstrap.

Existing deployments must be backed up and independently reconciled before a separately reviewed next-major data migration. This change does not certify schema parity, arbitrary manual DDL drift, system-account provisioning or historical financial integrity.

## Local verification

```sh
npm install
npm run build
npm run infra:up -w @pokertools/api
npm test
npm run test:postgres:migrations -w @pokertools/api # self-owned disposable PostgreSQL container
npm run e2e:docker # self-owned Anvil + Docker legacy acceptance
```

The existing Docker E2E suite is single-chain/SQLite and includes direct DB tournament manipulation and simulated withdrawal approval. Passing it is not next-major multi-chain/multi-asset or service-principal acceptance. The report records actual results rather than extrapolating from those tests.
