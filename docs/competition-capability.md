# Competition capability (generic, public contract)

Status: **contract frozen for consumers; API/SDK implementation in progress.**

This document is the public interface NLHE (and any external product
orchestrator) can build against. The runtime contracts live in
`@pokertools/types` (`packages/types/src/canonical/competition.ts`, re-exported
through `packages/types/src/api/competitions.ts`). Nothing here is poker-variant
specific: the capability is a generic 2-10 entrant, single-table, authoritative
competition, not a Hold'em feature.

## What a competition is

A server-authoritative single-table tournament with a pre-provisioned roster:

| Property        | `NONFINANCIAL`                              | `SPONSORED`                                             |
| --------------- | ------------------------------------------- | ------------------------------------------------------- |
| Entrants        | 2-10, any mix of WALLET/SERVICE             | exactly one WALLET + at least one SERVICE (2-10 total)  |
| Entry           | zero                                        | explicit asset amount paid by the single WALLET entrant |
| Prize           | zero                                        | fixed asset amount financed by a platform sponsor       |
| Ledger movement | none (no chip journal, no atomic ledger)    | exact atomic entry debit + exact atomic prize credit    |
| Seats           | PokerTools-assigned (never client-supplied) | same                                                    |

Service entrants are never charged, never receive value, and never need a chip
grant. A SERVICE winner is never a financial owner: the fixed "human prize" is
paid only to a WALLET winner, otherwise the competition records
`UNCLAIMED_SERVICE_WINNER` with no ledger movement.

## HTTP surface

All routes are JSON. Mutations are idempotent on `idempotencyKey`; replaying a
mutation returns the original result and never creates a second entry, charge or
prize.

| Method | Path                       | Authority                                                         |
| ------ | -------------------------- | ----------------------------------------------------------------- |
| POST   | `/competitions`            | orchestration SERVICE (`competition:orchestrate`) or ADMIN wallet |
| GET    | `/competitions/:id`        | authenticated                                                     |
| POST   | `/competitions/:id/opt-in` | the provisioned WALLET entrant only (`SPONSORED`)                 |
| POST   | `/competitions/:id/start`  | orchestration SERVICE or ADMIN wallet                             |
| POST   | `/competitions/:id/settle` | orchestration SERVICE or ADMIN wallet                             |

### Create

```jsonc
// POST /competitions
{
  "name": "Sponsored table",
  "mode": "SPONSORED",
  "entrants": [
    { "principalId": "user-wallet-1", "kind": "WALLET" },
    { "principalId": "user-agent-1", "kind": "SERVICE" },
  ],
  "startingStack": 1000, // optional, default 1000
  "smallBlind": 10, // optional, default 10
  "bigBlind": 20, // optional, default 20
  "paidTerms": {
    "entry": { "assetId": "eip155:8453/erc20:0x…", "amountAtomic": "1000000" },
    "prize": { "assetId": "eip155:8453/erc20:0x…", "amountAtomic": "5000000" },
    "sponsorPrincipalId": "user-sponsor",
  },
  "idempotencyKey": "create-1",
}
```

Response: `{ success, competition, replayed }` where `competition.entrants[*].seat`
is the authoritative assignment.

Rules enforced at create (fail closed):

- rosters are unique and 2-10;
- `kind` must match the durable principal kind (`User.kind`);
- SERVICE principals are only valid entrants; they are never charged;
- `NONFINANCIAL` must not carry `paidTerms`; `SPONSORED` must carry them and
  respect the exactly-one-WALLET rule;
- for `SPONSORED`, each referenced asset must have an ACTIVE persisted
  `EconomicPolicy`, the entry must be exactly representable (no rounding), and
  the sponsor's operator atomic account must be funded for the full prize.

### Opt-in

```jsonc
// POST /competitions/:id/opt-in
{ "idempotencyKey": "optin-1" }
```

Only the single provisioned WALLET entrant may call it. The entry is charged
atomically through the persisted `EconomicPolicy`; insufficient funds, a missing
policy, an unfunded sponsor or any mismatch fails the whole request closed (no
partial seat/charge). Replays return the original conversion id.

### Start

```jsonc
// POST /competitions/:id/start
{ "idempotencyKey": "start-1" }
```

Fails closed unless the competition is `REGISTRATION`, has ≥2 entrants, and (for
`SPONSORED`) the WALLET entry is paid. The server seats every entrant at their
assigned engine seat with the starting stack and deals the first hand.

### Settle

```jsonc
// POST /competitions/:id/settle
{ "idempotencyKey": "settle-1" }
```

Fails closed unless exactly one entrant still has chips. Placement is
authoritative. For `SPONSORED`, the fixed prize is paid from the sponsor's
operator account to a WALLET winner exactly once (journal
`competition-prize:<competitionId>`), or recorded `UNCLAIMED_SERVICE_WINNER`.

## Principal / credential model

- **Orchestration credential**: a SERVICE credential whose only scope is
  `competition:orchestrate`. It may create and provision competitions, start and
  settle them, and nothing else. It can never withdraw, custody, act as
  financing owner, or hold operator/table/finance scopes. Created by an ADMIN
  wallet via `POST /auth/service-credentials`.
- **Agent credential**: a SERVICE credential restricted to
  `table:observe | table:act | table:chat`, ideally with `tableId` (and
  optionally `seat`) bound to the competition table it was assigned. Agents act
  only through the existing table protocol; they cannot reach `/competitions`.
- **Durable identity**: a competition entrant references `principalId`, the
  durable principal identity. Credential rotation
  (`POST /auth/service-credentials/:id/rotate`) issues a new secret for the same
  principal, so the roster reference and assigned seat never change.
- **Rotation**: revoking or rotating an agent credential immediately removes its
  access; the principal remains the entrant.

## SDK

Consumers that already use `@pokertools/sdk` import the separate public subpath,
which does not touch the main `PokerClient`:

```ts
import { CompetitionClient } from "@pokertools/sdk/competitions";

const competitions = new CompetitionClient({
  baseUrl: "https://api.example.com",
  token: orchestratorServiceToken, // competition:orchestrate
});

const created = await competitions.createCompetition({
  name: "Sponsored table",
  mode: "SPONSORED",
  entrants: [
    { principalId: walletPrincipalId, kind: "WALLET" },
    { principalId: agentPrincipalId, kind: "SERVICE" },
  ],
  paidTerms,
  idempotencyKey: crypto.randomUUID(),
});
```

## Explicit non-goals / limitations

- No prize pool, rake, or player-funded prizes; no implicit currency.
- No multi-table flights, late registration, rebuys or re-entries.
- No client-chosen seats; no open self-registration.
- `SPONSORED` economics depend on the asset/policy rows provisioned in the
  database (there is intentionally no public policy-provisioning route).
