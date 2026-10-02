# Built-SDK browser acceptance harness

Real headless-Chromium acceptance for the **published/built** `@pokertools/sdk`
package root against the loopback API. This is test infrastructure only: it adds
no SDK/API code and touches no private internals.

## What it proves

The browser page imports `@pokertools/sdk` (resolved to `packages/sdk/dist`), a
public wallet adapter built in-page with `viem`, and public `@pokertools/types`
contracts. The runner asserts the esbuild bundle actually contains
`packages/sdk/dist/index.js`, so source-only changes cannot silently satisfy it.

Flow exercised end to end:

1. **Wallet auth SIWE boundary** — challenge/nonce, wrong signer must not burn
   the challenge, nonce/message replay is rejected, unauthenticated REST is 401.
2. **Authenticated REST** — health, profile, table create/list, buy-ins.
3. **Authenticated WS** — connect, join, snapshot.
4. **Masked observation** — empty deck, empty `previousStates`, non-viewer hole
   cards masked.
5. **Action + live update** — an action advances version and the subscribed
   socket receives a versioned `STATE_UPDATE`.
6. **Disconnect / reconnect / resync** — mutate state while away, rejoin, and
   confirm the snapshot version matches authoritative REST state (still masked).
7. **Canonical turn boundary** (feature-probed) — `GET /tables/:id/observation`
   and strict `POST /tables/:id/action`
   `{ requestId, turnId, expectedVersion, actionId, amount? }`, validated with
   `SeatObservationSchema` / `CanonicalActionReceiptSchema`, including actor
   spoof rejection and stale-version rejection.

### Canonical status

The canonical observation/action routes and SDK migration are implemented. The
canonical step validates the strict contract and currently reports `READY`
(observed legal actions, receipt envelope, spoof `400`, stale `409`, idempotent
replay). If the endpoint regresses to absent (404/405/501/503) or the action path
returns 5xx, the step reports `BLOCKED` with the observed HTTP status instead of
fabricating a pass; auth/REST/WS assertions still run and the run is reported as
`gameplay=blocked(...)`.

Sample passing output:

```
BROWSER_SDK_ACCEPTANCE=PASS chromium=1.63.0 from=<playwright>
  canonical=READY wireShape=receipt-envelope legalActions=[FOLD,CALL,RAISE,TIME_BANK] spoof=400 stale=409 replayIdempotent=true
  gameplay=verified
  dealSdkFallback=no foldSdkFallback=no
```

## How to run

```sh
node packages/api/tests/loopback/browser/run.mjs
# or the existing loopback suite (includes this file):
npm run test:loopback -w @pokertools/api
```

The focused runner is recommended while the other loopback specs are migrated:
the whole-suite command also executes older specs that may not yet target the
canonical wire.

The runner drives the API package's own vitest harness (test env, Redis flush,
HOUSE seed) filtered to
`tests/loopback/browser-sdk-acceptance.test.ts`, after running
`packages/api/scripts/ensure-db.sh` and regenerating the sqlite Prisma client.
The regeneration is required because the canonical (PostgreSQL) acceptance suite
regenerates the shared generated client against the postgres provider; without it
the loopback adapter refuses to start. Pass `--no-ensure-db` or
`--no-prisma-generate` to skip those steps.

### Environment expectations

- Redis reachable (`redis://localhost:6379/1`) and the test DB provisioned
  (`packages/api/.env.test`).
- A Node Playwright installation. It is **not** a declared project dependency
  (adding it changes shared manifests). Resolution order: `POKERTOOLS_PLAYWRIGHT_MODULE`,
  project `node_modules`, then any `~/.npm/_npx/*/node_modules/playwright`,
  preferring the newest. The runner reports a precise block if none is found.
- Chromium browsers in the default Playwright cache. Install with
  `npx playwright install chromium` when missing.

## Files

| File                             | Role                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `browser-sdk-acceptance.test.ts` | Node/vitest driver: loopback app, asset server, Playwright, assertions, cleanup |
| `browser/harness-entry.ts`       | In-page scenarios; imports only built SDK + public types + viem                 |
| `browser/harness.html`           | Page shell loaded by Chromium                                                   |
| `browser/harness-helpers.ts`     | Playwright resolution, esbuild bundling, loopback asset server                  |
| `browser/run.mjs`                | Reproducible focused runner                                                     |

## Safety

Wallets are ephemeral keys generated in-page per run and never persisted,
exported, or logged. No real credentials are used. Gameplay chips are granted
from the Node side through the canonical `financialManager.grantChips` fixture
(the only sanctioned funding path), not a test-only faucet route and not the
asset ledger. Each run creates its own table/users and deletes them on
completion.
