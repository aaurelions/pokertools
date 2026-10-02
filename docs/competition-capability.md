# Competition capability (generic, public contract)

Status: **contract frozen; API implemented and verified on PostgreSQL + Redis.**
The SDK competition client lives on the separate public subpath and is owned by
the SDK surface.

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

All routes are JSON. Mutations are idempotent on `idempotencyKey`; replaying a
mutation returns the original result and never creates a second entry, charge or
prize.

| Method | Path                                  | Authority                                                         |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| POST   | `/competitions`                       | orchestration SERVICE (`competition:orchestrate`) or ADMIN wallet |
| GET    | `/competitions/:id`                   | authenticated (privacy-preserving projection)                     |
| POST   | `/competitions/:id/opt-in`            | a configured WALLET entry payer only                              |
| POST   | `/competitions/:id/start`             | orchestration SERVICE or ADMIN wallet                             |
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
is the authoritative assignment.

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
// POST /competitions/:id/opt-in
{ "idempotencyKey": "optin-1" }
```

Only a configured WALLET payer may call it. The payer's explicit entry is
charged atomically to the authorized sponsor's account; the asset is re-checked
`ACTIVE` inside the charging transaction and the operation requires the same
paid-readiness gate as create. Insufficient funds or any mismatch fails the
whole request closed (no partial seat/charge). Replays return the original
journal conversion, and the durable PAID marker makes a retry after a crash a
no-op rather than a second charge.

### Start

```jsonc
// POST /competitions/:id/start
{ "idempotencyKey": "start-1" }
```

Fails closed unless the competition is `REGISTRATION`, has ≥2 entrants, and
every configured entry payer has paid (and, for `ASSET`, assets are still
`ACTIVE` and the prize reservation is intact). Starting is one database
transaction: the server seats every entrant at their assigned engine seat, deals
the first hand, and only then makes the competition `RUNNING`. Before that
commit no seat or hand is publicly observable, and public gameplay on a
competition table is rejected until the competition is fully seated and
`RUNNING` (and after settlement).

### Settle

```jsonc
// POST /competitions/:id/settle
{ "idempotencyKey": "settle-1" }
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
place; omit it to mint a fresh one (safe after a restart).

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

Consumers import the separate public subpath, which does not touch the main
`PokerClient`:

```ts
import { CompetitionClient } from "@pokertools/sdk/competitions";

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
