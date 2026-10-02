# Security policy

Report vulnerabilities privately to **aurelions@protonmail.com** with reproduction,
impact and affected revision. Never publish credentials/exploit details in public
issues. Initial acknowledgment is normally within 48 hours. Security updates
target the maintained 1.0.x line.

## Enforced boundaries

- PostgreSQL is gameplay/accounting authority. Redis loss cannot change durable truth.
- Public API refuses custody signing/decryption material. Keys stay in custody.
- WALLET sessions and scoped SERVICE credentials are revocable. Principals can
  act only their persisted seat; SERVICE gameplay credentials cannot withdraw.
- Public observations/sockets/replay never expose hidden authoritative state,
  deck, opponents' private cards or undo history.
- Engine randomness is cryptographically secure by default and fails closed.
  Deterministic RNG injection is only for isolated simulations/tests.
- Chips and atomic units differ. Atomic values remain arbitrary-precision
  decimal strings across storage, JSON and SDK.
- Journals are balanced, single-asset, sealed and immutable; projections rebuild.
- Custody persists signed bytes before broadcast and serializes nonce ownership.
  Ambiguous broadcast retries exact bytes, never automatic replacement/refund.
  Quorum disagreement/reorgs/gas starvation preserve obligations.

See the [architecture rules](docs/guide/architecture.md).

## Deployment

Use PostgreSQL, separate API/custody credentials, strong unique JWT/cookie
secrets, TLS, explicit CORS origins and non-root runtimes. Restrict database,
Redis, metrics/operator access. Never expose debugger ports or test routes.
Development defaults, SQLite, Anvil accounts and test assets are not production
settings. Admit traffic using `/ready`, not `/health`.

Run acceptance, migration/restore proof, runtime-dependency verification and
[secret scans/canaries](docs/SECRET_SCANNING.md) for release source/artifacts/logs.
Historical PASS records cannot authorize runtime traffic. Never log tokens,
keys, signing material, sensitive payloads or private game state. Financial/audit
deletion requires a reviewed retention policy; backups do not prove reconciliation.

See [deployment](deploy/README.md), [configuration](docs/guide/configuration.md)
and [testing](docs/guide/testing.md).
