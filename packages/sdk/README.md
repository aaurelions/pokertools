# 🃏 @pokertools/sdk

> Canonical protocol surface: per-seat observations, server-issued legal
> actions, and EIP-712 withdrawal intents. The base entry works in the browser
> and in Node.js without React; React hooks are optional at
> `@pokertools/sdk/react`. `health()` validates the canonical liveness schema
> but does not assert financial readiness. See the [architecture guide](../../docs/guide/architecture.md).

[![npm version](https://img.shields.io/npm/v/@pokertools/sdk)](https://www.npmjs.com/package/@pokertools/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official TypeScript SDK for the **PokerTools** platform. Build real-time
Texas Hold'em applications with ease, featuring canonical state sync,
WebSocket integration, and optional React hooks.

## Table of Contents

- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🚀 Quick Start (plain TypeScript)](#-quick-start-plain-typescript)
- [🎣 Quick Start (React, optional)](#-quick-start-react-optional)
- [🏗️ Architecture](#️-architecture)
- [🔑 Authentication (SIWE)](#-authentication-siwe)
- [💸 Canonical withdrawals (EIP-712)](#-canonical-withdrawals-eip-712)
- [📡 Real-time Events](#-real-time-events)
- [🛠️ Configuration](#️-configuration)
- [🔴 Error Handling](#-error-handling)
- [🛠️ API Reference](#️-api-reference)
- [🧪 Testing](#-testing)
- [📦 Related Packages](#-related-packages)
- [📄 License](#-license)

## ✨ Features

- 🔌 **Real-time WebSocket Client**: Automatic reconnection, heartbeats, and
  typed events. JWTs are sent as WebSocket subprotocol credentials (not in the
  URL query string) to avoid leaking tokens in access logs.
- 🎯 **Canonical turns**: `getObservation()` returns the authoritative per-seat
  `SeatObservation` (masked wire state + server-issued `legalActions`). Clients
  echo an opaque `actionId`; the SDK never derives legality locally.
- 🎣 **Optional React Hooks**: `PokerProvider`, `usePoker`, `usePokerClient`,
  `usePokerSocket`, `useTable`, `useUser`, `useTables`, `useTournaments`,
  `useTournament`, `useConnection` via `@pokertools/sdk/react`.
- 🔐 **Authentication**: Sign-In with Ethereum (SIWE) plus replay-safe,
  canonical EIP-712 withdrawal intents. No hand-built withdrawal messages.
- 🛡️ **Type-Safe**: Full TypeScript support with shared types and runtime
  schemas re-exported from `@pokertools/types`.
- 💰 **Canonical finance**: per-asset balances are atomic decimal strings;
  gameplay chips are integer game units and are never mixed with chain value.

## 📦 Installation

```bash
npm install @pokertools/sdk @pokertools/types
# or
yarn add @pokertools/sdk @pokertools/types
# or
pnpm add @pokertools/sdk @pokertools/types
```

`@pokertools/sdk` (v1.0.20) depends on `@pokertools/types` (v1.0.20) for shared
TypeScript types. The React hooks require `react >= 19.2.3` as an **optional**
peer dependency — install `react` and `react-dom` only if you use the React
integration. The base client targets both browsers and Node.js.

Requires **Node.js >= 24.0.0**.

## 🚀 Quick Start (plain TypeScript)

```ts
import { PokerClient, PokerSocket, createSiweMessage } from "@pokertools/sdk";

const client = new PokerClient({
  baseUrl: "https://api.poker.example.com",
  token: "session-token-or-service-credential", // optional until login
  timeout: 10_000,
  retry: { count: 3, delay: 200, backoff: 2 },
});

// 1. SIWE login (wallet session)
const nonce = await client.getNonce();
const message = createSiweMessage({
  address,
  chainId: 1,
  domain: "api.poker.example.com",
  uri: "https://api.poker.example.com",
  statement: "Sign in to PokerTools",
  nonce,
});
// sign `message` with the wallet (viem / ethers / wagmi), then:
await client.login({ message, signature });

// 2. Read the authoritative decision boundary and submit a server-issued action
const observation = await client.getObservation("table_abc");
console.log("table version", observation.version, "turn", observation.turnId);

const fold = observation.legalActions.find((action) => action.family === "FOLD");
if (fold) {
  const result = await client.action("table_abc", {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: fold.actionId,
  });
  console.log("new state", result.observation.state);
  console.log("receipt", result.receipt);
}

// Or use a convenience wrapper (fetches a fresh observation internally):
const state = await client.raise("table_abc", 80); // returns PublicWireState

// 3. Real-time updates over WebSocket
const socket = PokerSocket.fromConfig({
  baseUrl: "https://api.poker.example.com",
  token: client.getToken()!,
});
await socket.connect();
const joined = await socket.join("table_abc"); // SeatObservation
socket.on("observation", (tableId, next) => console.log(tableId, next.version));
```

## 🎣 Quick Start (React, optional)

```tsx
import React from "react";
import { PokerProvider, useTable, useUser, useConnection } from "@pokertools/sdk/react";

const config = { baseUrl: "https://api.poker.example.com", token: "YOUR_JWT_TOKEN" };

export default function App() {
  return (
    <PokerProvider config={config}>
      <GameTable tableId="table-123" />
      <ConnectionStatus />
    </PokerProvider>
  );
}

function GameTable({ tableId }: { tableId: string }) {
  const { state, observation, isLoading, error, action } = useTable(tableId);
  const { profile } = useUser();

  if (isLoading) return <div>Loading table...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!state) return <div>Table not found</div>;

  const pot = state.pots.reduce((sum, p) => sum + p.amount, 0);

  return (
    <div className="poker-table">
      <h2>Pot: {pot} chips</h2>
      <div className="community-cards">{state.board.join(" ")}</div>

      {/* Actions are limited to the server-issued legal actions for this turn. */}
      <div className="controls">
        {(observation?.legalActions ?? []).map((legal) => (
          <button key={legal.actionId} onClick={() => action(legal.family)}>
            {legal.family}
          </button>
        ))}
      </div>

      {profile && <div>Playing as: {profile.username}</div>}
    </div>
  );
}

function ConnectionStatus() {
  const { isConnected, latency } = useConnection();
  return (
    <div>
      {isConnected ? <span>🟢 Connected ({latency}ms)</span> : <span>🔴 Disconnected</span>}
    </div>
  );
}
```

> **🔒 WebSocket Security:** The SDK sends the JWT as a WebSocket subprotocol
> (`Sec-WebSocket-Protocol: pokertools, jwt.<token>`) instead of appending
> `?token=...` to the URL. This prevents JWTs from being captured in server
> access logs, proxy logs, and browser history.

## 🏗️ Architecture

The SDK bridges your frontend application with the PokerTools API and Real-time
Engine.

```
┌───────────────┐
│ Your App / UI │
└───────┬───────┘
        │ React Hooks (optional)
        ▼
┌─────────────────┐
│ @pokertools/sdk │
└───────┬───────┬─┘
        │       │
        │       │ WebSocket (OBSERVATION)
        │       └─────────────────────────┐
        │ REST HTTP                       │
        ▼                                 ▼
┌────────────────┐                ┌──────────────────┐
│ PokerTools API │                │ Real-time Engine │
└────────────────┘                └──────────────────┘
```

### Key Components

| Component        | Description                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PokerClient`    | REST methods (Tables, Tournaments, User, Finance, Notes, Health). Auto-retry with exponential backoff.                              |
| `PokerSocket`    | WebSocket connection, auto-reconnection, heartbeats, and typed real-time `observation` events.                                      |
| `PokerProvider`  | React Context provider (optional subpath). Accepts `autoConnect` (default `true`) to connect the WebSocket when a token is present. |
| `useTable`       | Subscribes to full canonical observations for a table; exposes `state`, `observation`, `action`, `observe`, `refresh`, `leave`.     |
| `useUser`        | Fetches the current profile and chip balances (`UserProfile.chipBalances`).                                                         |
| `useTables`      | Fetches the list of active tables from the REST API.                                                                                |
| `useTournaments` | Fetches active and registering tournament lobbies.                                                                                  |
| `useTournament`  | Fetches one tournament's entries, table assignments, blind structure, and payouts.                                                  |
| `usePoker`       | Low-level hook to access the full `PokerContextValue` (client, socket, connection state).                                           |
| `useConnection`  | Monitors WebSocket connection state and measures latency via application-level ping.                                                |

The live server stream sends a full `OBSERVATION` on join and on every state
change. There is no notification-only frame: the client never advances a cached
version without a fresh full projection.

## 🔑 Authentication (SIWE)

The SDK uses Sign-In with Ethereum:

1. **Get nonce**: request a random nonce from the server.
2. **Sign message**: ask the user's wallet to sign the SIWE message.
3. **Login**: send the message and signature to the API to receive a JWT.

```typescript
import { createSiweMessage } from "@pokertools/sdk";
import { usePokerClient } from "@pokertools/sdk/react";

function LoginButton() {
  const client = usePokerClient();

  const handleLogin = async () => {
    const nonce = await client.getNonce();
    const message = createSiweMessage({
      domain: window.location.host,
      address: userWalletAddress,
      uri: window.location.origin,
      nonce,
      statement: "Sign in to PokerTools",
    });

    // Sign with your wallet provider (e.g. wagmi/viem)
    const signature = await wallet.signMessage(message);

    const { token, user } = await client.login({ message, signature });
    console.log("Logged in as:", user.username);
  };

  return <button onClick={handleLogin}>Sign In with Ethereum</button>;
}
```

Wallet sessions and scoped **SERVICE** credentials are both opaque bearer
tokens: HTTP sends `Authorization: Bearer <token>` and the WebSocket sends the
`jwt.<token>` subprotocol. The transport does not distinguish them.

## 💸 Canonical withdrawals (EIP-712)

Withdrawals are signed as fixed EIP-712 typed data derived from the shared
contract. The SDK never receives signing secrets and never builds a withdrawal
message by hand. See [`packages/api/examples/withdrawal-client.ts`](../api/examples/withdrawal-client.ts)
for the full flow.

```typescript
import {
  PokerClient,
  createWithdrawalTypedData,
  bigIntToAtomicAmount,
  type Eip712Domain,
  type WithdrawalIntent,
} from "@pokertools/sdk";
import { parseUnits } from "viem";

const client = new PokerClient({ baseUrl, token });
const [asset] = (await client.getAssets()).filter((a) => a.symbol === "USDC");
const [balance] = (await client.getBalances()).filter((b) => b.assetId === asset.assetId);

const intent: WithdrawalIntent = {
  intentId: crypto.randomUUID(),
  principalId: balance.principalId,
  assetId: asset.assetId,
  destination: destination.toLowerCase() as `0x${string}`,
  amountAtomic: bigIntToAtomicAmount(parseUnits("100", asset.decimals)),
  nonce: Date.now(),
  deadline: Math.floor(Date.now() / 1000) + 3600,
  chainId: asset.chainId,
};

// name/version are fixed; verifyingContract is the treasury/custody contract.
const domain: Eip712Domain = {
  name: "PokerTools Withdrawal",
  version: "1",
  chainId: asset.chainId,
  verifyingContract: treasury.toLowerCase() as `0x${string}`,
};

const typedData = createWithdrawalTypedData(intent, domain);
const signature = await account.signTypedData({ ...typedData } as never);
const record = await client.submitWithdrawal({ intent, signature });
```

Convenience helpers `createWithdrawalTypedData` and `signWithdrawalIntent` are
exported from the base entry; `withdrawalIntentTypedData`,
`atomicAmountToBigInt`, and `bigIntToAtomicAmount` come from
`@pokertools/types`.

## 📡 Real-time Events

If you are not using React, use `PokerSocket` directly.

```typescript
import { PokerSocket } from "@pokertools/sdk";

const socket = new PokerSocket({
  url: "wss://api.poker.example.com/ws/play",
  token: "jwt-token",
  heartbeatInterval: 25000, // default
  reconnectAttempts: 10, // default
  reconnectDelay: 1000, // default base delay (ms)
  maxReconnectDelay: 30000, // default max delay (ms)
  debug: false,
});

// Lifecycle events
socket.on("connect", () => console.log("Connected"));
socket.on("disconnect", (reason) => console.log("Disconnected:", reason));
socket.on("reconnect", (attempt) => console.log("Reconnecting", attempt));
socket.on("error", (error) => console.error("Socket error:", error));

await socket.connect();

// Join a table: resolves with the first authoritative SeatObservation
const observation = await socket.join("table-1");
console.log("version", observation.version, "turn", observation.turnId);

// Every state change re-sends a full observation
socket.on("observation", (tableId, next) => {
  console.log(`Table ${tableId} version:`, next.version, next.state);
});

// The first observation is also emitted as `snapshot`, subsequent ones as
// `stateUpdate` for ergonomic UI wiring.
socket.on("snapshot", (tableId, state) => console.log("snapshot", state.version));
socket.on("stateUpdate", (tableId, state) => console.log("update", state.version));

// Informational real-time action notification (not required for state sync)
socket.on("action", (tableId, playerId, actionType, amount) => {
  console.log(`${playerId} did ${actionType}${amount ? " " + amount : ""}`);
});

// Inspect the cached projection without fetching again
const cached = socket.getCachedObservation("table-1");
const state = socket.getCachedState("table-1");
const version = socket.getTableVersion("table-1");
const eventSeq = socket.getTableEventSeq("table-1");

// Application-level ping (not WebSocket protocol ping)
const rtt = await socket.ping();
console.log(`Round-trip time: ${rtt}ms`);

socket.leave("table-1");
socket.disconnect();
```

## 🛠️ Configuration

All configuration flows through `PokerSDKConfig` (REST client and SDK
initialization) and the `PokerSocket` constructor options.

### PokerSDKConfig

Used by `new PokerClient(config)`, `PokerSocket.fromConfig(config)`, and
`<PokerProvider config={...}>`.

| Option      | Type               | Default                                 | Description                                             |
| ----------- | ------------------ | --------------------------------------- | ------------------------------------------------------- |
| `baseUrl`   | `string`           | — **(required)**                        | API base URL (e.g., `"https://api.poker.example.com"`). |
| `wsUrl`     | `string`           | baseUrl with `ws://`                    | WebSocket server URL.                                   |
| `token`     | `string`           | `undefined`                             | Wallet session or scoped SERVICE bearer token.          |
| `timeout`   | `number`           | `30000`                                 | Request timeout in milliseconds.                        |
| `retry`     | `RetryConfig`      | `{ count: 3, delay: 1000, backoff: 2 }` | Retry configuration.                                    |
| `fetch`     | `typeof fetch`     | `globalThis.fetch`                      | Custom fetch implementation (e.g., for React Native).   |
| `WebSocket` | `typeof WebSocket` | `globalThis.WebSocket`                  | Custom WebSocket implementation.                        |
| `debug`     | `boolean`          | `false`                                 | Enable request/response debug logging.                  |

### PokerSocket Constructor Options

| Option              | Type               | Default                | Description                           |
| ------------------- | ------------------ | ---------------------- | ------------------------------------- |
| `url`               | `string`           | — **(required)**       | WebSocket server URL.                 |
| `token`             | `string`           | — **(required)**       | JWT for subprotocol authentication.   |
| `heartbeatInterval` | `number`           | `25000`                | Application-level ping interval (ms). |
| `reconnectAttempts` | `number`           | `10`                   | Max reconnection attempts.            |
| `reconnectDelay`    | `number`           | `1000`                 | Base reconnection delay (ms).         |
| `maxReconnectDelay` | `number`           | `30000`                | Max reconnection delay (ms).          |
| `WebSocket`         | `typeof WebSocket` | `globalThis.WebSocket` | Custom WebSocket implementation.      |
| `debug`             | `boolean`          | `false`                | Enable debug logging.                 |

Static factory: `PokerSocket.fromConfig(config: PokerSDKConfig)` creates a socket
from a full SDK config object.

## 🔴 Error Handling

### PokerSDKError

All SDK errors are thrown as `PokerSDKError` instances:

```typescript
import { PokerSDKError } from "@pokertools/sdk";

try {
  await client.action("table-1", request);
} catch (error) {
  if (error instanceof PokerSDKError) {
    console.log("Code:", error.code); // e.g., "ILLEGAL_ACTION", "AMOUNT_BELOW_MIN"
    console.log("Status:", error.statusCode); // e.g., 400, 429, 500
    console.log("Details:", error.details);
  }
}
```

| Code               | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `ILLEGAL_ACTION`   | The server did not offer the requested legal action family. |
| `INVALID_AMOUNT`   | A chip amount was supplied for a family that takes none.    |
| `AMOUNT_REQUIRED`  | A bounded betting action needs an amount.                   |
| `AMOUNT_BELOW_MIN` | Requested amount is below the server legal minimum.         |
| `AMOUNT_ABOVE_MAX` | Requested amount is above the server legal maximum.         |
| `NOT_MODIFIED`     | `getTableState()` received a 304; the version is unchanged. |
| `TIMEOUT`          | Request exceeded the configured timeout.                    |
| `REQUEST_FAILED`   | Network failure or retries exhausted.                       |

### Retry Behavior

`PokerClient` retries failed requests with exponential backoff:

1. **Reads**: `GET` requests retry up to `retry.count` times.
2. **Mutations**: replay automatically only when the body carries a stable
   identity (`requestId`, `idempotencyKey`, EIP-712 `intent.intentId`+`nonce`,
   or exact deposit log identity), and the exact serialized bytes are replayed.
3. **Retryable**: 5xx, network failures, and 429.
4. **Non-retryable**: other 4xx and aborted requests.

## 🛠️ API Reference

### React Hooks (`@pokertools/sdk/react`)

Install `react` and `react-dom` only when using this subpath.

#### `PokerProvider`

| Prop          | Type             | Default | Description                                                      |
| ------------- | ---------------- | ------- | ---------------------------------------------------------------- |
| `config`      | `PokerSDKConfig` | —       | SDK configuration (baseUrl, token, timeout, retry, debug, etc.). |
| `autoConnect` | `boolean`        | `true`  | Automatically open the WebSocket when `config.token` is set.     |
| `children`    | `ReactNode`      | —       | React children.                                                  |

#### `usePoker()`

Returns `{ client, socket, isAuthenticated, connectionState, connect, disconnect }`.

#### `usePokerClient()` / `usePokerSocket()`

Return the `PokerClient` instance / the `PokerSocket` instance (or `null`).

#### `useUser()`

| Field       | Type                   | Description                                                                                 |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `profile`   | `UserProfile \| null`  | Profile including `username`, `address`, `role`, `chipBalances`.                            |
| `balances`  | `UserBalances \| null` | `{ available, inPlay, tournament, totalInPlay, pendingWithdrawal }` atomic/decimal strings. |
| `isLoading` | `boolean`              | Initial fetch in progress.                                                                  |
| `error`     | `Error \| null`        | Fetch error if any.                                                                         |
| `refresh()` | `() => Promise<void>`  | Re-fetch the profile from the API.                                                          |

#### `useTable(tableId, options?)`

Options: `{ autoJoin?: boolean; pollInterval?: number }`.

Returns:

| Field         | Type                                                            | Description                                                      |
| ------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `state`       | `PublicWireState \| null`                                       | Current canonical wire state (from the latest full observation). |
| `observation` | `SeatObservation \| null`                                       | Authoritative observation with server-issued `legalActions`.     |
| `isLoading`   | `boolean`                                                       | Initial fetch in progress.                                       |
| `error`       | `Error \| null`                                                 | Fetch error if any.                                              |
| `refresh()`   | `() => Promise<void>`                                           | Re-fetch the observation from the API.                           |
| `observe()`   | `() => Promise<SeatObservation>`                                | Fetch the authoritative legal-action observation.                |
| `action()`    | `(family: LegalActionFamily, amount?: number) => Promise<void>` | Submit a server-issued legal action family.                      |
| `leave()`     | `() => Promise<void>`                                           | Stand from the table and leave the WebSocket subscription.       |

#### `useConnection()`

Returns `{ state, isConnected, isConnecting, isReconnecting, latency, connect, disconnect, ping }`.

### PokerClient (REST API)

Obtain it via `new PokerClient(config)` or `usePokerClient()`.

#### Methods

| Method                             | Description                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `setToken(token)`                  | Update or clear the bearer token.                                                                                |
| `getToken()` / `isAuthenticated()` | Inspect the current credential.                                                                                  |
| `health()`                         | `GET /health` — canonical liveness check.                                                                        |
| `getReadiness()`                   | `GET /ready` — canonical readiness report; resolves on 200 **and** 503 (inspect `status`/`financial.state`).     |
| `getNonce()`                       | `POST /auth/nonce` — get SIWE nonce.                                                                             |
| `login(request)`                   | `POST /auth/login` — complete SIWE auth and store the token.                                                     |
| `logout()`                         | `POST /auth/logout` — revoke session and clear the token.                                                        |
| `getPrincipal()`                   | `GET /auth/me` — canonical `{ id, kind, walletAddress }` identity for the caller.                                |
| `createServiceCredential(request)` | `POST /auth/service-credentials` — operator-only mint; returns the one-time plaintext `token`.                   |
| `listServiceCredentials()`         | `GET /auth/service-credentials` — operator-only summaries (never the token).                                     |
| `revokeServiceCredential(id)`      | `POST /auth/service-credentials/:id/revoke` — operator-only, effective immediately.                              |
| `getTables()`                      | `GET /tables` — list active tables.                                                                              |
| `createTable(config)`              | `POST /tables` — create a table. Returns the `tableId`.                                                          |
| `getTableState(id, since?)`        | Schema-validated `PublicWireState` view; returns `null` on 304. Use `getObservation` for turns/legal actions.    |
| `getObservation(tableId)`          | `GET /tables/:id/observation` — authoritative `SeatObservation`.                                                 |
| `action(tableId, request)`         | `POST /tables/:id/action` — submit a canonical action; returns the stored result with `receipt` + `observation`. |
| `buyIn(tableId, request)`          | `POST /tables/:id/buy-in`.                                                                                       |
| `addChips(tableId, request)`       | `POST /tables/:id/add-chips`.                                                                                    |
| `getChat(tableId, options?)`       | `GET /tables/:id/chat` — bounded, ordered `ChatPage`; `{ limit?, beforeSeq? }`.                                  |
| `sendChat(tableId, body)`          | `POST /tables/:id/chat` — append one server-escaped `ChatMessage`.                                               |
| `getReplay(tableId, options)`      | `GET /tables/:id/replay` — hash-chained `ReplayFrame` for `{ fromEventSeq, toEventSeq? }` (event log).           |
| `getTournaments()`                 | `GET /tournaments`.                                                                                              |
| `createTournament(request)`        | `POST /tournaments`.                                                                                             |
| `getTournament(id)`                | `GET /tournaments/:id`.                                                                                          |
| `registerTournament(id, request)`  | `POST /tournaments/:id/register`.                                                                                |
| `startTournament(id)`              | `POST /tournaments/:id/start`.                                                                                   |
| `reconcileTournament(id)`          | `POST /tournaments/:id/reconcile`.                                                                               |
| `advanceTournamentBlinds(id)`      | `POST /tournaments/:id/advance-blinds`.                                                                          |
| `settleTournament(id)`             | `POST /tournaments/:id/settle`.                                                                                  |
| `getProfile()`                     | `GET /user/me`.                                                                                                  |
| `getHandHistory()`                 | `GET /user/history`.                                                                                             |
| `getAssets()`                      | `GET /finance/assets` — canonical asset registry.                                                                |
| `getBalances()`                    | `GET /finance/balances` — per-asset atomic decimal-string balances.                                              |
| `claimDeposit(claim)`              | `POST /finance/deposits/claim` — claim by exact `(assetId, txHash, logIndex)`.                                   |
| `getDeposit(depositId)`            | `GET /finance/deposits/:id`.                                                                                     |
| `submitWithdrawal(submission)`     | `POST /finance/withdrawals/intents` — submit `{ intent, signature }`.                                            |
| `getWithdrawal(intentId)`          | `GET /finance/withdrawals/:id`.                                                                                  |
| `getNotes()` / `getNote(id)`       | `GET /notes`, `GET /notes/:id`.                                                                                  |
| `saveNote(targetId, content)`      | `POST /notes`.                                                                                                   |
| `deleteNote(targetId)`             | `DELETE /notes/:id`.                                                                                             |

#### Canonical action submission

```typescript
const observation = await client.getObservation(tableId);
const legal = observation.legalActions.find((a) => a.family === "BET")!;
const result = await client.action(tableId, {
  requestId: crypto.randomUUID(),
  turnId: observation.turnId,
  expectedVersion: observation.version,
  actionId: legal.actionId,
  amount: 60, // optional; omit when the server precomputes the exact amount
});
// result.receipt   -> { requestId, tableId, handId, turnId, actionId, version, eventSeq, acceptedAt }
// result.observation -> { tableId, handId, turnId, version, eventSeq, state, legalActions }
```

#### Convenience action wrappers

Each fetches a fresh observation and submits the matching server-issued legal
action, returning `Promise<PublicWireState>` (the resulting `observation.state`):

| Method                    | Legal family |
| ------------------------- | ------------ |
| `fold(tableId)`           | `FOLD`       |
| `check(tableId)`          | `CHECK`      |
| `call(tableId)`           | `CALL`       |
| `bet(tableId, amount?)`   | `BET`        |
| `raise(tableId, amount?)` | `RAISE`      |
| `deal(tableId)`           | `DEAL`       |
| `show(tableId)`           | `SHOW`       |
| `muck(tableId)`           | `MUCK`       |
| `timeBank(tableId)`       | `TIME_BANK`  |
| `stand(tableId)`          | `STAND`      |

Throws `PokerSDKError("ILLEGAL_ACTION")` when the server does not currently
offer that family.

### PokerSocket (WebSocket)

Config options (all optional except `url` and `token`):

| Option              | Type               | Default                | Description                           |
| ------------------- | ------------------ | ---------------------- | ------------------------------------- |
| `url`               | `string`           | —                      | WebSocket server URL.                 |
| `token`             | `string`           | —                      | JWT for subprotocol authentication.   |
| `heartbeatInterval` | `number`           | `25000`                | Application-level ping interval (ms). |
| `reconnectAttempts` | `number`           | `10`                   | Max reconnection attempts.            |
| `reconnectDelay`    | `number`           | `1000`                 | Base reconnection delay (ms).         |
| `maxReconnectDelay` | `number`           | `30000`                | Max reconnection delay (ms).          |
| `WebSocket`         | `typeof WebSocket` | `globalThis.WebSocket` | Custom WebSocket impl.                |
| `debug`             | `boolean`          | `false`                | Enable debug logging.                 |

Methods:

| Method                          | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `connect()`                     | Open the connection.                                  |
| `disconnect()`                  | Close and stop auto-reconnect.                        |
| `getState()` / `isConnected()`  | Connection introspection.                             |
| `join(tableId)`                 | Join and resolve with the first `SeatObservation`.    |
| `leave(tableId)`                | Leave a table subscription.                           |
| `getJoinedTables()`             | List joined table ids.                                |
| `getCachedObservation(tableId)` | Latest `SeatObservation \| undefined`.                |
| `getCachedState(tableId)`       | Latest `PublicWireState \| undefined`.                |
| `getTableVersion(tableId)`      | Latest server version `\| undefined`.                 |
| `getTableEventSeq(tableId)`     | Latest table event sequence `\| undefined`.           |
| `on` / `off` / `once`           | Event subscription (returns an unsubscribe function). |
| `ping()`                        | Application-level ping; resolves with RTT in ms.      |

Events:

| Event         | Signature                                                                          | Description                        |
| ------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| `connect`     | `() => void`                                                                       | WebSocket connected.               |
| `disconnect`  | `(reason?: string) => void`                                                        | WebSocket disconnected.            |
| `reconnect`   | `(attempt: number) => void`                                                        | Reconnection started.              |
| `error`       | `(error: Error) => void`                                                           | Socket-level or server error.      |
| `observation` | `(tableId: string, observation: SeatObservation) => void`                          | Full canonical observation.        |
| `snapshot`    | `(tableId: string, state: PublicWireState) => void`                                | First observation after join.      |
| `stateUpdate` | `(tableId: string, state: PublicWireState) => void`                                | Canonical state after a change.    |
| `action`      | `(tableId: string, playerId: string, actionType: string, amount?: number) => void` | Informational action notification. |

### Auth Helpers (SIWE + withdrawal)

| Function                                       | Description                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `createSiweMessage(params)`                    | Build an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) SIWE message.     |
| `parseSiweMessage(message)`                    | Maintained `viem/siwe` parser; timestamps are `Date` values.                   |
| `isSiweExpired(message)`                       | Non-authoritative display check; malformed/not-yet-valid messages return true. |
| `createWithdrawalTypedData(intent, domain)`    | Build the fixed EIP-712 typed data for a canonical withdrawal intent.          |
| `signWithdrawalIntent(signer, intent, domain)` | Sign a canonical intent and return `{ intent, signature }`.                    |
| `generateIdempotencyKey()`                     | Generate a random UUID v4.                                                     |

Also exported: `SiweMessageParams`, `WithdrawalTypedDataSigner`.

### Utilities

Chips are **integer game units**. The formatter adds thousands grouping and no
currency symbol; the parser accepts only non-negative safe-integer chip text
(with optional grouping). Neither ever divides by 100 or applies a currency.

```typescript
import { formatChips, parseChips } from "@pokertools/sdk";

formatChips(100); // "100"
formatChips(1_000_000); // "1,000,000"
parseChips("1,000"); // 1000
parseChips("$1.00"); // throws: currency/fraction rejected
```

| Function                | Description                                                           |
| ----------------------- | --------------------------------------------------------------------- |
| `formatChips(chips)`    | Format non-negative safe-integer chips with grouping, no currency.    |
| `parseChips(amount)`    | Parse strict non-negative safe-integer chip text (optional grouping). |
| `abbreviateNumber(num)` | Abbreviate (e.g., `1000` → `"1.0K"`).                                 |

View helpers operate on the canonical `PublicWireState` / `PublicWirePlayer`
projection carried by a `SeatObservation`:

| Function                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `getActivePlayer(state)`   | Player whose turn it is (by `actionTo`).          |
| `getPlayerById(state, id)` | Find player in state by ID.                       |
| `getPlayerSeat(state, id)` | Seat index for a player.                          |
| `isPlayerTurn(state, id)`  | Whether it is a specific player's turn.           |
| `getTotalPot(state)`       | Sum of main + side pots.                          |
| `getActivePlayers(state)`  | Players with stack > 0 and not folded.            |
| `getPlayersInHand(state)`  | Players not folded.                               |
| `isShowdown(state)`        | Whether the street is `SHOWDOWN`.                 |
| `isHandComplete(state)`    | Whether winners are determined.                   |
| `suitToEmoji(suit)`        | Convert suit char to emoji (e.g., `"s"` → `"♠"`). |
| `formatCard(card)`         | Format card string (e.g., `"As"` → `"A♠"`).       |
| `formatCards(cards)`       | Format a nullable card array.                     |
| `getStreetName(street)`    | Convert a street value to a display name.         |

### Main Exports

#### `@pokertools/sdk` (main entry)

| Export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Kind                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PokerClient`, `PokerSocket`, `PokerSDKError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Class                                                                                                                                                               |
| `createSiweMessage`, `parseSiweMessage`, `isSiweExpired`, `createWithdrawalTypedData`, `signWithdrawalIntent`, `generateIdempotencyKey`, `formatChips`, `parseChips`, `getActivePlayer`, `getPlayerById`, `getPlayerSeat`, `isPlayerTurn`, `getTotalPot`, `getActivePlayers`, `getPlayersInHand`, `suitToEmoji`, `formatCard`, `formatCards`, `getStreetName`, `isShowdown`, `isHandComplete`, `abbreviateNumber`                                                                                                                                                                                                                                                                                                                                                                                                                                  | Function                                                                                                                                                            |
| `SiweMessageParams`, `WithdrawalTypedDataSigner`, `PokerSDKConfig`, `UserBalances`, `UserProfile`, `HandHistoryEntry`, `PlayerNote`, `ConnectionState`, `PokerSocketEvents`, `EventListener`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Type                                                                                                                                                                |
| `SeatObservation`, `PublicWireState`, `PublicWirePlayer`, `LegalAction`, action receipts, principals, asset/finance contracts and endpoint DTOs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Public types re-exported from `@pokertools/types`; see `src/index.ts` for the full surface. Engine/reducer models belong to the engine/types packages, not the SDK. |
| `PrincipalSchema`, `SeatObservationSchema`, `LegalActionSchema`, `CanonicalActionRequestSchema`, `CanonicalActionResultSchema`, `PublicWireStateSchema`, `ObservationMessageSchema`, `ServerMessageSchema`, `safeParseServerMessage`, `AssetSchema`, `BalanceSchema`, `DepositClaimSchema`, `DepositClaimRequestSchema`, `WithdrawalIntentSchema`, `WithdrawalSubmissionSchema`, `WithdrawalRecordSchema`, `withdrawalIntentTypedData`, `atomicAmountToBigInt`, `bigIntToAtomicAmount`, `LoginRequestSchema`, `LoginResponseSchema`, `NonceResponseSchema`, `LogoutResponseSchema`, `UserProfileSchema`, `UserBalancesSchema`, `HandHistoryEntrySchema`, `HandHistoryResponseSchema`, `PlayerNoteSchema`, `PlayerNoteRequestSchema`, `GetNotesResponseSchema`, `GetNoteResponseSchema`, `SavePlayerNoteResponseSchema`, `DeleteNoteResponseSchema` | Schema / helper                                                                                                                                                     |

#### `@pokertools/sdk/react` (React subpath)

| Export                                                                                                                                                            | Kind      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `PokerProvider`                                                                                                                                                   | Component |
| `PokerProviderProps`, `PokerContextValue`, `UseTableOptions`, `UseTableResult`, `UseUserResult`, `UseTablesResult`, `UseTournamentsResult`, `UseTournamentResult` | Type      |
| `usePoker`, `usePokerClient`, `usePokerSocket`, `useTable`, `useUser`, `useTables`, `useTournaments`, `useTournament`, `useConnection`                            | Hook      |

## 🧪 Testing

The SDK ships with a Vitest suite. Run all tests from the repository root:

```bash
npm test -w @pokertools/sdk
```

Or from the package directory:

```bash
cd packages/sdk && npx vitest run
```

Suites include `auth`, `client`, `client-reliability`, `socket`, `react`,
`edge-cases`, `types-regressions`, and `utils` (formatting, canonical-state view
helpers, display helpers).

## 🔗 Related Packages

| Package                               | Description                                   |
| ------------------------------------- | --------------------------------------------- |
| [@pokertools/types](../types)         | Shared canonical types, schemas, and helpers. |
| [@pokertools/api](../api)             | REST/WebSocket API (Fastify).                 |
| [@pokertools/engine](../engine)       | Core game engine and state machine.           |
| [@pokertools/evaluator](../evaluator) | High-performance lookup-table hand evaluator. |

## 📄 License

MIT © A.Aurelius
