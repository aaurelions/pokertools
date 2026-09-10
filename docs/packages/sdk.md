# @pokertools/sdk

TypeScript SDK with REST helpers, WebSocket state sync, auth utilities and optional
React 19 hooks. One client for browser and Node.js environments.

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

// 2. List tables and act
const tables = await client.getTables();
const state = await client.action("table_abc", { type: "RAISE", amount: 60 });
const state2 = await client.raise("table_abc", 80); // or use the sugar method

// 3. Real-time updates over WebSocket
const socket = PokerSocket.fromConfig({
  baseUrl: "https://api.example.com",
  token: client.getToken()!,
});
await socket.connect();
const joined = await socket.join("table_abc"); // returns the current masked state
socket.on("state", (next) => console.log("version", next.version));
```

## HTTP client

Constants and configuration:

| Option                          | Default     | Description                                |
| :------------------------------ | :---------- | :----------------------------------------- |
| `baseUrl`                       | —           | API origin                                 |
| `token`                         | —           | Bearer token; swapped into `Authorization` |
| `timeout`                       | `10_000`    | Full request deadline (incl. body read)    |
| `retry.count`                   | `2`         | Automatic retry attempts                   |
| `retry.delay` / `retry.backoff` | `200` / `2` | Exponential backoff                        |
| `idempotencyKey`                | —           | Client-generated key for mutating requests |
| `debug`                         | `false`     | Log requests/retries                       |

### Retry policy

| Request type                        | Retried? | Notes                               |
| :---------------------------------- | :------- | :---------------------------------- |
| `GET`                               | ✅       | Safe reads                          |
| Mutations **with** `idempotencyKey` | ✅       | Server dedupes replays              |
| Mutations **without** key           | ❌       | Never auto-replayed                 |
| `429` / `503`                       | ✅       | Respects `Retry-After` when present |
| Other `4xx`                         | ❌       | `304` aborts immediately            |
| Timeout / abort                     | ❌       | Throws `TIMEOUT` with the deadline  |

```ts
const client = new PokerClient({
  baseUrl: "https://api.example.com",
  idempotencyKey: generateIdempotencyKey(), // every mutation is safe to retry
});
```

Empty `204`/`205` responses are supported and return `undefined`.

### Error handling

Errors surface as `PokerSDKError` (from `@pokertools/sdk`) with a stable `code`, HTTP
`statusCode` and optional `details`:

```ts
import { PokerClient, PokerSDKError } from "@pokertools/sdk";

try {
  await client.action("table_abc", { type: "RAISE", amount: 60 });
} catch (err) {
  if (err instanceof PokerSDKError) {
    switch (err.code) {
      case "NOT_YOUR_TURN":
      case "CANNOT_RERAISE":
      case "RAISE_TOO_SMALL": // engine rule violations
        break;
      case "RATE_LIMITED":
        await new Promise((r) => setTimeout(r, 2000));
        break;
      case "TIMEOUT":
        console.warn("request exceeded deadline", err.details);
        break;
    }
  }
}
```

Socket errors arrive through the `error` event; the socket automatically reconnects with
backoff and re-joins previously joined tables.

### Client method groups

| Group             | Methods                                                                                                                                                                              |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | `getNonce()`, `login(request)`, `logout()`, `setToken()`, `isAuthenticated()`                                                                                                        |
| Tables            | `getTables()`, `createTable()`, `getTableState(id, since?)`, `buyIn()`, `action()`, `addChips()`, `stand()`                                                                          |
| Table sugar       | `fold()`, `check()`, `call()`, `bet()`, `raise()`, `deal()`, `show()`, `muck()`, `timeBank()`                                                                                        |
| Tournaments       | `getTournaments()`, `createTournament()`, `getTournament()`, `registerTournament()`, `startTournament()`, `reconcileTournament()`, `advanceTournamentBlinds()`, `settleTournament()` |
| Profile & history | `getProfile()`, `getHandHistory()`                                                                                                                                                   |
| Finance           | `withdraw()`, `getWithdrawals()`, `getChains()`, `startDeposit()`, `getDepositAddress()`, `getDeposits()`                                                                            |
| Notes             | `getNotes()`                                                                                                                                                                         |

## WebSocket transport

`PokerSocket` (created with `fromConfig`) keeps a versioned cache per joined table:

| Method                                                                   | Description                                                           |
| :----------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| `connect()`                                                              | Establish the authenticated socket connection                         |
| `disconnect()`                                                           | Close (used on logout / token rotation)                               |
| `join(tableId)`                                                          | Subscribe to a table — resolves with the current masked `PublicState` |
| `leave(tableId)`                                                         | Unsubscribe                                                           |
| `getJoinedTables()`                                                      | List active subscriptions                                             |
| `getState()` / `isConnected()`                                           | Connection introspection                                              |
| `on("state" \| "connect" \| "disconnect" \| "reconnect" \| "error", cb)` | Event subscription                                                    |

- Reconnects with exponential backoff and restores table subscriptions
- Token rotation **replaces the socket** (and its cached private state)
- A table's version cache lets `getTableState(id, since)` fetch deltas only

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
  const { state, action } = useTable("table_abc");
  const { status } = useConnection();

  if (status !== "connected") return <p>Connecting…</p>;

  return (
    <>
      <div>Street: {state.street}</div>
      <button onClick={() => action("RAISE", 40)}>Raise to 40</button>
    </>
  );
}
```

| Hook                      | Returns                                                  | Purpose                                                         |
| :------------------------ | :------------------------------------------------------- | :-------------------------------------------------------------- |
| `usePoker()`              | `{ client, socket, state, connect, disconnect, config }` | Global context access                                           |
| `usePokerClient()`        | `PokerClient`                                            | Raw client                                                      |
| `usePokerSocket()`        | `PokerSocket \| null`                                    | Live socket                                                     |
| `useTable(tableId, opts)` | `{ state, action, version, error }`                      | Table state + action helper                                     |
| `useUser()`               | `{ user, loading }`                                      | Current profile                                                 |
| `useTables()`             | `{ tables, refresh }`                                    | Table list                                                      |
| `useTournaments()`        | `{ tournaments, refresh }`                               | Tournament list                                                 |
| `useTournament(id)`       | `{ tournament, refresh }`                                | Tournament details                                              |
| `useConnection()`         | `{ status }`                                             | `connecting` \| `connected` \| `reconnecting` \| `disconnected` |

### Provider behavior

- Auto-connects when a token is present and never reconnects for inline config
  object identity changes
- Replacing `config.token` disconnects the old socket, clears its private state cache
  and connects with the new credentials

## Auth utilities

```ts
import {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalMessage,
  generateIdempotencyKey,
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

// Withdrawal consent messages
const withdrawalMsg = createWithdrawalMessage(5000, "0xabc…", nonce);
// "Withdraw 5000 USD to 0xabc…\nNonce: …\nTimestamp: …"
```
