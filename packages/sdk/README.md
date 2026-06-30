# @pokertools/sdk

[![npm version](https://img.shields.io/npm/v/@pokertools/sdk)](https://www.npmjs.com/package/@pokertools/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official TypeScript SDK for the **PokerTools** platform. Build real-time Texas Hold'em applications with ease, featuring robust state management, WebSocket integration, and React hooks.

## ✨ Features

- 🔌 **Real-time WebSocket Client**: Automatic reconnection, heartbeats, and typed events. JWTs are sent as WebSocket subprotocol credentials (not in the URL query string) to avoid leaking tokens in access logs.
- 🎣 **React Hooks**: `PokerProvider`, `usePoker`, `usePokerClient`, `usePokerSocket`, `useTable`, `useUser`, `useTables`, `useTournaments`, `useTournament`, `useConnection` for seamless UI integration.
- 🔐 **Authentication**: Built-in support for Sign-In with Ethereum (SIWE), nonce/lifecycle helpers, and replay-safe withdrawal message generation.
- 🛡️ **Type-Safe**: Full TypeScript support with shared types re-exported from `@pokertools/types`.
- 🔄 **State Management**: Automatic synchronization of game state (snapshots + delta updates) with version-tracking and conditional fetching.
- 💰 **Financials**: Deposit, withdrawal, and chip management utilities with full REST client coverage.

## 📦 Installation

```bash
npm install @pokertools/sdk @pokertools/types
# or
yarn add @pokertools/sdk @pokertools/types
# or
pnpm add @pokertools/sdk @pokertools/types
```

`@pokertools/sdk` (v1.0.15) depends on `@pokertools/types` (v1.0.15) for shared TypeScript types.
The React hooks require `react >= 19.2.3` as an **optional** peer dependency — install `react`
and `react-dom` only if you plan to use the React integration.

Requires **Node.js >= 24.0.0**.

## 🚀 Quick Start (React)

Wrap your application in `PokerProvider` and use the hooks to interact with tables, user profile, and connection state.

```tsx
import React from "react";
import {
  PokerProvider,
  useTable,
  usePoker,
  useUser,
  useTables,
  useConnection,
} from "@pokertools/sdk/react";

const config = {
  baseUrl: "https://api.poker.example.com",
  token: "YOUR_JWT_TOKEN", // Optional: set later via client.setToken() or auth flow
};

export default function App() {
  return (
    <PokerProvider config={config}>
      <Lobby />
      <GameTable tableId="table-123" />
    </PokerProvider>
  );
}

function Lobby() {
  const { tables, isLoading } = useTables();

  if (isLoading) return <div>Loading tables...</div>;

  return (
    <ul>
      {tables.map((t) => (
        <li key={t.id}>
          {t.name} — {t.seatedCount}/{t.maxPlayers} players
        </li>
      ))}
    </ul>
  );
}

function GameTable({ tableId }: { tableId: string }) {
  // Automatically joins the table via WebSocket and syncs state
  const { state, isLoading, error, action } = useTable(tableId);
  const { profile } = useUser();

  if (isLoading) return <div>Loading table...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!state) return <div>Table not found</div>;

  return (
    <div className="poker-table">
      <h2>Pot: ${state.pot / 100}</h2>

      <div className="community-cards">
        {state.communityCards.map((card) => (
          <Card key={card} card={card} />
        ))}
      </div>

      <div className="controls">
        <button onClick={() => action("CHECK")}>Check</button>
        <button onClick={() => action("FOLD")}>Fold</button>
        <button onClick={() => action("CALL")}>Call</button>
        <button onClick={() => action("BET", 100)}>Bet $1</button>
      </div>

      {profile && (
        <div className="player-info">
          Playing as: {profile.username} | Balance: ${profile.balances.main / 100}
        </div>
      )}
    </div>
  );
}

function ConnectionStatus() {
  const { isConnected, latency } = useConnection();

  return (
    <div className="connection-status">
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

The SDK bridges your frontend application with the PokerTools API and Real-time Engine.

```
┌───────────────┐
│ Your App / UI │
└───────┬───────┘
        │ React Hooks
        ▼
┌─────────────────┐
│ @pokertools/sdk │
└───────┬───────┬─┘
        │       │
        │       │ WebSocket
        │       └─────────────────────────┐
        │ REST HTTP                       │
        ▼                                 ▼
┌────────────────┐                ┌──────────────────┐
│ PokerTools API │                │ Real-time Engine │
└───────┬────────┘                └───────┬──────────┘
        │                                 │
        │ Auth/Data                       │ Game State
        ▼                                 │
   ┌──────────┐                           │
   │ Database │◄──────────────────────────┘
   └──────────┘
```

### Key Components

| Component        | Description                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PokerClient`    | Handles REST API requests (Tables, Tournaments, User, Finance, Notes, Health). Auto-retry with exponential backoff.                                                        |
| `PokerSocket`    | Manages WebSocket connection, auto-reconnection, heartbeats, and typed real-time events.                                                                                   |
| `PokerProvider`  | React Context provider that initializes the client and socket. Accepts `autoConnect` prop (default `true`) to automatically connect the WebSocket when a token is present. |
| `useTable`       | Hook that subscribes to a specific table's real-time updates via WebSocket (snapshots + deltas).                                                                           |
| `useUser`        | Hook to fetch and manage the current user's profile and balances.                                                                                                          |
| `useTables`      | Hook to fetch the list of active tables from the REST API.                                                                                                                 |
| `useTournaments` | Hook to fetch active and registering tournament lobbies from the REST API.                                                                                                 |
| `useTournament`  | Hook to fetch one tournament's entries, table assignments, blind structure, and payout configuration.                                                                      |
| `usePoker`       | Low-level hook to access the full `PokerContextValue` (client, socket, connection state).                                                                                  |
| `usePokerClient` | Convenience hook to get the `PokerClient` instance.                                                                                                                        |
| `usePokerSocket` | Convenience hook to get the `PokerSocket` instance (null if not connected).                                                                                                |
| `useConnection`  | Hook to monitor WebSocket connection state and measure latency via application-level ping.                                                                                 |

`STATE_UPDATE` WebSocket events are lightweight version notifications. Use `getTableVersion(tableId)` to inspect the latest server version and fetch full state via REST when the version advances beyond your cached snapshot.

## 🔑 Authentication (SIWE)

The SDK uses Sign-In with Ethereum. Here is a typical flow:

1.  **Get Nonce**: Request a random nonce from the server.
2.  **Sign Message**: Ask the user's wallet (e.g., via generic wallet provider) to sign the SIWE message.
3.  **Login**: Send the message and signature to the API to receive a JWT.

```typescript
import { createSiweMessage } from '@pokertools/sdk';
import { usePokerClient } from '@pokertools/sdk/react';

function LoginButton() {
  const client = usePokerClient();

  const handleLogin = async () => {
    // 1. Get Nonce
    const nonce = await client.getNonce();

    // 2. Create Message
    const message = createSiweMessage({
      domain: window.location.host,
      address: userWalletAddress,
      uri: window.location.origin,
      nonce,
      statement: "Sign in to PokerTools"
    });

    // 3. Sign (using your wallet provider, e.g. wagmi/viem)
    const signature = await wallet.signMessage(message);

    // 4. Login
    const { token, user } = await client.login({ message, signature });
    console.log("Logged in as:", user.username);
  };

  return <button onClick={handleLogin}>Sign In with Ethereum</button>;
}
```

## 📡 Real-time Events

If you are not using React, you can use the `PokerSocket` directly.

```typescript
import { PokerSocket } from "@pokertools/sdk";

const socket = new PokerSocket({
  url: "wss://api.poker.example.com/ws/play",
  token: "jwt-token",
  heartbeatInterval: 25000, // default
  reconnectAttempts: 10, // default
  reconnectDelay: 1000, // default base delay (ms)
  maxReconnectDelay: 30000, // default max delay (ms)
  debug: false, // enable debug logging
});

// The SDK does NOT append token=... to the URL. It connects with
// Sec-WebSocket-Protocol: pokertools, jwt.<token> to avoid leaking JWTs in logs.

// Lifecycle events
socket.on("connect", () => console.log("Connected"));
socket.on("disconnect", (reason) => console.log("Disconnected:", reason));
socket.on("reconnect", (attempt) => console.log("Reconnecting (attempt " + attempt + ")"));
socket.on("error", (error) => console.error("Socket error:", error));

await socket.connect();

// Join a table and receive initial snapshot
const initialState = await socket.join("table-1");
console.log("Initial state:", initialState);

// Listen for state updates (version-tracked; only emitted when prior snapshot is cached)
socket.on("stateUpdate", (tableId, state) => {
  console.log(`Table ${tableId} version:`, state.version);
});

// Full state snapshot (emitted on join, reconnect, and periodic sync)
socket.on("snapshot", (tableId, state) => {
  console.log("Full state:", state);
});

// Player actions
socket.on("action", (tableId, playerId, actionType, amount) => {
  console.log(`Player ${playerId} did ${actionType}${amount ? " " + amount : ""}`);
});

// Inspect the latest server version without fetching full state
const version = socket.getTableVersion("table-1");

// Application-level ping (not WebSocket protocol ping)
const rtt = await socket.ping();
console.log(`Round-trip time: ${rtt}ms`);

// One-time listener
socket.once("connect", () => console.log("First connect"));

// Leave a table
socket.leave("table-1");

// Manual disconnect (stops auto-reconnect)
socket.disconnect();
```

## 🛠️ API Reference

### React Hooks

#### `PokerProvider`

Props:

| Prop          | Type             | Default | Description                                                      |
| ------------- | ---------------- | ------- | ---------------------------------------------------------------- |
| `config`      | `PokerSDKConfig` | —       | SDK configuration (baseUrl, token, timeout, retry, debug, etc.). |
| `autoConnect` | `boolean`        | `true`  | Automatically open WebSocket when `config.token` is set.         |
| `children`    | `ReactNode`      | —       | React children.                                                  |

#### `usePoker()`

Returns the full `PokerContextValue`:

- `client`: `PokerClient` instance for REST API calls.
- `socket`: `PokerSocket | null` for WebSocket operations.
- `isAuthenticated`: `boolean` — whether a token is present.
- `connectionState`: `"disconnected" | "connecting" | "connected" | "reconnecting"`.
- `connect()`: Initiates WebSocket connection (requires token).
- `disconnect()`: Closes WebSocket connection.

#### `usePokerClient()`

Returns the `PokerClient` instance from context.

#### `usePokerSocket()`

Returns the `PokerSocket` instance (or `null` if not connected).

#### `useUser()`

Returns:

| Field       | Type                   | Description                                                       |
| ----------- | ---------------------- | ----------------------------------------------------------------- |
| `profile`   | `UserProfile \| null`  | Full profile including `username`, `address`, `role`, `balances`. |
| `balances`  | `UserBalances \| null` | `{ main: number, inPlay: number }` in cents.                      |
| `isLoading` | `boolean`              | Initial fetch in progress.                                        |
| `error`     | `Error \| null`        | Fetch error if any.                                               |
| `refresh()` | `() => Promise<void>`  | Re-fetch profile from API.                                        |

#### `useTable(tableId, options?)`

Options:

| Option         | Type      | Default     | Description                           |
| -------------- | --------- | ----------- | ------------------------------------- |
| `autoJoin`     | `boolean` | `true`      | Auto-join table WebSocket on mount.   |
| `pollInterval` | `number`  | `undefined` | Fallback HTTP polling interval in ms. |

Returns:

| Field       | Type                                               | Description                                                  |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `state`     | `PublicState \| null`                              | Current table state (cached + live).                         |
| `isLoading` | `boolean`                                          | Initial fetch in progress.                                   |
| `error`     | `Error \| null`                                    | Fetch error if any.                                          |
| `refresh()` | `() => Promise<void>`                              | Re-fetch state from REST API.                                |
| `action()`  | `(type: string, amount?: number) => Promise<void>` | Execute a game action (CHECK, FOLD, CALL, BET, RAISE, etc.). |
| `leave()`   | `() => Promise<void>`                              | Stand from table and leave WebSocket subscription.           |

#### `useTables()`

Returns:

| Field       | Type                  | Description                         |
| ----------- | --------------------- | ----------------------------------- |
| `tables`    | `TableListItem[]`     | List of active tables from the API. |
| `isLoading` | `boolean`             | Initial fetch in progress.          |
| `error`     | `Error \| null`       | Fetch error if any.                 |
| `refresh()` | `() => Promise<void>` | Re-fetch tables list.               |

#### `useConnection()`

Returns:

| Field            | Type                            | Description                                        |
| ---------------- | ------------------------------- | -------------------------------------------------- |
| `state`          | `ConnectionState`               | Current WebSocket connection state.                |
| `isConnected`    | `boolean`                       | `true` when fully connected.                       |
| `isConnecting`   | `boolean`                       | `true` during initial handshake.                   |
| `isReconnecting` | `boolean`                       | `true` during automatic reconnection.              |
| `latency`        | `number \| null`                | Last measured RTT in ms (requires calling `ping`). |
| `connect()`      | `() => Promise<void>`           | Manually initiate connection.                      |
| `disconnect()`   | `() => void`                    | Manually close connection.                         |
| `ping()`         | `() => Promise<number \| null>` | Measure round-trip time.                           |

---

### PokerClient (REST API)

The `PokerClient` class provides type-safe methods for every API endpoint. Obtain it via `new PokerClient(config)` or `usePokerClient()` in React.

#### Configuration

```typescript
interface PokerSDKConfig {
  baseUrl: string; // API base URL (e.g., "https://api.poker.example.com")
  wsUrl?: string; // WebSocket URL (defaults to baseUrl with ws:// protocol)
  token?: string; // JWT token
  timeout?: number; // Request timeout in ms (default: 30000)
  retry?: {
    // Retry config
    count?: number; //   Max retries (default: 3)
    delay?: number; //   Base delay in ms (default: 1000)
    backoff?: number; //   Exponential multiplier (default: 2)
  };
  fetch?: typeof fetch; // Custom fetch implementation
  WebSocket?: typeof WebSocket; // Custom WebSocket implementation
  debug?: boolean; // Enable debug logging
}
```

#### Methods

| Method                            | Description                                                             |
| --------------------------------- | ----------------------------------------------------------------------- |
| `setToken(token)`                 | Update or clear the JWT.                                                |
| `getToken()`                      | Get current token.                                                      |
| `isAuthenticated()`               | Check if token is present.                                              |
| `health()`                        | `GET /health` — health check.                                           |
| `getNonce()`                      | `POST /auth/nonce` — get SIWE nonce.                                    |
| `login(request)`                  | `POST /auth/login` — complete SIWE auth.                                |
| `logout()`                        | `POST /auth/logout` — revoke session.                                   |
| `getTables()`                     | `GET /tables` — list active tables.                                     |
| `createTable(config)`             | `POST /tables` — create a new table. Returns `tableId`.                 |
| `getTableState(id, since?)`       | `GET /tables/:id` — fetch state; returns `null` (via 304) if unchanged. |
| `buyIn(tableId, request)`         | `POST /tables/:id/buy-in` — join a table.                               |
| `action(tableId, request)`        | `POST /tables/:id/action` — execute game action.                        |
| `getTournaments()`                | `GET /tournaments` — list registration and running tournaments.         |
| `createTournament(request)`       | `POST /tournaments` — create a tournament lobby.                        |
| `getTournament(id)`               | `GET /tournaments/:id` — fetch entries, tables, and payout config.      |
| `registerTournament(id, request)` | `POST /tournaments/:id/register` — register and debit buy-in/fee.       |
| `startTournament(id)`             | `POST /tournaments/:id/start` — start and receive table distribution.   |
| `reconcileTournament(id)`         | `POST /tournaments/:id/reconcile` — run tournament-director balancing.  |
| `advanceTournamentBlinds(id)`     | `POST /tournaments/:id/advance-blinds` — advance active table blinds.   |
| `settleTournament(id)`            | `POST /tournaments/:id/settle` — pay configured prize distribution.     |

**Convenience action wrappers** (all return `Promise<PublicState>`):

| Method                    | Equivalent                                  |
| ------------------------- | ------------------------------------------- |
| `fold(tableId)`           | `action(id, { type: "FOLD" })`              |
| `check(tableId)`          | `action(id, { type: "CHECK" })`             |
| `call(tableId)`           | `action(id, { type: "CALL" })`              |
| `bet(tableId, amount)`    | `action(id, { type: "BET", amount })`       |
| `raise(tableId, amount)`  | `action(id, { type: "RAISE", amount })`     |
| `deal(tableId)`           | `action(id, { type: "DEAL" })`              |
| `show(tableId, indices?)` | `action(id, { type: "SHOW", cardIndices })` |
| `muck(tableId)`           | `action(id, { type: "MUCK" })`              |
| `timeBank(tableId)`       | `action(id, { type: "TIME_BANK" })`         |

Additional REST methods:

| Method                                | Description                                            |
| ------------------------------------- | ------------------------------------------------------ |
| `addChips(tableId, req)`              | `POST /tables/:id/add-chips` — rebuy/top-up.           |
| `stand(tableId)`                      | `POST /tables/:id/stand` — leave and cash out.         |
| `getProfile()`                        | `GET /user/me` — user profile and balances.            |
| `getHandHistory()`                    | `GET /user/history` — hand history entries.            |
| `withdraw(request)`                   | `POST /user/withdraw` — signed withdrawal request.     |
| `getWithdrawals()`                    | `GET /user/withdrawals` — withdrawal history.          |
| `getChains()`                         | `GET /finance/chains` — supported blockchains/tokens.  |
| `startDeposit()`                      | `POST /finance/deposit/start` — start deposit session. |
| `getDepositAddress()`                 | `GET /finance/deposit/address` — get deposit address.  |
| `getDeposits()`                       | `GET /finance/deposits` — deposit history.             |
| `getNotes()`                          | `GET /notes` — all player notes.                       |
| `getNote(targetId)`                   | `GET /notes/:id` — specific player note.               |
| `saveNote(targetId, content, label?)` | `POST /notes` — create/update note.                    |
| `deleteNote(targetId)`                | `DELETE /notes/:id` — delete note.                     |

---

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

Static factory: `PokerSocket.fromConfig(config: PokerSDKConfig)` creates a socket from SDK config.

Methods:

| Method                     | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `connect()`                | Open WebSocket connection. Returns `Promise<void>`.            |
| `disconnect()`             | Close connection and stop auto-reconnect.                      |
| `getState()`               | Returns current `ConnectionState`.                             |
| `isConnected()`            | Returns `boolean`.                                             |
| `join(tableId)`            | Join table subscription. Returns `Promise<PublicState>`.       |
| `leave(tableId)`           | Leave table subscription.                                      |
| `getJoinedTables()`        | Returns `string[]` of table IDs.                               |
| `getCachedState(tableId)`  | Returns `PublicState \| undefined`.                            |
| `getTableVersion(tableId)` | Returns latest server version number `\| undefined`.           |
| `on(event, listener)`      | Subscribe to event. Returns unsubscribe function.              |
| `off(event, listener)`     | Unsubscribe from event.                                        |
| `once(event, listener)`    | Subscribe for a single emission. Returns unsubscribe function. |
| `ping()`                   | Application-level ping. Returns `Promise<number>` (RTT in ms). |

Events:

| Event         | Signature                                                                          | Description                   |
| ------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| `connect`     | `() => void`                                                                       | WebSocket connected.          |
| `disconnect`  | `(reason?: string) => void`                                                        | WebSocket disconnected.       |
| `reconnect`   | `(attempt: number) => void`                                                        | Reconnection started.         |
| `error`       | `(error: Error) => void`                                                           | Socket-level or server error. |
| `snapshot`    | `(tableId: string, state: PublicState) => void`                                    | Full table state snapshot.    |
| `stateUpdate` | `(tableId: string, state: PublicState) => void`                                    | Version-tracked delta update. |
| `action`      | `(tableId: string, playerId: string, actionType: string, amount?: number) => void` | Player action observed.       |

---

### Auth Helpers (SIWE)

Exported from `@pokertools/sdk`:

| Function                                               | Description                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `createSiweMessage(params)`                            | Build an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) SIWE message string for wallet signing. |
| `parseSiweMessage(message)`                            | Parse a SIWE message back into `Partial<SiweMessageParams>`.                                         |
| `isSiweExpired(message)`                               | Check if a SIWE message's expiration time has passed.                                                |
| `createWithdrawalMessage(amount, address, nonce, ts?)` | Build a replay-safe withdrawal message with nonce + timestamp.                                       |
| `generateIdempotencyKey()`                             | Generate a random UUID v4 idempotency key.                                                           |

Also exported: `SiweMessageParams` type.

---

### Utilities

Exported from `@pokertools/sdk` (25+ helpers for formatting, state inspection, and display):

**Chip formatting:**

| Function                        | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `formatChips(chips, currency?)` | Convert cents to display string (e.g., `"$10.00"`). |
| `parseChips(amount)`            | Parse display string to cents.                      |
| `abbreviateNumber(num)`         | Abbreviate (e.g., `1000` → `"1.0K"`).               |

**State inspection:**

| Function                   | Description                                  |
| -------------------------- | -------------------------------------------- |
| `getActivePlayer(state)`   | Player whose turn it is (by `actionTo`).     |
| `getPlayerById(state, id)` | Find player in state by ID.                  |
| `getPlayerSeat(state, id)` | Get seat index for a player.                 |
| `isPlayerTurn(state, id)`  | Check if it's a specific player's turn.      |
| `getCallAmount(state, id)` | Amount needed to call (capped by stack).     |
| `getMinRaise(state)`       | Minimum raise amount (minRaise or bigBlind). |
| `canCheck(state, id)`      | Whether player can check.                    |
| `canBet(state, id)`        | Whether player can open-bet.                 |
| `getTotalPot(state)`       | Sum of main + side pots.                     |
| `getActivePlayers(state)`  | Players with stack > 0 and not folded.       |
| `getPlayersInHand(state)`  | Players not folded.                          |
| `getPotOdds(state, id)`    | Pot odds as a ratio (Infinity if no call).   |
| `isShowdown(state)`        | Check if street is SHOWDOWN.                 |
| `isHandComplete(state)`    | Check if winners are determined.             |

**Display helpers:**

| Function                | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `suitToEmoji(suit)`     | Convert suit char to emoji (e.g., `"s"` → `"♠"`). |
| `formatCard(card)`      | Format card string (e.g., `"As"` → `"A♠"`).       |
| `formatCards(cards)`    | Format card array (null-safe).                    |
| `getStreetName(street)` | Convert street enum to display name.              |

---

### Main Exports

#### `@pokertools/sdk` (main entry)

| Export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Kind                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `PokerClient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Class                                       |
| `PokerSocket`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Class                                       |
| `createSiweMessage`, `parseSiweMessage`, `isSiweExpired`, `createWithdrawalMessage`, `generateIdempotencyKey`                                                                                                                                                                                                                                                                                                                                                                                                     | Function                                    |
| `SiweMessageParams`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Type                                        |
| `formatChips`, `parseChips`, `getActivePlayer`, `getPlayerById`, `getPlayerSeat`, `isPlayerTurn`, `getCallAmount`, `getMinRaise`, `canCheck`, `canBet`, `getTotalPot`, `getActivePlayers`, `getPlayersInHand`, `suitToEmoji`, `formatCard`, `formatCards`, `getStreetName`, `isShowdown`, `isHandComplete`, `getPotOdds`, `abbreviateNumber`                                                                                                                                                                      | Function                                    |
| `PokerSDKConfig`, `UserBalances`, `UserProfile`, `BlockchainInfo`, `TokenInfo`, `DepositSession`, `DepositRecord`, `WithdrawalRequest`, `WithdrawalRecord`, `HandHistoryEntry`, `PlayerNote`, `ConnectionState`, `PokerSocketEvents`, `EventListener`                                                                                                                                                                                                                                                             | Type                                        |
| `PokerSDKError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Class                                       |
| `PublicState`, `PublicPlayer`, `GameState`, `Player`, `Action`, `ActionType`, `TableConfig`, `ServerMessage`, `ClientMessage`, `SnapshotMessage`, `StateUpdateMessage`, `ErrorMessage`, `JoinTableMessage`, `LeaveTableMessage`, `CreateTableRequest`, `BuyInRequest`, `AddChipsRequest`, `GameActionRequest`, `LoginRequest`, `LoginResponse`, `NonceResponse`, `TableListItem`, `TournamentListItem`, `TournamentDetails`, `StartTournamentResponse`, `ReconcileTournamentResponse`, `SettleTournamentResponse` | Type (re-exported from `@pokertools/types`) |

#### `@pokertools/sdk/react` (React subpath)

| Export                                                                                                                                 | Kind      |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `PokerProvider`                                                                                                                        | Component |
| `PokerProviderProps`                                                                                                                   | Type      |
| `PokerContextValue`                                                                                                                    | Type      |
| `usePoker`, `usePokerClient`, `usePokerSocket`, `useTable`, `useUser`, `useTables`, `useTournaments`, `useTournament`, `useConnection` | Hook      |
| `UseTableOptions`, `UseTableResult`, `UseUserResult`, `UseTablesResult`                                                                | Type      |

---

Made with ♥ for the Poker Community.
