# PokerTools architecture and correctness review

Reviewed 2026-09-07. This is a component review with implemented corrections and regression tests, not a certification that every possible defect has been eliminated.

## How the project works

| Component                     | Role and execution path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types`              | Domain state, actions, players, pots, configuration, API DTOs, WebSocket messages, Zod schemas, and the client action whitelist. These define the contracts between the other packages.                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/evaluator`          | Encodes each card as rank × 4 + suit. For 5/6/7 cards, a suit hash detects flushes; otherwise a quinary rank-frequency hash indexes precomputed tables. Smaller scores represent stronger hands. The fast integer API assumes valid, distinct card codes; it is not an equity simulator.                                                                                                                                                                                                                                                                      |
| `packages/engine`             | `PokerEngine` wraps `gameReducer`. Actions are validated, dispatched to handlers, followed by pot collection, street progression, showdown, and integrity checks. Blinds, heads-up order, short raises, uncalled returns, side pots, odd chips, and rake are separate rules. State snapshots convert Maps into JSON-compatible objects; public views mask private cards. History exporters produce JSON and PokerStars-style text. Tournament levels and timeout/time-bank actions use the same state machine.                                                |
| `packages/api`                | Fastify authenticates SIWE sessions, validates client actions and permissions, exposes tables/tournaments/finance/notes, and serves WebSocket subscriptions. `GameManager` restores the engine from Redis with a database fallback, locks a table, applies an action, uses a Redis version check, persists the snapshot, schedules effects, and broadcasts a version update. Prisma holds accounts, ledger entries, payments, tournaments, and history. BullMQ processes settlement, archives, dealing, timeouts, deposits, blind timers, and reconciliation. |
| `packages/sdk`                | A typed HTTP client, authenticated WebSocket transport, request correlation, state/version caches, reconnection, and React providers/hooks. HTTP and WebSocket authentication must stay consistent when tokens change.                                                                                                                                                                                                                                                                                                                                        |
| `packages/admin`              | Blockchain clients, HD wallet access, nonce coordination, sweeps, operator withdrawal approvals, receipt monitoring, recovery scans, and gas monitoring. `BatchSweeper` redeems ERC-2612 permits and transfers tokens to its owner.                                                                                                                                                                                                                                                                                                                           |
| `packages/bench`              | Evaluator comparisons plus API/worker/socket load and soak scripts. Published throughput figures are illustrative, not results of this review.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/e2e` and deployment | Docker/Anvil scenarios exercise the complete stack; Compose, Dockerfile, CI, backup, and restore scripts provide deployment and validation support. These require separate infrastructure validation beyond package and local database tests.                                                                                                                                                                                                                                                                                                                 |

### Normal hand lifecycle

1. The API transfers a cash buy-in from MAIN to IN_PLAY and seats the player. Tournament entry instead funds tournament escrow and gives the entrant tournament chips.
2. DEAL creates the deck, resets per-hand state, deals cards, collects antes, posts live blinds, and selects the first actor.
3. Betting reduces stacks and records investments. At the end of a round, uncalled chips are returned, investments form side pots, and the next street is dealt.
4. A final fold awards the uncontested pot. Otherwise the evaluator determines each pot's winners, applies the hand rake cap, and distributes odd chips by position.
5. Cash settlement records each player's total award minus their total investment. Player changes plus rake must sum to zero. Tournament payouts use tournament accounting instead.
6. The API archives the hand, schedules the next hand, and sends masked state to clients. Scheduled actions now use the same orchestration path as player actions.

## Implemented corrections

### Private information and contract authorization

- Public views previously included unmasked undo states despite masking the current players and deck. Public views now omit undo history entirely.
- `BatchSweeper.batchSweep` previously accepted any caller and paid `msg.sender`. Copied permit calldata could redirect funds. Redemption now requires the contract owner; the regression test attempts an unauthorized sweep with a valid permit and then verifies the legitimate owner succeeds.
- React token replacement now disconnects and replaces the authenticated socket, including its private state cache. Completion of an older connection attempt cannot clear the newer pending connection reference.

### Poker rules and state integrity

- The initial preflop minimum raise is the wager plus a full big-blind increment.
- An incomplete all-in preserves the last full raise **increment**, while the minimum raise-to total moves with the new wager.
- Reopening is checked for each player who has already acted, including prior callers. Multiple short all-ins can cumulatively reopen betting.
- BET matching a pending wager is accepted as the documented CALL alias.
- A short opening bet does not reduce the required full raise increment below the big blind.
- Street transitions reset raise metadata and time-bank activation. An activation also expires when the player takes a betting action.
- Antes are collected as dead money rather than added to live street wagers.
- New deals clear stale hands and investments for players who sit out, and preserve the updated reservation/time-bank map.
- Timeout folds use normal fold settlement. A sitting-out live hand is automatically checked or folded when action reaches it, rather than silently retaining eligibility without matching a later bet.
- Final-fold detection ignores waiting/reserved players who are not live participants.
- Reducer validation rejects non-finite, fractional, negative, and unsafe chip inputs, including optimistic/dry-run entry points. Numeric seat/configuration checks fail earlier and initialization uses the injected clock.

The raise corrections follow [Poker TDA rules 43 and 47 and their illustration addendum](https://www.pokertda.com/view-poker-tda-rules/). Existing tests asserting the old raise-to total were corrected, rather than preserving their inaccurate expectations.

### Accounting, jobs, and history

- Fold winner amounts now represent gross awards consistently with showdown awards. Uncalled returns reduce invested chips. History derives starting stacks by subtracting awards and includes rake in the original pot total.
- Cash hand settlement previously calculated only the final action's stack difference. It now calculates full-hand awards minus investments and uses a stable table/hand reference. SHOW/MUCK after completion do not trigger a second settlement.
- Tournament chips are excluded from cash IN_PLAY settlement.
- The settlement worker rejects a batch unless player changes plus rake equal zero.
- Timeout and auto-deal workers now use `GameManager` for persistence, settlement, scheduling, and broadcasts. Stale timeout versions are checked under the table lock. Lock contention fails jobs for retry instead of silently dropping them.
- Extended table locks retain the replacement lock object for release.
- Hand archives use stable job identifiers and database upsert to tolerate retries.
- Broadcast completion now updates the reserve account balance to match its existing ledger credit.
- Reverted broadcasts are refunded through one shared transactional function. It claims PROCESSING → FAILED once, verifies the original reserve entries, debits that reserve, credits MAIN, and records balanced reversals. It never consumes another withdrawal's pending hold. Missing or insufficient accounting rolls back the claim for investigation.
- Receipt monitoring limits itself to withdrawals, guards confirmation transitions, and survives a failed scan rather than stopping permanently.

### HTTP reliability and documentation

- Automatic HTTP retries are limited to reads and writes with an idempotency key.
- HTTP 304 returns immediately; empty 204/205 responses are accepted.
- Request deadlines remain active during response-body reading and timers are cleared on failures and completion.
- Evaluator comments no longer claim ordinary sequential calls or separate JavaScript worker isolates corrupt scratch buffers. The root package description no longer advertises a nonexistent win-frequency API.

## Validation

Regression coverage includes private-history leakage, preflop raise minimums, prior callers, cumulative all-ins, ante accounting, timeout settlement, time-bank expiry, invalid numeric inputs, hand-history accounting, lost HTTP responses, body timeouts, React token replacement, stale scheduled jobs, full-hand settlement balance, repeated settlement, reserve refunds, refund rollback, and copied contract permits.

An isolated copy of the original engine source failed 14 of the first 18 new engine regression cases. The corrected source passed all of them. This check did not modify the working source.

API tests used a disposable SQLite database and a separate loopback Redis instance, not application data.

| Validation                                                   | Result                             |
| ------------------------------------------------------------ | ---------------------------------- |
| Engine                                                       | 381 passed                         |
| Evaluator                                                    | 94 passed, 1 intentionally skipped |
| Shared types                                                 | 150 passed                         |
| SDK/React                                                    | 179 passed                         |
| API, including database-backed settlement/refund regressions | 236 passed                         |
| Admin                                                        | 14 passed                          |
| Solidity contracts                                           | 5 passed                           |
| Workspace build and type checking                            | Passed                             |
| Lint, changed-file formatting, whitespace checks             | Passed                             |

Total: 1,059 passing tests, one skipped. Docker end-to-end tests and production PostgreSQL validation were not run.

## Operational implications and remaining verification

- **Existing deployed sweeper contracts are unchanged by this source patch.** Deploy the corrected contract and configure its owner as the sweep operator before using it. An existing non-upgradeable deployment retains its original authorization behavior.
- **Historical accounting is not automatically rewritten.** Earlier cash settlements or cached reserve balances may already disagree with the ledger. Reconcile those records before enabling refunds for historical broadcasts; the new refund path deliberately rejects unsupported accounting instead of debiting unrelated pending funds.
- Redis state commits, database persistence, and BullMQ effects still span separate transactions. Stable IDs reduce duplicate effects, but they do not provide atomic recovery from every crash between stores. A durable transactional outbox and explicit replay/reconciliation tests remain architectural follow-up work.
- Production PostgreSQL concurrency, chain reorganization/finality behavior, Docker end-to-end deployment, and backup restoration are not certified by SQLite tests or a local contract unit suite. Run those environment-specific checks before deployment.
- This review does not establish benchmark throughput or exhaustively evaluate every legal poker configuration. Broader generated multi-hand tests and exhaustive evaluator frequency checks remain useful scheduled validation.
