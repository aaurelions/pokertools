# Competition capability (generic, public contract)

Status: **contract frozen; API implemented and verified on PostgreSQL + Redis.**
The SDK competition client is exported from the root `@pokertools/sdk` entry
(`CompetitionClient`) and is owned by the SDK surface.

This document is the public interface any external product orchestrator can
build against. The runtime contracts live in `@pokertools/types`
(`packages/types/src/canonical/competition.ts`, re-exported through
`packages/types/src/api/competitions.ts`). The capability is generic: a 2-10
entrant, single-table, server-authoritative competition provisioned into the
existing tournament/game machinery. There is no second poker runner.

## What a competition is

A server-authoritative single-table tournament with a pre-provisioned roster:

| Property        | `NONFINANCIAL`                              | `ASSET`                                                                  |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Entrants        | 2-10, any mix of WALLET/SERVICE             | 2-10, mixed; one or more WALLET entrants may be configured entry payers  |
| Entry           | zero                                        | explicit atomic amount per configured WALLET payer, paid via opt-in      |
| Prize           | zero                                        | fixed atomic prize, reserved from an authorized sponsor before admission |
| Ledger movement | none (no chip journal, no atomic ledger)    | balanced, idempotent atomic journals only                                |
| Seats           | PokerTools-assigned (never client-supplied) | same                                                                     |

SERVICE entrants are always zero-entry, never financial owners, and never
receive value. If settlement produces a SERVICE winner, the reserved prize is
released back to the sponsor (`RELEASED`) and no value is created.

The platform enforces the generic rules; product-level roster policy (for
example "exactly one human") is the orchestrator's configuration choice, not a
platform invariant.

## HTTP surface

All routes are JSON. Only `POST /competitions` (create) carries a client
`idempotencyKey`; it is persisted with a request hash so a retry can never
create a second competition. Every other mutation is **naturally idempotent
from durable state** and accepts an empty strict object body — a stale
`idempotencyKey` is rejected (`400 VALIDATION_FAILED`), never silently ignored:

- opt-in: the durable PAID marker plus the exact entry journal;
- start: the durable `startedAt` marker (replayable while `RUNNING` and after
  settlement);
- settle: the durable `FINISHED` status and prize disposition;
- cancel: the durable `CANCELLED` status, `cancelledAt` and refund journals.

| Method | Path                                  | Authority                                                         |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| POST   | `/competitions`                       | orchestration SERVICE (`competition:orchestrate`) or ADMIN wallet |
| GET    | `/competitions/:id`                   | authenticated (privacy-preserving projection)                     |
| POST   | `/competitions/:id/opt-in`            | a configured WALLET entry payer only                              |
| POST   | `/competitions/:id/start`             | orchestration SERVICE or ADMIN wallet                             |
| POST   | `/competitions/:id/cancel`            | orchestration SERVICE or ADMIN wallet (`REGISTRATION` only)       |
| POST   | `/competitions/:id/settle`            | orchestration SERVICE or ADMIN wallet                             |
| POST   | `/competitions/:id/agent-credentials` | orchestration SERVICE or ADMIN wallet                             |

### Create

```jsonc
// POST /competitions
{
  "name": "Asset table",
  "mode": "ASSET",
  "entrants": [
    { "principalId": "user-wallet-1", "kind": "WALLET" },
    { "principalId": "user-agent-1", "kind": "SERVICE" },
  ],
  "startingStack": 1000, // optional, default 1000
  "smallBlind": 10, // optional, default 10
  "bigBlind": 20, // optional, default 20
  "terms": {
    "entry": {
      "assetId": "eip155:8453/erc20:0x…",
      "amountAtomic": "1000000",
      "payers": [{ "principalId": "user-wallet-1" }], // optional per-payer amountAtomic
    },
    "prize": {
      "assetId": "eip155:8453/erc20:0x…",
      "amountAtomic": "5000000",
      "sponsorPrincipalId": "user-sponsor",
    },
  },
  "idempotencyKey": "create-1",
}
```

Response: `{ success, competition, replayed }` where `competition.entrants[*].seat`
is the authoritative assignment. Seats are assigned by the server with a CSPRNG
Fisher-Yates permutation of `0..n-1` at creation; the order of the `entrants`
array never controls any seat, and the same permutation is written to the
backing tournament entries and used by the engine at start. Orchestrators must
read seats from the projection/start response, never infer them from roster
order.

Rules enforced at create (fail closed):

- rosters are unique and 2-10; `kind` must match the durable principal kind;
- entry payers must be WALLET roster entrants; SERVICE entrants are never payers;
- `NONFINANCIAL` must not carry `terms`; `ASSET` must carry them;
- the prize sponsor must be authorized delegation: the organizer itself (when
  the organizer is a WALLET) or a fixed platform sponsor account. An
  orchestrator can never direct an arbitrary wallet to fund a prize;
- referenced assets must exist in the database with `ACTIVE` status, re-checked
  inside the admission transaction so a concurrent freeze cannot admit value;
- the full prize is reserved from the sponsor's operator atomic account in the
  same transaction that creates the roster (before any start/admission), so a
  sponsor without funds fails the whole provisioning transaction closed;
- `ASSET` admission requires the explicit `COMPETITION_PAID_ENABLED` feature
  enable **and** the central platform readiness reporting financial `READY`.
  There is no environment bypass and no test-only attestation in production.

### Opt-in

```jsonc
// POST /competitions/:id/opt-in  — empty strict body
{}
```

Only a configured WALLET payer may call it. The payer's explicit entry is
charged atomically into the competition's own entry reserve
(`competition-entry:<competitionId>`, `TOURNAMENT_RESERVE` class) — never
directly to the sponsor — so a sponsor can never spend value that is still
refundable before start. The asset is re-checked `ACTIVE` inside the charging
transaction and the operation requires the same paid-readiness gate as create.
Insufficient funds or any mismatch fails the whole request closed (no partial
seat/charge).

Natural idempotency: the durable entry marker plus the exact reserve-credit
journal is the identity. The accepted charge receipt (`journalRequestId`) is
replayed for the authenticated payer before the registration gate, so a lost
response stays replayable after start and after a prestart cancellation. The
response reports the **live** durable `entryState` at response time (`PAID`
while the entry is held, `REFUNDED` after a cancellation) while the journal
receipt stays immutable historical evidence — read `GET /competitions/:id` for
the authoritative projection. A refunded entry is never charged again. The
transaction locks the competition row and re-reads status/entrant, so a
concurrent start or cancellation can never be followed by a charge (no
pay-after-start / pay-after-cancel).

### Start

```jsonc
// POST /competitions/:id/start  — empty strict object body
{}
```

Fails closed unless the competition is `REGISTRATION`, has ≥2 entrants, and
every configured entry payer has paid (and, for `ASSET`, assets are still
`ACTIVE` and the prize reservation is intact). Starting is one database
transaction: the transaction locks the competition row and re-reads entries, so
`REGISTRATION -> RUNNING` and `REGISTRATION -> CANCELLED` have exactly one
winner; it then transfers every held entry to the sponsor's operator account
exactly once, seats every entrant at their assigned engine seat, deals the first
hand, and only then makes the competition `RUNNING`. Before that commit no seat
or hand is publicly observable, and public gameplay on a competition table is
rejected until the competition is fully seated and `RUNNING` (and after
settlement). A durable `startedAt` makes start replayable from durable state,
including after settlement.

### Settle

```jsonc
// POST /competitions/:id/settle  — empty strict object body
{}
```

Every competition projection (create response and `GET /competitions/:id`)
carries the platform-derived `settlementReady` boolean. It is `true` only when
the authoritative backing director state shows the game is complete: the
tournament is `FINISHED`, or exactly one entrant is `ACTIVE` with chips while
every other entry is a settled elimination (`ELIMINATED`/`PAID`) at a
completed-hand boundary. It is `false` while a hand is in flight or an
elimination has not been reconciled, so orchestrators can wait on a durable
flag instead of local stack heuristics or exception polling. It is derived
read-only from platform state and exposes no engine internals.

Fails closed unless exactly one entrant still has chips. Placements and status
come from the authoritative tournament settlement. For `ASSET`, the reserved
prize is disposed through exactly one journal
(`competition-prize-settlement:<competitionId>`): paid to a WALLET winner, or
released to the sponsor (`RELEASED`) when no financial winner exists. The
disposition decision is made inside a single transaction under a competition
row lock, with winner identity/kind read from durable entries, and the shared
ledger requestId makes a divergent second disposition impossible. Retries are
idempotent. Settlement is deliberately **not** readiness-gated: a provider
outage must never trap a reserved prize or block releasing value.

### Cancel (prestart)

```jsonc
// POST /competitions/:id/cancel  — empty strict object body
{}
```

Orchestration only, and only while the competition is `REGISTRATION`. One
transaction locks the competition row (serializing pay/start/cancel), refunds
every PAID entry from the competition entry reserve to its payer with the exact
atomic amount, releases the reserved prize to the sponsor, marks the backing
tournament `CANCELLED` and closes its table, then flips the competition
`CANCELLED` with `cancelledAt`. Cancellation is deliberately **risk-reducing**:
it never requires financial readiness or `ACTIVE` assets, so a frozen or
degraded platform can still return value.

Cancellation is **all-or-nothing**: every PAID entry must resolve to the
competition entry reserve. If any paid value cannot be accounted for, the whole
cancellation is refused with `409 COMPETITION_ENTRY_UNRESOLVED` and the
competition stays `REGISTRATION` — there is no partial refund, no false
cancellation and no stranded PAID balance. A durably started competition can
never be cancelled (`409 COMPETITION_NOT_CANCELLABLE`).

The response is the canonical cancellation schema; it reports only durable
facts:

```jsonc
{
  "success": true,
  "competitionId": "comp-1",
  "status": "CANCELLED",
  "cancelledAt": "2026-01-01T00:05:00.000Z",
  "prizeStatus": "RELEASED", // NOT_APPLICABLE for NONFINANCIAL
  "prize": { "assetId": "eip155:8453/erc20:0x…", "amountAtomic": "5000000" },
  "entries": [
    {
      "principalId": "user-wallet-1",
      "kind": "WALLET",
      "entryState": "REFUNDED",
      "refunded": true,
      "refundJournalId": "competition-entry-refund:comp-1:user-wallet-1",
    },
    {
      "principalId": "user-agent-1",
      "kind": "SERVICE",
      "entryState": "NOT_REQUIRED",
      "refunded": false,
      "refundJournalId": null,
    },
  ],
}
```

`refunded` is true only when this cancellation returned the exact entry and
`refundJournalId` is the exact journal that did it; `PENDING`/`NOT_REQUIRED`
entrants are reported unchanged. Replaying an accepted cancellation returns the
same durable facts and never moves value twice.

### Data safety and migration posture

The competition ledger is canonical-only: a PAID entry is always evidenced by
its exact reserve-credit journal (`entryJournalId`), start transfers it from
the reserve to the sponsor (`entrySettlementJournalId`), and cancellation
refunds it from the reserve to the payer (`refundJournalId`). There is no
legacy account path and no fallback identity: a missing, unsealed or foreign
journal (for example one that credited the sponsor directly) refuses the whole
cancellation (`409 COMPETITION_ENTRY_UNRESOLVED`) and the competition stays
`REGISTRATION`. No value is ever moved from a non-canonical account.

The platform is versioned forward-only: settings and databases can be reset and
there is no cross-version data compatibility promise. The canonical fresh
PostgreSQL baseline (`001_initial_schema`..`004_competitions`) already contains
the `REFUNDED` state, the cancellation timestamp and the canonical lifecycle
journals; there is no upgrade path from pre-consolidation databases.

### Retry and seat semantics (summary)

- Create: real `idempotencyKey` + request hash; identical replay returns the
  original competition, a different request under the same key is `409`.
- Opt-in: exact reserve-credit journal identity; the accepted charge receipt
  replays before the registration gate, including after start and after
  cancellation (live state is then `REFUNDED`).
- Start: durable `startedAt` identity; replayable while `RUNNING` and after
  settlement; unpaid entries re-checked under the row lock.
- Settle: durable `FINISHED` identity; one shared disposition journal.
- Cancel: durable `CANCELLED` identity; exact refund journals; all-or-nothing.
- Seats: CSPRNG Fisher-Yates `0..n-1` at creation, never roster order; derive
  seats from the projection or the start response.

### Agent credentials

```jsonc
// POST /competitions/:id/agent-credentials
{
  "principalId": "user-agent-1",
  "name": "agent-1",
  "scopes": ["table:observe", "table:act"], // optional, defaults to all table scopes
  "seat": 1, // optional; defaults to the entrant's authoritative seat
  "expiresAt": "2026-01-01T00:00:00.000Z", // optional
}
```

The principal must be a SERVICE entrant of this competition delegated to the
calling orchestrator. The issued credential is always bound to the competition
table and only carries table scopes: it can observe, act and chat at its
assigned table, and nothing else. `seat` is optional and defaults to a
table-only restriction (no seat); an explicit `seat` must match the entrant's
authoritative assigned seat. Pass `credentialId` to rotate that credential in
place; omit it to mint a fresh one (safe after a restart). Rotation never
broadens implicitly: omitted `scopes` preserve the credential's current scopes,
and an omitted `seat` preserves its current seat restriction.

## Principal / credential model

- **Orchestration credential**: a SERVICE credential whose only scope is
  `competition:orchestrate`. It can create/provision/start/settle its own
  competitions and issue table-scoped agent credentials for their delegated
  SERVICE entrants. It can never withdraw, custody, hold operator authority, or
  carry table/finance scopes.
- **Durable SERVICE principal**: provisioned by an operator via
  `POST /auth/service-principals` (`{ name, delegatedToPrincipalId? }`). It has
  no wallet address, is never a financial owner, and is the stable identity
  referenced by rosters, seats and credentials.
- **Delegation**: `delegatedToPrincipalId` authorizes one orchestration
  principal to provision the SERVICE principal into its competitions and issue
  agent credentials for it. An orchestrator can never mint a credential for an
  arbitrary SERVICE principal, and can never roster a principal that is not
  delegated to it.
- **Agent credential**: issued/rotated via
  `POST /competitions/:id/agent-credentials` for a delegated SERVICE entrant of
  that competition. It always carries only `table:observe | table:act | table:chat`
  and is bound to the competition table. `seat` is optional and defaults to
  table-only; an explicit seat must equal the entrant's assigned seat. One
  principal may hold several credentials (one per room), so an agent can play
  simultaneous competitions. Omit `credentialId` to mint a fresh credential
  after a restart; pass it to rotate the old secret in place.
- **Accepted-receipt replay**: an accepted canonical action remains replayable
  after the agent is eliminated. When a seat-restricted credential has no
  current engine seat, the platform derives the historical authorized seat only
  from the exact durable COMPLETED request (same principal and payload hash) in
  its own database, then returns the stored receipt. New requests, altered
  payloads, foreign actors and revoked credentials have no such proof and stay
  denied.
- **Rotation**: operator rotation (`POST /auth/service-credentials/:id/rotate`)
  and competition-scoped rotation both re-key the credential and never change
  `principalId`. Callers may persist only `credentialId` for metadata/revoke and
  must keep the one-time plaintext token in memory.
- **Privacy**: projections never expose wallet addresses, usernames, credential
  digests or raw audit records; only opaque principal ids, kind, seat and entry
  state.

## SDK

Consumers import `CompetitionClient` from the root entry; it is a separate
client and does not touch the main `PokerClient`:

```ts
import { CompetitionClient } from "@pokertools/sdk";

const competitions = new CompetitionClient({
  baseUrl: "https://api.example.com",
  token: orchestratorServiceToken, // competition:orchestrate
});

const created = await competitions.createCompetition({
  name: "Asset table",
  mode: "ASSET",
  entrants: [
    { principalId: walletPrincipalId, kind: "WALLET" },
    { principalId: agentPrincipalId, kind: "SERVICE" },
  ],
  terms,
  idempotencyKey: crypto.randomUUID(),
});
```

## Explicit non-goals / limitations

- No prize pool, rake, or player-funded prizes; no implicit currency.
- No multi-table flights, late registration, rebuys or re-entries.
- No client-chosen seats; no open self-registration.
- Asset and sponsor provisioning is database/operator configuration; there is
  intentionally no public asset-provisioning route.
