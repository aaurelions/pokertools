# @pokertools/sdk

TypeScript SDK with canonical REST helpers, WebSocket observation sync, auth
utilities and optional React 19 hooks. One client for browser and Node.js
environments.

## Installation

::: code-group

```bash [npm]
npm install @pokertools/sdk
```

```bash [pnpm]
pnpm add @pokertools/sdk
```

:::

## Quick start — plain TypeScript

```ts
import { PokerClient, PokerSocket, createSiweMessage } from "@pokertools/sdk";

const client = new PokerClient({
  baseUrl: "https://api.example.com",
  token: "session-token-from-login", // optional until login
  timeout: 10_000,
  retry: { count: 3, delay: 200, backoff: 2 },
});

// 1. SIWE login
const nonce = await client.getNonce();
const message = createSiweMessage({
  address,
  chainId: 1,
  domain: "api.example.com",
  uri: "https://api.example.com",
  statement: "Sign in to PokerTools",
  nonce,
});
// sign `message` with the wallet (viem / ethers / wagmi), then:
await client.login({ message, signature });

// 2. Read the authoritative decision boundary and submit a server-issued action
const observation = await client.getObservation("table_abc");
const fold = observation.legalActions.find((action) => action.family === "FOLD");
if (fold) {
  const result = await client.action("table_abc", {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: fold.actionId,
  });
  console.log(result.receipt, result.observation.state);
}

// Convenience wrappers fetch a fresh observation and return the new wire state
const state = await client.raise("table_abc", 80);

// 3. Real-time updates over WebSocket
const socket = PokerSocket.fromConfig({
  baseUrl: "https://api.example.com",
  token: client.getToken()!,
});
await socket.connect();
const joined = await socket.join("table_abc"); // SeatObservation
socket.on("observation", (tableId, next) => console.log("version", next.version));
```

## HTTP client

Constants and configuration:

| Option                          | Default      | Description                             |
| :------------------------------ | :----------- | :-------------------------------------- |
| `baseUrl`                       | —            | API origin                              |
| `token`                         | —            | Bearer token; wallet session or SERVICE |
| `timeout`                       | `30_000`     | Full request deadline (incl. body read) |
| `retry.count`                   | `3`          | Automatic retry attempts                |
| `retry.delay` / `retry.backoff` | `1000` / `2` | Exponential backoff                     |
| `debug`                         | `false`      | Log requests/retries                    |

A wallet session and a scoped SERVICE credential are both opaque bearer tokens.
HTTP sends `Authorization: Bearer <token>`; the WebSocket sends the
`jwt.<token>` subprotocol.

### Retry policy

| Request type                        | Retried? | Notes                               |
| :---------------------------------- | :------- | :---------------------------------- |
| `GET`                               | ✅       | Safe reads                          |
| Mutations with a stable identity    | ✅       | Exact serialized bytes are replayed |
| Mutations without a stable identity | ❌       | Never auto-replayed                 |
| `429` / `5xx`                       | ✅       | Backoff                             |
| Other `4xx`                         | ❌       | `304` aborts immediately            |
| Timeout / abort                     | ❌       | Throws `TIMEOUT`                    |

A stable identity is a `requestId`, an `idempotencyKey`, a signed withdrawal
`intent` (`intentId` + `nonce`), or an exact deposit log identity
(`txHash` + `logIndex`).

### Error handling

Errors surface as `PokerSDKError` with a stable `code`, HTTP `statusCode` and
optional `details`:

```ts
import { PokerClient, PokerSDKError } from "@pokertools/sdk";

try {
  await client.action("table_abc", request);
} catch (err) {
  if (err instanceof PokerSDKError) {
    switch (err.code) {
      case "ILLEGAL_ACTION": // server did not offer this family for the turn
      case "AMOUNT_BELOW_MIN":
      case "AMOUNT_ABOVE_MAX":
        break;
      case "TIMEOUT":
        console.warn("request exceeded deadline", err.details);
        break;
    }
  }
}
```

Socket errors arrive through the `error` event; the socket automatically
reconnects with backoff and re-joins previously joined tables.

### Client method groups

| Group             | Methods                                                                                                                                                                              |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | `getNonce()`, `login(request)`, `logout()`, `setToken()`, `isAuthenticated()`                                                                                                        |
| Tables            | `getTables()`, `createTable()`, `getObservation(id)`, `action(id, request)`, `buyIn()`, `addChips()`                                                                                 |
| Table sugar       | `fold()`, `check()`, `call()`, `bet()`, `raise()`, `deal()`, `show()`, `muck()`, `timeBank()`, `stand()`                                                                             |
| Tournaments       | `getTournaments()`, `createTournament()`, `getTournament()`, `registerTournament()`, `startTournament()`, `reconcileTournament()`, `advanceTournamentBlinds()`, `settleTournament()` |
| Profile & history | `getProfile()`, `getHandHistory()`                                                                                                                                                   |
| Finance           | `getAssets()`, `getBalances()`, `claimDeposit()`, `getDeposit()`, `submitWithdrawal()`, `getWithdrawal()`                                                                            |
| Notes             | `getNotes()`, `getNote()`, `saveNote()`, `deleteNote()`                                                                                                                              |

`getObservation(id)` returns the authoritative `SeatObservation`: masked
`PublicWireState` plus the server-issued `legalActions` for the acting seat.
`action(id, request)` takes a strict `CanonicalActionRequest`
(`{ requestId, turnId, expectedVersion, actionId, amount? }`) and returns
`{ receipt, observation }`. `getTableState(id, since?)` returns the same
`PublicWireState` projection (or `null` on 304), without turn/legal-action metadata.
Maps are decimal seat-keyed records on every public transport. The SDK does not
export authoritative engine/reducer models; use the engine/types packages for
standalone engine applications.

## Canonical withdrawals

Chain amounts are atomic decimal strings, never chips or cents. Sign the fixed
EIP-712 typed data from the shared contract; the API rebuilds and verifies it.

```ts
import { createWithdrawalTypedData, bigIntToAtomicAmount } from "@pokertools/sdk";
import { parseUnits } from "viem";

const intent = {
  intentId: crypto.randomUUID(),
  principalId,
  assetId: asset.assetId,
  destination: destination.toLowerCase(),
  amountAtomic: bigIntToAtomicAmount(parseUnits("100", asset.decimals)),
  nonce: Date.now(),
  deadline: Math.floor(Date.now() / 1000) + 3600,
  chainId: asset.chainId,
};

const domain = {
  name: "PokerTools Withdrawal", // fixed
  version: "1", // fixed
  chainId: asset.chainId,
  verifyingContract: treasury.toLowerCase(),
};

const typedData = createWithdrawalTypedData(intent, domain);
const signature = await account.signTypedData({ ...typedData });
await client.submitWithdrawal({ intent, signature });
```

## WebSocket transport

`PokerSocket` (created with `fromConfig`) keeps the latest full observation per
joined table:

| Method                                                                         | Description                                             |
| :----------------------------------------------------------------------------- | :------------------------------------------------------ |
| `connect()`                                                                    | Establish the authenticated socket connection           |
| `disconnect()`                                                                 | Close (used on logout / token rotation)                 |
| `join(tableId)`                                                                | Subscribe — resolves with the current `SeatObservation` |
| `leave(tableId)`                                                               | Unsubscribe                                             |
| `getJoinedTables()`                                                            | List active subscriptions                               |
| `getCachedObservation(tableId)`                                                | Latest `SeatObservation`                                |
| `getCachedState(tableId)`                                                      | Latest `PublicWireState` (ergonomic view)               |
| `getTableVersion(tableId)`                                                     | Latest server version                                   |
| `getTableEventSeq(tableId)`                                                    | Latest table event sequence                             |
| `getState()` / `isConnected()`                                                 | Connection introspection                                |
| `on("observation" \| "connect" \| "disconnect" \| "reconnect" \| "error", cb)` | Event subscription                                      |

- Reconnects with exponential backoff and restores table subscriptions
- Token rotation **replaces the socket** (and its cached private state)
- Stale or reordered observations are dropped; a version is never advanced
  without the full projection that carries it

## React hooks

```tsx
import { PokerProvider, useTable, useConnection } from "@pokertools/sdk/react";

function App() {
  return (
    <PokerProvider config={{ baseUrl: "https://api.example.com", token }}>
      <Table />
    </PokerProvider>
  );
}

function Table() {
  const { state, observation, action } = useTable("table_abc");
  const { isConnected } = useConnection();

  if (!isConnected) return <p>Connecting…</p>;
  if (!state) return <p>Loading…</p>;

  return (
    <>
      <div>Street: {state.street}</div>
      {(observation?.legalActions ?? []).map((legal) => (
        <button key={legal.actionId} onClick={() => action(legal.family)}>
          {legal.family}
        </button>
      ))}
    </>
  );
}
```

| Hook                      | Returns                                                         | Purpose                                                         |
| :------------------------ | :-------------------------------------------------------------- | :-------------------------------------------------------------- |
| `usePoker()`              | `{ client, socket, isAuthenticated, connectionState, ... }`     | Global context access                                           |
| `usePokerClient()`        | `PokerClient`                                                   | Raw client                                                      |
| `usePokerSocket()`        | `PokerSocket \| null`                                           | Live socket                                                     |
| `useTable(tableId, opts)` | `{ state, observation, action, observe, refresh, leave }`       | Table state + server-issued action helper                       |
| `useUser()`               | `{ profile, balances, isLoading, error, refresh }`              | Current profile + chip balances                                 |
| `useTables()`             | `{ tables, isLoading, error, refresh }`                         | Table list                                                      |
| `useTournaments()`        | `{ tournaments, isLoading, error, refresh }`                    | Tournament list                                                 |
| `useTournament(id)`       | `{ tournament, isLoading, error, refresh }`                     | Tournament details                                              |
| `useConnection()`         | `{ state, isConnected, isConnecting, isReconnecting, latency }` | `connecting` \| `connected` \| `reconnecting` \| `disconnected` |

### Provider behavior

- Auto-connects when a token is present and never reconnects for inline config
  object identity changes
- Replacing `config.token` disconnects the old socket, clears its private state
  cache and connects with the new credentials

## Auth and chip utilities

```ts
import {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalTypedData,
  generateIdempotencyKey,
  formatChips,
  parseChips,
} from "@pokertools/sdk";

const message = createSiweMessage({
  address,
  chainId: 1, // must be in API's ALLOWED_SIWE_CHAIN_IDS (default 1,31337)
  domain: "api.example.com",
  uri: "https://api.example.com",
  statement: "Sign in to PokerTools",
  nonce: await client.getNonce(),
});

// verify/sign locally…
const parsed = parseSiweMessage(message);
console.log(isSiweExpired(message)); // false

// Chips are integer game units: no currency symbol, no ÷100
formatChips(100); // "100"
formatChips(1_000_000); // "1,000,000"
parseChips("1,000"); // 1000
parseChips("$1.00"); // throws
```
