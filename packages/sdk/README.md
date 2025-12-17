# @pokertools/sdk

[![npm version](https://img.shields.io/npm/v/@pokertools/sdk)](https://www.npmjs.com/package/@pokertools/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official TypeScript SDK for the **PokerTools** platform. Build real-time Texas Hold'em applications with ease, featuring robust state management, WebSocket integration, and React hooks.

## ✨ Features

- 🔌 **Real-time WebSocket Client**: Automatic reconnection, heartbeats, and typed events.
- 🎣 **React Hooks**: `useTable`, `usePoker`, `useUser` for seamless UI integration.
- 🔐 **Authentication**: Built-in support for Sign-In with Ethereum (SIWE).
- 🛡️ **Type-Safe**: Full TypeScript support with shared types from the core engine.
- 🔄 **State Management**: Automatic synchronization of game state (snapshots + delta updates).
- 💰 **Financials**: Deposit, withdrawal, and chip management utilities.

## 📦 Installation

```bash
npm install @pokertools/sdk @pokertools/types
# or
yarn add @pokertools/sdk @pokertools/types
# or
pnpm add @pokertools/sdk @pokertools/types
```

## 🚀 Quick Start (React)

Wrap your application in the `PokerProvider` and use the hooks to interact with the game.

```tsx
import React from "react";
import { PokerProvider, useTable } from "@pokertools/sdk/react";

const config = {
  baseUrl: "https://api.poker.example.com",
  token: "YOUR_JWT_TOKEN", // Optional: can be set later via client.setToken()
};

export default function App() {
  return (
    <PokerProvider config={config}>
      <GameTable tableId="table-123" />
    </PokerProvider>
  );
}

function GameTable({ tableId }: { tableId: string }) {
  // Automatically joins the table via WebSocket and syncs state
  const { state, isLoading, action } = useTable(tableId);

  if (isLoading) return <div>Loading table...</div>;
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
        <button onClick={() => action("BET", 100)}>Bet $1</button>
      </div>
    </div>
  );
}
```

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

| Component       | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `PokerClient`   | Handles REST API requests (Tables, User, Finance).             |
| `PokerSocket`   | Manages WebSocket connection and real-time events.             |
| `PokerProvider` | React Context provider that initializes the client and socket. |
| `useTable`      | Hook that subscribes to a specific table's updates.            |

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
});

await socket.connect();

// Subscribe to table updates
const initialState = await socket.join("table-1");
console.log("Initial State:", initialState);

// Listen for updates
socket.on("stateUpdate", (tableId, state) => {
  console.log("New State:", state);
});

socket.on("action", (tableId, playerId, type, amount) => {
  console.log(`Player ${playerId} did ${type}`);
});
```

## 🛠️ API Reference

### `useTable(tableId, options)`

| Option         | Type      | Default     | Description                                 |
| -------------- | --------- | ----------- | ------------------------------------------- |
| `autoJoin`     | `boolean` | `true`      | Automatically join the table via WebSocket. |
| `pollInterval` | `number`  | `undefined` | Fallback polling interval in ms (optional). |

**Returns:**

- `state`: The current `PublicState` of the table.
- `isLoading`: Boolean indicating if initial state is being fetched.
- `action(type, amount)`: Function to perform game actions.
- `refresh()`: Manually re-fetch state.

---

Made with ♥ for the Poker Community.
