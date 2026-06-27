# 🃏 @pokertools/engine

> **Enterprise-grade Texas Hold'em poker game engine**

[![npm version](https://img.shields.io/npm/v/@pokertools/engine.svg)](https://www.npmjs.com/package/@pokertools/engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-349%20passed-brightgreen.svg)]()

A **production-ready** poker game engine featuring immutable state management, chip conservation auditing, side pot calculation, rake handling, tournament support, and comprehensive rule enforcement.

---

## ✨ Features

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ENGINE FEATURES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  🎰 Complete Texas Hold'em Implementation                                   │
│  ♻️  Immutable State Machine (Redux-style)                                  │
│  💰 Chip Conservation Auditing                                              │
│  🏦 Side Pot Calculation                                                    │
│  📊 Rake Support (% + cap + noFlopNoDrop)                                   │
│  🏆 Tournament Mode (blind structure)                                       │
│  👀 View Masking (anti-cheat)                                               │
│  💾 Snapshot Serialization                                                  │
│  ↩️  Undo Support                                                           │
│  📜 Hand History Export (JSON, PokerStars)                                  │
│  🌐 Browser Support (Web Crypto RNG)                                        │
│  🔒 Type-safe Error Handling                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📦 Installation

```bash
npm install @pokertools/engine
```

```bash
yarn add @pokertools/engine
```

```bash
pnpm add @pokertools/engine
```

---

## 🚀 Quick Start

```typescript
import { PokerEngine, ActionType } from "@pokertools/engine";

// Create a cash game table
const engine = new PokerEngine({
  smallBlind: 1,
  bigBlind: 2,
  maxPlayers: 6,
});

// Seat players
engine.sit(0, "alice", "Alice", 200);
engine.sit(1, "bob", "Bob", 200);

// Deal a hand
engine.deal();

// Get current state
console.log(engine.state.street); // "PREFLOP"
console.log(engine.state.actionTo); // 0 (Alice's turn)

// Execute actions
engine.act({ type: ActionType.CALL, playerId: "alice" });
engine.act({ type: ActionType.CHECK, playerId: "bob" });

// Get player view (masked for opponents)
const aliceView = engine.view("alice");
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ARCHITECTURE                                      │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────┐
                    │        PokerEngine           │
                    │   (Stateful API Wrapper)     │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │        gameReducer           │
                    │   f(state, action) => state  │
                    │     (Pure Function)          │
                    └──────────────┬───────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
         ▼                         ▼                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Actions      │     │     Rules       │     │    Utilities    │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ • betting.ts    │     │ • actionOrder   │     │ • viewMasking   │
│ • dealing.ts    │     │ • blinds        │     │ • serialization │
│ • management.ts │     │ • headsUp       │     │ • invariants    │
│ • showdown.ts   │     │ • showdown      │     │ • rake          │
│ • special.ts    │     │ • sidePots      │     │ • deck          │
│ • tournament.ts │     └─────────────────┘     │ • cardUtils     │
└─────────────────┘                             └─────────────────┘
```

### State Flow

```
┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌──────────┐
│ PREFLOP │ ──▶  │  FLOP   │ ──▶  │  TURN   │ ──▶  │  RIVER  │ ──▶  │ SHOWDOWN │
└─────────┘      └─────────┘      └─────────┘      └─────────┘      └──────────┘
     │                                                                    │
     │                    All but one fold                                │
     └────────────────────────────────────────────────────────────────────┘
                              (Award pot)
```

---

## 📖 API Reference

### PokerEngine Class

#### Constructor

```typescript
import { PokerEngine } from "@pokertools/engine";

const engine = new PokerEngine(config: TableConfig, timeProvider?: () => number);
```

**TableConfig Options:**

| Option              | Type           | Default       | Description                  |
| ------------------- | -------------- | ------------- | ---------------------------- |
| `smallBlind`        | `number`       | required      | Small blind amount           |
| `bigBlind`          | `number`       | required      | Big blind amount             |
| `ante`              | `number`       | `0`           | Ante per player              |
| `maxPlayers`        | `number`       | `9`           | Maximum seats (2-10)         |
| `blindStructure`    | `BlindLevel[]` | -             | Tournament blind levels      |
| `timeBankSeconds`   | `number`       | `30`          | Time bank per player         |
| `rakePercent`       | `number`       | `0`           | Rake percentage (0-100)      |
| `rakeCap`           | `number`       | -             | Maximum rake per pot         |
| `noFlopNoDrop`      | `boolean`      | `true`        | No rake if hand ends preflop |
| `randomProvider`    | `() => number` | `Math.random` | RNG function                 |
| `validateIntegrity` | `boolean`      | `true`        | Enable chip auditing         |
| `isClient`          | `boolean`      | `false`       | Client/optimistic mode       |

---

#### Core Methods

##### `sit(seat, id, name, stack)`

Add a player to the table.

```typescript
engine.sit(0, "user123", "Alice", 1000);
```

##### `stand(id)`

Remove a player from the table.

```typescript
engine.stand("user123");
```

##### `deal()`

Deal a new hand.

```typescript
engine.deal();
```

##### `act(action)`

Execute a game action.

```typescript
// Fold
engine.act({ type: ActionType.FOLD, playerId: "user123" });

// Check
engine.act({ type: ActionType.CHECK, playerId: "user123" });

// Call
engine.act({ type: ActionType.CALL, playerId: "user123" });

// Bet (opening bet)
engine.act({ type: ActionType.BET, playerId: "user123", amount: 100 });

// Raise
engine.act({ type: ActionType.RAISE, playerId: "user123", amount: 200 });

// Show cards at showdown
engine.act({ type: ActionType.SHOW, playerId: "user123", cardIndices: [0, 1] });

// Muck cards at showdown
engine.act({ type: ActionType.MUCK, playerId: "user123" });

// Activate time bank
engine.act({ type: ActionType.TIME_BANK, playerId: "user123" });
```

---

#### State Access

##### `state` (getter)

Get full unmasked game state.

```typescript
const state = engine.state;
console.log(state.street); // "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN"
console.log(state.actionTo); // Seat number of current actor
console.log(state.board); // Community cards ["As", "Kd", "Qh"]
console.log(state.pots); // Array of pot objects
console.log(state.winners); // null or Winner[] after showdown
```

##### `view(playerId?, version?)`

Get player-specific view with opponent cards masked.

```typescript
// Player view (sees own cards)
const aliceView = engine.view("alice");

// Spectator view (all hole cards hidden)
const spectatorView = engine.view();

// With version number for sync
const versioned = engine.view("alice", 42);
```

---

#### Validation

##### `validate(action)`

Check if action is valid without executing.

```typescript
const result = engine.validate({
  type: ActionType.BET,
  playerId: "alice",
  amount: 100,
});

if (result.valid) {
  // Action can be executed
} else {
  console.log(result.error); // "Cannot bet, there's already a bet to call"
  console.log(result.code); // "CANNOT_BET"
}
```

---

#### Serialization

##### `snapshot` (getter)

Get serializable snapshot.

```typescript
const snapshot = engine.snapshot;
localStorage.setItem("game", JSON.stringify(snapshot));
```

##### `PokerEngine.restore(snapshot)`

Restore from snapshot.

```typescript
const saved = JSON.parse(localStorage.getItem("game")!);
const engine = PokerEngine.restore(saved);
```

---

#### Event Handling

##### `on(callback)`

Subscribe to state changes.

```typescript
const unsubscribe = engine.on((action, oldState, newState) => {
  console.log(`Action: ${action.type}`);
  console.log(`Street: ${oldState.street} -> ${newState.street}`);
});

// Later: unsubscribe
unsubscribe();
```

---

#### Undo

##### `undo()`

Undo last action.

```typescript
const success = engine.undo();
if (success) {
  console.log("Action undone");
}
```

---

#### Tournament

##### `nextBlindLevel()`

Advance to next blind level.

```typescript
engine.nextBlindLevel();
console.log(engine.state.blindLevel); // 1
console.log(engine.state.bigBlind); // Updated
```

---

#### Hand History

##### `history(options?)`

Export hand history in various formats.

```typescript
// JSON format (default)
const json = engine.history();

// PokerStars format
const ps = engine.history({ format: "pokerstars" });

// Compact JSON
const compact = engine.history({ format: "compact" });
```

##### `getHandHistory()`

Get structured history object.

```typescript
const history = engine.getHandHistory();
console.log(history.handId);
console.log(history.winners);
console.log(history.streets);
```

---

#### Optimistic Updates

##### `optimisticAct(action)`

Preview action result without modifying state.

```typescript
const preview = engine.optimisticAct({
  type: ActionType.BET,
  playerId: "alice",
  amount: 100,
});

// preview contains new state
// engine.state is unchanged
```

##### `reconcile(serverState)`

Merge server state into client engine.

```typescript
// After receiving state from server
engine.reconcile(serverState);
```

---

## 💰 Money Handling

### Chip Conservation

The engine enforces strict chip conservation:

```
∑(player.stack) + ∑(pot.amount) + ∑(currentBets) + rake = constant
```

Any violation throws `CriticalStateError`.

### Side Pots

Automatic side pot calculation for all-in scenarios:

```typescript
// Example: 3 players with different stacks
// Alice: 100 (all-in)
// Bob: 300 (all-in)
// Charlie: 500 (active)

// Results in:
// Main Pot: 300 (100 × 3) - Alice, Bob, Charlie eligible
// Side Pot: 400 (200 × 2) - Bob, Charlie eligible
// Uncalled: 200 - returned to Charlie
```

### Rake

```typescript
const engine = new PokerEngine({
  smallBlind: 1,
  bigBlind: 2,
  rakePercent: 5, // 5% rake
  rakeCap: 10, // Max $10 per pot
  noFlopNoDrop: true, // No rake if ends preflop
});
```

---

## 🏆 Tournament Mode

```typescript
const tournament = new PokerEngine({
  smallBlind: 25,
  bigBlind: 50,
  ante: 5,
  maxPlayers: 9,
  initialStack: 10000,
  blindStructure: [
    { smallBlind: 25, bigBlind: 50, ante: 5 },
    { smallBlind: 50, bigBlind: 100, ante: 10 },
    { smallBlind: 75, bigBlind: 150, ante: 15 },
    { smallBlind: 100, bigBlind: 200, ante: 25 },
    { smallBlind: 150, bigBlind: 300, ante: 50 },
  ],
});

// Advance blinds (e.g., on timer)
tournament.nextBlindLevel();
```

**Tournament-specific rules:**

- Sitting-out players must post blinds/antes
- Dead button rule for empty seats
- No rake

---

## 🌐 Browser Usage

```typescript
import { createBrowserEngine } from "@pokertools/engine/browser";

// Uses Web Crypto API for secure RNG
const engine = createBrowserEngine({
  smallBlind: 1,
  bigBlind: 2,
});
```

---

## ❌ Error Handling

### Error Types

| Error                | Description                                     |
| -------------------- | ----------------------------------------------- |
| `IllegalActionError` | Invalid game action (send to client)            |
| `CriticalStateError` | Engine invariant violated (should never happen) |
| `ConfigError`        | Invalid configuration                           |

### Error Codes

```typescript
import { ErrorCodes } from "@pokertools/engine";

try {
  engine.act({ type: ActionType.CHECK, playerId: "alice" });
} catch (err) {
  if (err instanceof IllegalActionError) {
    switch (err.code) {
      case ErrorCodes.NOT_YOUR_TURN:
        showMessage("Wait for your turn");
        break;
      case ErrorCodes.CANNOT_CHECK:
        showMessage("You must call or fold");
        break;
      case ErrorCodes.BET_TOO_SMALL:
        showMessage(`Minimum bet is ${err.context.minBet}`);
        break;
    }
  }
}
```

**Available Error Codes:**

| Category | Codes                                                                 |
| -------- | --------------------------------------------------------------------- |
| Player   | `PLAYER_NOT_FOUND`, `NOT_YOUR_TURN`, `NOT_SEATED`, `NO_CHIPS`         |
| Betting  | `CANNOT_CHECK`, `NOTHING_TO_CALL`, `BET_TOO_SMALL`, `RAISE_TOO_SMALL` |
| Deal     | `CANNOT_DEAL`, `NOT_ENOUGH_PLAYERS`                                   |
| Seat     | `INVALID_SEAT`, `SEAT_OCCUPIED`, `INVALID_STACK`                      |

---

## 🎴 Action Types

```typescript
import { ActionType } from "@pokertools/engine";

enum ActionType {
  // Management
  SIT = "SIT",
  STAND = "STAND",
  ADD_CHIPS = "ADD_CHIPS",
  RESERVE_SEAT = "RESERVE_SEAT",

  // Dealing
  DEAL = "DEAL",

  // Betting
  FOLD = "FOLD",
  CHECK = "CHECK",
  CALL = "CALL",
  BET = "BET",
  RAISE = "RAISE",

  // Showdown
  SHOW = "SHOW",
  MUCK = "MUCK",

  // Special
  TIMEOUT = "TIMEOUT",
  TIME_BANK = "TIME_BANK",
  UNCALLED_BET_RETURNED = "UNCALLED_BET_RETURNED",

  // Tournament
  NEXT_BLIND_LEVEL = "NEXT_BLIND_LEVEL",
}
```

---

## 📜 Hand History Export

### JSON Format

```typescript
const history = engine.history({ format: "json" });
```

```json
{
  "handId": "hand-1734012345678-123456",
  "timestamp": 1734012345678,
  "tableName": "Table 1",
  "gameType": "Cash",
  "stakes": { "smallBlind": 1, "bigBlind": 2, "ante": 0 },
  "buttonSeat": 0,
  "players": [
    { "seat": 0, "name": "Alice", "startingStack": 200, "endingStack": 220 },
    { "seat": 1, "name": "Bob", "startingStack": 200, "endingStack": 180 }
  ],
  "streets": [
    {
      "street": "PREFLOP",
      "board": [],
      "actions": [...]
    }
  ],
  "winners": [
    { "seat": 0, "playerName": "Alice", "amount": 20, "hand": ["As", "Kd"], "handRank": "Two Pair" }
  ],
  "totalPot": 40
}
```

### PokerStars Format

```typescript
const history = engine.history({ format: "pokerstars" });
```

```
PokerStars Hand #hand-1734012345678: Hold'em No Limit ($1/$2 USD)
Table 'Table 1' 6-max Seat #1 is the button
Seat 1: Alice ($200 in chips)
Seat 2: Bob ($200 in chips)
Alice: posts small blind $1
Bob: posts big blind $2
*** HOLE CARDS ***
Dealt to Alice [As Kd]
Alice: calls $1
Bob: checks
*** FLOP *** [Qh Jc Ts]
...
```

---

## 🔧 Utilities

### View Masking

```typescript
import { createPublicView } from "@pokertools/engine";

// Create masked view for specific player
const aliceView = createPublicView(state, "alice");

// Spectator view (all cards hidden)
const spectatorView = createPublicView(state, null);
```

### Chip Auditing

```typescript
import { calculateTotalChips, auditChipConservation } from "@pokertools/engine";

// Get total chips in game
const total = calculateTotalChips(state);

// Verify chip conservation (throws on failure)
auditChipConservation(state, expectedTotal);
```

### Snapshot

```typescript
import { createSnapshot, restoreFromSnapshot } from "@pokertools/engine";

// Serialize
const snapshot = createSnapshot(state);
const json = JSON.stringify(snapshot);

// Deserialize
const restored = restoreFromSnapshot(JSON.parse(json));
```

---

## 🧪 Testing

The engine includes 349 tests across 37 suites:

| Category       | Files | Description                  |
| -------------- | ----- | ---------------------------- |
| Unit           | 26    | Individual component tests   |
| Integration    | 4     | Full game flow tests         |
| Property       | 3     | Randomized invariant testing |
| Bug Regression | 2     | Fixed bug verification       |
| Security       | 2     | Anti-cheat/exploit tests     |

```bash
npm test -w @pokertools/engine
```

---

## 📊 State Structure

```typescript
interface GameState {
  // Configuration
  config: TableConfig;
  players: (Player | null)[];
  maxPlayers: number;

  // Hand State
  handNumber: number;
  buttonSeat: number | null;
  deck: number[]; // Card codes (server only)
  board: string[]; // Community cards
  street: Street;

  // Betting
  pots: Pot[];
  currentBets: Map<number, number>;
  minRaise: number;
  lastRaiseAmount: number;
  actionTo: number | null;
  lastAggressorSeat: number | null;

  // Progress
  activePlayers: number[];
  winners: Winner[] | null;
  rakeThisHand: number;

  // Blinds
  smallBlind: number;
  bigBlind: number;
  ante: number;
  blindLevel: number;

  // Time Bank
  timeBanks: Map<number, number>;
  timeBankActiveSeat: number | null;

  // History
  actionHistory: ActionRecord[];
  previousStates: GameState[]; // For undo

  // Chip Conservation
  initialChips?: number; // Baseline for auditing (set at deal)

  // Metadata
  timestamp: number;
  handId: string;
}
```

---

## 🔗 Related Packages

| Package                               | Description        |
| ------------------------------------- | ------------------ |
| [@pokertools/types](../types)         | Type definitions   |
| [@pokertools/evaluator](../evaluator) | Hand evaluation    |
| [@pokertools/api](../api)             | REST/WebSocket API |

---

## 📄 License

MIT © A.Aurelius
