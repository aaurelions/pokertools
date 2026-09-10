# Architecture

## Component map

| Component               | Role and execution path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pokertools/types`     | Domain state, actions, players, pots, configuration, API DTOs, WebSocket messages, Zod schemas, client action whitelist. Defines the contracts between all other packages.                                                                                                                                                                                                                                                                                                                                                                                |
| `@pokertools/evaluator` | Encodes each card as `rank × 4 + suit`. A suit hash detects flushes; otherwise a quinary rank-frequency hash indexes precomputed tables. Smaller scores are stronger hands. The fast integer API assumes valid, distinct card codes.                                                                                                                                                                                                                                                                                                                      |
| `@pokertools/engine`    | `PokerEngine` wraps `gameReducer`. Actions are validated, dispatched to handlers, followed by pot collection, street progression, showdown and integrity checks. Blinds, heads-up order, short raises, uncalled returns, side pots, odd chips and rake are separate rules. State snapshots convert `Map`s into JSON-compatible objects; public views mask private cards.                                                                                                                                                                                  |
| `@pokertools/sdk`       | Typed HTTP client, authenticated WebSocket transport, request correlation, state/version caches, reconnection, and React providers/hooks. HTTP and WebSocket authentication stay consistent when tokens change.                                                                                                                                                                                                                                                                                                                                           |
| `@pokertools/api`       | Fastify authenticates SIWE sessions, validates client actions and permissions, exposes tables/tournaments/finance/notes and serves WebSocket subscriptions. `GameManager` restores the engine from Redis with a database fallback, locks a table, applies an action, uses a Redis version check, persists the snapshot, schedules effects and broadcasts a version update. Prisma holds accounts, ledger entries, payments, tournaments and history. BullMQ processes settlement, archives, dealing, timeouts, deposits, blind timers and reconciliation. |
| `@pokertools/admin`     | Blockchain clients, HD wallet access, nonce coordination, sweeps, operator withdrawal approvals, receipt monitoring, recovery scans and gas monitoring. `BatchSweeper` redeems ERC-2612 permits and transfers tokens to its owner.                                                                                                                                                                                                                                                                                                                        |

## Normal hand lifecycle

1. **Buy-in / entry** — the API transfers a cash buy-in from `MAIN` to `IN_PLAY` and seats the player. Tournament entry funds tournament escrow and gives the entrant tournament chips.
2. **DEAL** — creates the deck, resets per-hand state, collects antes as dead money, posts live blinds into a separate pot and selects the first actor.
3. **Betting** — reduces stacks and records investments. At the end of a round, uncalled chips are returned, investments form side pots and the next street is dealt.
4. **Showdown** — a final fold awards the uncontested pot; otherwise the evaluator determines each pot's winners, applies the hand rake cap and distributes odd chips by position.
5. **Settlement** — cash settlement records each player's total award minus their total investment; player changes plus rake must sum to zero. Tournament payouts use tournament accounting instead.
6. **Effects** — the API archives the hand, schedules the next hand and sends masked state to clients. Scheduled actions use the same orchestration path as player actions.

## Raise rules (TDA 43 / 47)

| Scenario          | Rule                                                                                                                                       |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| Normal raise      | The next minimum raise-to total is `amount + full raise increment`.                                                                        |
| Incomplete all-in | The all-in does not reopen betting for players who have already acted _unless_ the short raise is a full raise relative to them.           |
| Minimum increment | A raise must be at least the size of the previous full raise; a short opening bet never lowers the increment below the big blind.          |
| Reopening         | Reopening is evaluated per player who has already acted (including prior callers); multiple short all-ins can cumulatively reopen betting. |
| CALL alias        | `BET` matching the current wager is normalized to `CALL` by the reducer.                                                                   |
| Preflop minimum   | The first raise must be to at least `big blind × 2` (wager + big blind).                                                                   |

## Concurrency & persistence

```text
Client ──► Fastify ──► GameManager ──► Redlock (table lock)
                │            │
                │            ├──► Redis   table:{tableId}  (JSON snapshot + _version)
                │            ├──► Prisma  tables, accounts, ledger, history
                │            └──► BullMQ  settle-hand, archive-hand, next-hand, ...
                └──► WebSocket publish  pubsub:table:{tableId}
```

- Table state is a JSON snapshot in Redis with an optimistic `_version` guard; scheduled actions (timeout, auto-deal) verify the version **while holding the table lock**.
- Lock contention makes a job fail so BullMQ retries, instead of silently dropping the operation.
- Redis commits, database persistence and queue effects are separate transactions; stable job IDs and idempotent workers make effects repeatable.

## Security model

- Public engine views strip private cards, the deck **and** undo-history snapshots.
- Client actions are whitelisted (`ActionType` allow-list) and validated both in the engine and the API.
- `BatchSweeper.batchSweep` is `onlyOwner` — permits cannot redirect funds to an attacker.
- Settlement batches must balance to zero (player deltas + rake); refunds claim-once inside a transaction and reverse recorded reserve entries exactly.
