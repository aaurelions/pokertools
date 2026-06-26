# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## API Security Architecture

The `@pokertools/api` package uses the following Fastify security plugins:

| Plugin                | Purpose                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@fastify/helmet`     | Secure HTTP headers (CSP disabled for Swagger UI compatibility)                                                         |
| `@fastify/cors`       | Cross-origin resource sharing; in production, origins are restricted to the configured `CORS_ORIGIN` or denied entirely |
| `@fastify/jwt`        | Signs/verifies JWT access tokens; cookie extraction enabled                                                             |
| `@fastify/cookie`     | Parses signed cookies (`token` cookie via JWT plugin)                                                                   |
| `@fastify/rate-limit` | Global 100 req/min per IP (disabled in `NODE_ENV=test`)                                                                 |

### Authentication Flow (SIWE — Sign-In with Ethereum)

1. **Nonce**: `POST /auth/nonce` generates a one-time nonce stored in Redis with a 5-minute TTL.
2. **Sign**: The client constructs a SIWE message including the nonce and prompts the user's wallet to sign it.
3. **Login**: `POST /auth/login` verifies the signature against the user's Ethereum address (via `viem`), burns the nonce in Redis, creates/upserts a `User` row, creates a `Session` row with a unique `jti`, and returns a signed JWT.
4. **Session validation**: The `authenticate` preHandler hook verifies the JWT and checks that the session's `jti` row is present and `revoked = false` in the database. Revoking a session (`session.revoked = true`) immediately invalidates the token.

### JWT & Cookie Configuration

```typescript
// JWT: signed with JWT_SECRET, extracted from cookie "token"
await app.register(jwt, {
  secret: config.JWT_SECRET,
  cookie: { cookieName: "token", signed: false },
});

// Cookie parsing: signed with COOKIE_SECRET
await app.register(cookie, {
  secret: config.COOKIE_SECRET,
});
```

The JWT payload contains `userId`, `address`, and `jti` (JWT ID for session revocation lookup).

### WebSocket Authentication

WebSocket connections at `/ws/play` accept authentication via:

- `?token=<jwt>` query parameter, or
- `token` cookie attached by the browser during the WebSocket upgrade.

The server verifies the JWT, checks session validity, and passes a `userId` into the per-socket table subscription logic.

---

## Cryptographic Security for Production Games

### Engine RNG

The engine's default `randomProvider` falls back to `Math.random()`, which is **not** cryptographically secure. In any production deployment you must provide a cryptographically secure random function.

```typescript
import { randomBytes } from "crypto";
import { PokerEngine } from "@pokertools/engine";

// Cryptographically secure RNG
const secureRng = () => {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0x100000000;
};

const engine = new PokerEngine({
  smallBlind: 10,
  bigBlind: 20,
  randomProvider: secureRng,
});
```

### Why Math.random() is Dangerous

`Math.random()` uses a predictable pseudo-random algorithm:

1. **State is guessable** — Given enough observations, attackers can predict future cards.
2. **Seed extraction** — Browser implementations leak seed via timing attacks.
3. **Not cryptographically secure** — Designed for animations, not security.

---

## Security Best Practices

### 1. View Masking (Anti-Cheat)

Never send full game state to clients. Use `engine.view(playerId)` to generate a `PublicState` where opponent hole cards, deck contents, and other hidden information are masked.

```typescript
// ✅ Good: masked view
const playerView = engine.view(userId);
socket.send(JSON.stringify(playerView));

// ❌ Bad: exposed full state
socket.send(JSON.stringify(engine.state));
```

### 2. Integer Arithmetic Only

The engine uses integer-only arithmetic. All currency values are in **cents** (1 chip = 1 cent). Floating-point values can introduce rounding errors exploitable for financial gain.

```typescript
const engine = new PokerEngine({
  smallBlind: 500, // $5.00 = 500 cents
  bigBlind: 1000, // $10.00 = 1000 cents
});
```

### 3. Chip Conservation Auditing

The engine enforces strict chip conservation on every action. The `validateIntegrity` config option (default `true`) throws `CriticalStateError` if:

```
∑(player.stack) + ∑(pot.amount) + ∑(currentBets) + rake ≠ constant
```

### 4. Double-Entry Ledger

Every financial movement in the API generates two offsetting `LedgerEntry` rows (e.g., a BUY_IN debits `MAIN` and credits `IN_PLAY`). The net sum of all ledger entries always balances to zero. The `Account.balance` field is a cached roll-up maintained atomically within the same database transaction.

### 5. Rate Limiting (Fastify)

```typescript
await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});
```

The global rate limiter covers all routes. Rate limiting is disabled in `NODE_ENV=test`. Configure more granular limits via additional `@fastify/rate-limit` registrations on specific route prefixes for gameplay-intensive endpoints.

### 6. Redlock Distributed Locking

The API uses [`redlock`](https://www.npmjs.com/package/redlock) (v5 beta) to serialise access to in-memory table state. Before processing any gameplay action:

1. Acquire a Redlock on `lock:table:<tableId>`.
2. Load engine state from Redis.
3. Validate and execute the action.
4. Save updated state to Redis with optimistic-version Lua scripting.
5. Publish `STATE_UPDATE` via Redis Pub/Sub.
6. Release the lock.

This prevents race conditions when multiple API instances share the same Redis cluster.

---

## Database Security

### Default Datasource

The Prisma schema defaults to `provider = "sqlite"` and is used with `@prisma/adapter-better-sqlite3`. SQLite is suitable for development, testing, and low-volume single-instance deployments. For production with high concurrency or replication requirements, switch the datasource to PostgreSQL and ensure TLS connections.

### Sensitive Fields

- `AdminWallet.xpub` — Encrypted with `WALLET_ENCRYPTION_SECRET` (a key separate from `JWT_SECRET` and `COOKIE_SECRET`). Never reuse auth signing secrets for wallet encryption.
- `Session.jti` — Uniquely identifies a JWT; setting `revoked = true` invalidates the session without deleting rows.

### Idempotency

- `PaymentTransaction.idempotencyKey` — Uniquely indexed; prevents duplicate withdrawals from retried API calls.
- `PaymentTransaction.txHash` — Uniqueness enforced per blockchain to prevent deposit replay attacks.

---

## Blockchain Integration Security

### HD Wallet Derivation

Each user receives a deterministic deposit address derived from a shared `AdminWallet.xpub` (public-key-only material). The derivation index is atomically incremented to prevent address collisions. Private keys are not required for address derivation — only the admin sweeper needs the corresponding xpriv.

### Deposit Detection

The `deposit-monitor` BullMQ repeatable job scans ERC-20 `Transfer` events every 15 seconds. Only transfers meeting these criteria are credited:

- `to` address matches an active `DepositSession`.
- Amount ≥ `Token.minDeposit`.
- Exclude zero-address mint events.
- Require `Blockchain.confirmations` block confirmations.

### Withdrawal Security

Withdrawals require:

- A wallet-signed message containing a unique nonce and a recent timestamp.
- Server-side signature verification against the user's registered Ethereum address.
- `idempotencyKey` validation to prevent duplicate processing.
- The withdrawal debit and corresponding `PaymentTransaction` row are created in a single database transaction.

---

## Docker / GHCR Supply-Chain

- The Docker image is built from a **two-stage** [`Dockerfile`](Dockerfile): a `node:24-slim` build stage that compiles TypeScript and generates the Prisma client, and a minimal `node:24-slim` production stage running as a non-root `pokertools` user.
- Images are published to `ghcr.io/aaurelions/pokertools` with tags: `latest`, `major.minor`, `major`, semantic version, and full commit SHA.
- Builds use GitHub Actions with `docker/build-push-action@v7`, QEMU multi-arch (`linux/amd64`, `linux/arm64`), and GitHub Actions cache for layer reuse.
- The runtime image is self-contained: it includes the compiled workspace artifacts, Prisma schema tooling needed by the startup entrypoint, and the source files copied during the monorepo build. Do not treat the image as a source-code confidentiality boundary.
- The Docker Compose file exposes dev-only fallback secrets (`JWT_SECRET`, `COOKIE_SECRET`, `WALLET_ENCRYPTION_SECRET`). **Never use these defaults in production.**

---

## Reporting a Vulnerability

**Do not** open a public issue for security vulnerabilities.

Instead email: `aurelions@protonmail.com`

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

Response time: typically within 48 hours (initial acknowledgment). Fix timelines depend on severity.

---

## Known Security Considerations

### 1. Timing Attacks

The evaluator uses lookup tables with constant-time hand evaluation regardless of hand strength. However, network latency and server load differences between code paths may leak timing information. Mitigations:

- Add random response jitter (0–50 ms).
- Use fixed-time WebSocket frame intervals.

### 2. Memory Dumps

The engine stores deck state and hole cards in process memory. Mitigations:

- Use process isolation and frequent process rotation.
- Restrict `NODE_OPTIONS` and debugger ports in production.
- Run the API as a non-root user (enforced by the Docker image).

### 3. Replay Attacks

Gameplay actions delivered via WebSocket are not individually nonced/timestamped by the WebSocket protocol itself. Mitigations:

- Redlock serialises action execution; the engine's view-masking semantics prevent out-of-turn actions.
- HTTP-level withdrawal endpoints enforce unique `idempotencyKey` and reject expired timestamps.

---

## Security Checklist for Deployment

Before launching to production:

- [ ] Cryptographically secure RNG configured
- [ ] `JWT_SECRET`, `COOKIE_SECRET`, `WALLET_ENCRYPTION_SECRET` set to strong, unique values
- [ ] `CORS_ORIGIN` restricted in production
- [ ] View masking enabled (default)
- [ ] Chip conservation auditing active (default)
- [ ] Rate limiting configured appropriately
- [ ] HTTPS only (reverse proxy or load balancer with TLS termination)
- [ ] PostgreSQL with TLS for production database (not SQLite defaults)
- [ ] Redis AOF persistence enabled
- [ ] Non-root container user
- [ ] Logging enabled (avoid logging sensitive data: JWT payloads, wallet addresses, hole cards)

---

## License

This security policy is part of the PokerTools project and follows the same MIT license.

---

**Last Updated**: 2026-06-25
**Version**: 1.0.7
