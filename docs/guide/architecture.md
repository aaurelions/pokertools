# Architecture

## Ownership

`types` owns environment-independent domain models and shared public schemas;
wire types are inferred from runtime schemas. Private persistence, worker and
signer ports remain with their domains. `evaluator` ranks hands; `engine` owns
deterministic poker rules and never imports database, network or custody code.
`sdk` consumes public contracts, not API internals; React is a separate export.

The API owns principals, seats, durable gameplay and accounting. Custody is a
private executable with no room or HTTP authority. It consumes exported,
key-free `@pokertools/api/finance-core` accounting/chain-reading adapters and
`@pokertools/api/database`. This dependency is one-way: the API cannot import
signing code. E2E fault-injection seams are not application APIs.
`npm run check:boundaries` enforces these source/manifest directions.

## Game action flow

1. SDK authenticates a WALLET session or scoped SERVICE credential.
2. API authorizes principal, resource and persisted seat before processing.
3. Caller submits `{requestId, turnId, expectedVersion, actionId, amount?}` from
   a server observation. Callers cannot select an actor or manufacture legality.
4. Engine validates/reduces the authoritative snapshot. PostgreSQL CAS commits
   snapshot/version, action identity, ordered immutable events, stored response
   and transactional outbox together.
5. Outbox mirrors committed state to Redis and delivers queue/socket effects.
   Delivery is retryable; Redis failure cannot undo or falsely reject a commit.

Duplicate requests return their stored result only when principal and complete
payload match. Authorization precedes replay. Timeout and player actions compete
against the same durable version. Tournament movements preserve seat authority
and ordered transitions. Redis locks aid coordination, never replace DB authority.

Public observations/replay contain masked views only: never another seat's
unrevealed cards, deck, undo history or raw snapshots/actions. Private audit
state is a distinct access boundary. Engine chips are safe integers, not currency.

## Principals

WALLET principals use SIWE and revocable database-backed sessions. SERVICE
credentials are opaque random bearers stored by digest, scoped by resource and
expiry. Both use the same gameplay protocol. SERVICE gameplay authority grants
neither withdrawals nor operator privileges; fake wallets are unnecessary.
HTTP and WebSocket revalidate authorization, including revocation.

## Accounting

Asset identity binds chain and token. Atomic amounts are arbitrary-precision
integers encoded as canonical decimal strings, never JavaScript `number`.
Chips and assets are separate units. Cash tables use explicit economic policy
snapshots; there is no implicit cents or default exchange rate.

Every journal transaction belongs to one asset and is balanced, sealed and
immutable. Account projections are rebuildable. User liability classes are
nonnegative; `TREASURY_RESERVE` is the signed external-asset counterparty,
excluded from internal liabilities during reconciliation.

| Operation for amount `a` | Postings                                                      |
| ------------------------ | ------------------------------------------------------------- |
| Deposit                  | `USER_AVAILABLE +a`, `TREASURY_RESERVE -a`                    |
| Withdrawal reserve       | `USER_AVAILABLE -a`, `PENDING_WITHDRAWAL +a`                  |
| Confirmed payout         | `PENDING_WITHDRAWAL -a`, `TREASURY_RESERVE +a`                |
| Completed payout reorg   | `INCIDENT_OBLIGATION +a`, `TREASURY_RESERVE -a`, exactly once |

A deposit reorg preserves credited liability and records the shortfall, never
a second liability. Pre-completion withdrawal reorgs retain pending obligations.
Incidents cannot edit/delete journals. Reconciliation compares observed token
custody with net internal liabilities/equity and fails closed on mismatch.

## Deposits and custody

Direct ERC-20 claims identify chain/transaction/log through a configured asset.
The verifier binds wallet sender, treasury recipient, token and amount from
independently agreed chain evidence, not caller-supplied values.

Withdrawals use EIP-712 domain `PokerTools Withdrawal`, version `1`, chain ID
and treasury verifying contract. The message binds intentId, principalId,
assetId, destination, amountAtomic, nonce, deadline (Unix seconds) and chainId.
Intent/reserve commit atomically; route metadata is snapshotted.

Custody serializes nonce ownership per `(chainId, treasuryAddress)`. Signed
bytes/hash/nonce/call persist **before broadcast**. Ambiguous failure recovers
by observation or retry of exact bytes/hash. **No automatic replacement**, new
debit/nonce or blind refund. Receipts, canonical blocks, gas, custody and finality
use validated endpoint quorum. Disagreement records durable evidence and blocks
new risk. Freeze/gas starvation never stop monitoring or erase obligations.

Incident resolution rechecks all blocking incidents, journal invariants, quorum,
reconciliation and gas under a concurrency-safe route transition.

## Storage, migrations and readiness

PostgreSQL is the only deployment database. The SHA-256 manifest in
`packages/api/prisma/postgres` is the sole migration authority: generated
relational baseline, financial constraints, then append-only audit constraints.
Runners serialize with an advisory lock, commit SQL/tracking atomically and
reject drift, unknown history or missing hashes. Repeat application is a no-op.
Future migrations are immutable and append-only. See
[migration policy](../../packages/api/prisma/postgres/README.md).

SQLite is only a disposable local-test adapter generated from the same model;
it has no migration history and does not prove PostgreSQL financial/audit
constraints. Redis is non-authoritative and rebuildable.

`/health` is liveness. `/ready` uses bounded live probes and a short report cache:
schema hashes, durable cursors/outbox, provenance, journal/projections, assets,
incidents, quorum, fresh reconciliation, custody heartbeats and native gas.
Missing/unreadable evidence blocks admission. Probe details are safe codes, not
URLs, secrets or driver messages. Financial incident resolution uses its own
live check, not a cached platform permission. Test results are release evidence only.

## Retention

Financial journals, incidents and audit events are durable evidence with no
automatic deletion policy. Session/nonce/idempotency expiry limits authorization
and retry windows, not financial retention. Outbox delivery does not authorize
deleting game audit trails. Retention changes require reviewed policy and backups.

See [security](../../SECURITY.md) and [deployment](../../deploy/README.md).
