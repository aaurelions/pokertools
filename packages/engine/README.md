# @pokertools/engine

[![npm version](https://img.shields.io/npm/v/@pokertools/engine.svg)](https://www.npmjs.com/package/@pokertools/engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/github/actions/workflow/status/aaurelions/pokertools/ci.yml?branch=main)](https://github.com/aaurelions/pokertools/actions)
[![Coverage](https://img.shields.io/codecov/c/github/aaurelions/pokertools)](https://codecov.io/gh/aaurelions/pokertools)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@pokertools/engine)](https://bundlephobia.com/package/@pokertools/engine)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg)](https://www.typescriptlang.org/)

An enterprise-grade, **deterministic, immutable, and high-performance** Texas Hold'em poker engine.

Built on the **Redux design pattern**, this engine treats the poker game as a finite state machine. It accepts a `GameState` and an `Action`, and returns a new `GameState`. This architecture makes it uniquely suited for:

- **Multiplayer Servers:** Easy synchronization, crash recovery, and concurrency.
- **AI Training:** Fast simulations for Monte Carlo / Reinforcement Learning (17m hands/sec using `@pokertools/evaluator`).
- **Real Money Gaming:** Auditable RNG, integer-only arithmetic, and strict invariant checking.
- **Solvers:** Correct handling of complex side-pots, split-pots, and heads-up positioning.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Advanced Usage](#advanced-usage)
  - [Provable Fairness (Custom RNG)](#provable-fairness-custom-rng)
  - [Crash Recovery (Snapshots)](#crash-recovery-snapshots)
  - [Event Subscription & Middleware](#event-subscription--middleware)
  - [Hand History Export](#hand-history-export)
  - [Time Banks & Timeout Logic](#time-banks--timeout-logic)
  - [Undo & Rollback](#undo--rollback)
  - [Tournament Blind Schedules](#tournament-blind-schedules)
  - [Scalability & Worker Threads](#scalability--worker-threads)
- [Security & Integrity](#security--integrity)
  - [View Masking (Anti-Cheat)](#view-masking-anti-cheat)
  - [Invariant Auditing](#invariant-auditing)
  - [Integer Arithmetic](#integer-arithmetic)
- [Rule Logic & Edge Cases](#rule-logic--edge-cases)
- [API Reference](#api-reference)
- [Error Handling](#error-handling)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Pure State Machine:** Zero internal mutation. `f(state, action) => newState`.
- **Provably Fair:** Inject your own RNG (e.g., CSPRNG or hardware RNG) for completely auditable shuffling.
- **Crash Resilient:** Export lightweight JSON snapshots and restore game state instantly from a database.
- **Event Driven:** Subscribe to state changes to trigger UI sounds, animations, or analytics.
- **Complex Logic Solved:**
  - **Side Pots:** Handles multi-way all-ins with mathematically correct pot segregation using the iterative subtraction method.
  - **Split Pots:** Distributes odd chips by position (closest to left of button) or suit automatically.
  - **Heads-Up Rules:** Automatically switches Button/SB positioning logic when only 2 players remain.
- **Auto-Runout:** Automatically deals remaining streets and calculates winners when all active players are all-in.
- **Rake Support:** Configurable rake percentage and cap for cash games (tournaments automatically excluded).
- **Granular Card Visibility:** Players can selectively show cards at showdown (e.g., show only one card to prove a bluff).
- **Time Bank Support:** Native support for "Time Bank" resource management and explicit timeout resolutions.
- **Hand History:** Native export to standard PokerStars/PHH text formats for compatibility with tracking software (PokerTracker 4, HM3).
- **Strict Typing:** Written in TypeScript with exhaustive definitions for every state transition.

## Installation

```bash
# npm
npm install @pokertools/engine

# yarn
yarn add @pokertools/engine

# pnpm
pnpm add @pokertools/engine
```

## Quick Start

This example demonstrates a simple Pre-flop to Flop sequence.

```typescript
import { PokerEngine, ActionType } from "@pokertools/engine";

// 1. Setup Table
const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20 });

// 2. Event Listener (Logging)
// Subscribe before playing to capture all events
engine.on((action, oldState, newState) => {
  console.log(`[${action.type}] ${newState.street} - Pot: ${newState.pot}`);
});

// 3. Manage Players
engine.sit(0, "p1", "Alice", 1000);
engine.sit(1, "p2", "Bob", 1000);
engine.sit(2, "p3", "Tom", 100);

engine.stand("p3"); // Tom leaves
engine.sit(2, "p4", "Charlie", 500); // Charlie takes the seat

// 4. Start Hand
// Button: Alice (Seat 0), SB: Bob (Seat 1), BB: Charlie (Seat 2)
engine.deal();

// 5. Pre-Flop Action
// Action starts with Button (Alice) in 3-handed play
engine.act({ type: ActionType.FOLD, playerId: "p1" }); // Alice folds
engine.act({ type: ActionType.CALL, playerId: "p2" }); // Bob completes SB to 20 (posts 10 more)
engine.act({ type: ActionType.CHECK, playerId: "p4" }); // Charlie checks option (already posted BB)

// 6. Flop Action (Pot: 40)
// Engine auto-deals Flop. Bob acts first (first active player left of button).
engine.act({ type: ActionType.CHECK, playerId: "p2" });
engine.act({ type: ActionType.BET, playerId: "p4", amount: 40 }); // Charlie bets 40
engine.act({ type: ActionType.CALL, playerId: "p2" }); // Bob calls 40

// 7. Inspect Data
// Global state (Admin/Server only - reveals all cards)
const globalState = engine.state;

// Player view (Safe for Client - masks opponents' cards)
const bobView = engine.view("p2");

console.log(`Board: ${globalState.board}`); // e.g., ["As", "Kd", "2c"]
console.log(`Bob's Hand: ${bobView.players[1].hand}`); // e.g., ["Ah", "Kh"]
console.log(`Charlie's Hand: ${bobView.players[2].hand ?? "Hidden"}`); // "Hidden" (masked)
```

### Configuration Examples

#### Cash Game with Rake

```typescript
const cashEngine = new PokerEngine({
  smallBlind: 5,
  bigBlind: 10,
  rakePercent: 5, // 5% rake
  rakeCap: 10, // Max 10 chips per pot
});

// After showdown
console.log(cashEngine.state.rakeThisHand); // e.g., 5 (rake collected)
// Chip conservation automatically accounts for rake
```

#### Tournament (No Rake)

```typescript
const tournamentEngine = new PokerEngine({
  smallBlind: 25,
  bigBlind: 50,
  ante: 5,
  blindStructure: [
    { smallBlind: 25, bigBlind: 50, ante: 5 },
    { smallBlind: 50, bigBlind: 100, ante: 10 },
    { smallBlind: 100, bigBlind: 200, ante: 25 },
  ],
});

// Rake is automatically disabled for tournaments
console.log(tournamentEngine.state.rakeThisHand); // Always 0
```

## Architecture

Unlike traditional object-oriented poker engines where `player.bet()` mutates the player object in place, `@pokertools/engine` uses a **Reducer Pattern**.

```typescript
function gameReducer(state: GameState, action: Action): GameState;
```

This design enables:

1. **Time Travel:** You can save an array of `Action` objects and replay an entire hand perfectly to debug issues.
2. **Concurrency:** Since the state is immutable, you can safely read the state in one thread (e.g., sending updates to clients) while calculating the next state in another.
3. **Testability:** Testing becomes a matter of input vs. output, without complex setup/teardown of class instances.

## Project Structure

The recommended file structure for this library follows separation-of-concerns principles:

```
@pokertools/engine/
.
├── LICENSE
├── README.md
├── jest.config.js
├── package.json
├── src
│   ├── actions
│   │   ├── betting.ts
│   │   ├── dealing.ts
│   │   ├── management.ts
│   │   ├── showdownActions.ts
│   │   ├── special.ts
│   │   ├── streetProgression.ts
│   │   ├── tournament.ts
│   │   └── validation.ts
│   ├── engine
│   │   ├── PokerEngine.ts
│   │   └── gameReducer.ts
│   ├── errors
│   │   ├── ConfigError.ts
│   │   ├── CriticalStateError.ts
│   │   ├── ErrorCodes.ts
│   │   ├── IllegalActionError.ts
│   │   ├── PokerEngineError.ts
│   │   └── index.ts
│   ├── history
│   │   ├── exporter.ts
│   │   ├── formats
│   │   │   ├── json.ts
│   │   │   └── pokerstars.ts
│   │   ├── handHistoryBuilder.ts
│   │   └── types.ts
│   ├── index.ts
│   ├── rules
│   │   ├── actionOrder.ts
│   │   ├── blinds.ts
│   │   ├── headsUp.ts
│   │   ├── showdown.ts
│   │   └── sidePots.ts
│   └── utils
│       ├── cardUtils.ts
│       ├── constants.ts
│       ├── deck.ts
│       ├── invariants.ts
│       ├── positioning.ts
│       ├── rake.ts
│       ├── serialization.ts
│       ├── validation.ts
│       └── viewMasking.ts
├── tests
│   ├── bugs
│   ├── debug
│   ├── integration
│   ├── property
│   ├── security
│   └── unit
└── tsconfig.json
```

## Advanced Usage

### Provable Fairness (Custom RNG)

By default, the engine uses `Math.random()`. For real-money gaming, tournaments, or replayable simulations, you **must** inject a seeded or crypto-secure generator. This allows you to prove to players that the deck was shuffled fairly.

```typescript
import seedrandom from "seedrandom";

// Create a seeded generator (or use a Crypto API)
const rng = seedrandom("championship-final-table-seed-12345");

const engine = new PokerEngine({
  smallBlind: 10,
  bigBlind: 20,
  // The engine will use this function for all shuffling and random decisions
  randomProvider: () => rng.quick(),
});
```

### Crash Recovery (Snapshots)

Because the state is immutable and serializable, you can save the game state to a persistent store (Redis, Postgres, File System) after every move. If your Node.js process crashes, you can restore the table instantly.

```typescript
// --- 1. SAVING ---
// Get a lightweight, serializable JSON object
const snapshot = engine.snapshot;
// Save to database (e.g., Redis key "table:101")
await db.save("table:101", JSON.stringify(snapshot));

// ... Server Crashes or Restarts ...

// --- 2. RESTORING ---
const savedJson = await db.get("table:101");
const snapshot = JSON.parse(savedJson);

// Create a new engine instance pre-loaded with the exact previous state
const engine = PokerEngine.restore(snapshot);

// Resume play immediately - players won't even notice the restart
console.log(engine.state.actionTo);
```

### Event Subscription & Middleware

Since the engine is pure, you need a way to know "What just happened?" to trigger side effects like playing sounds, updating the UI, or logging to an analytics server.

The engine provides a subscription model that receives the `Action`, the `OldState`, and the `NewState`.

```typescript
engine.on((action, oldState, newState) => {
  // 1. Detect Phase Changes (e.g., Preflop -> Flop)
  if (newState.street !== oldState.street) {
    console.log(`[EVENT] Dealing ${newState.street}: ${newState.board}`);
    socket.emit("playSound", "deal_cards");
  }

  // 2. Detect Player Actions
  if (action.type === ActionType.FOLD) {
    console.log(`[EVENT] Player ${action.playerId} folded.`);
    socket.emit("animation", { type: "fold", seat: action.playerId });
  }

  // 3. Detect Winners
  if (newState.winners && !oldState.winners) {
    console.log(`[EVENT] Winners:`, newState.winners);
    // Trigger chip gathering animation
  }
});
```

### Hand History Export

Serious players require Hand Histories to analyze their gameplay in tools like **PokerTracker 4**, **Holdem Manager 3**, or **GTO Wizard**. The engine can export the current hand in a standardized text format.

```typescript
// Call this at the end of a hand (Street = SHOWDOWN)
const historyText = engine.history();

console.log(historyText);

/* Output Example:
PokerStars Hand #23948239048: Hold'em No Limit ($10/$20 USD) - YYYY/MM/DD
Table 'Alpha' 6-max Seat #1 is the button
Seat 1: Alice ($1000 in chips) 
Seat 2: Bob ($1000 in chips) 
Bob: posts small blind $10
Alice: posts big blind $20
*** HOLE CARDS ***
Dealt to Bob [Ah Kh]
Bob: raises $40 to $60
...
*/
```

### Time Banks & Timeout Logic

The engine follows a strict separation of concerns:

- **The Server** manages the clock (Real-time).
- **The Engine** manages the Time Bank (Resource).

The engine does not include a `setTimeout`. Instead, you dispatch explicit actions when the server determines time has expired.

```typescript
// Scenario: Server timer hits 0.0s for Player P1

// 1. Check if player has Time Bank remaining
if (engine.canUseTimeBank("p1")) {
  // Auto-activate time bank: Deducts time tokens and keeps action on P1
  engine.act({ type: ActionType.TIME_BANK, playerId: "p1" });
  console.log("Time Bank activated!");
} else {
  // 2. No time left: Force a Fold (or Check if allowed)
  // This action will also mark the player as "Sitting Out"
  engine.act({ type: ActionType.TIMEOUT, playerId: "p1" });
  console.log("Player timed out and folded.");
}
```

### Undo & Rollback

Essential for admin tools, friendly games, or correcting misclicks. Since the engine uses a persistent data structure, rolling back to a previous state is computationally cheap and instant.

```typescript
// 1. Player misclicks Fold
engine.act({ type: ActionType.FOLD, playerId: "p1" });

// 2. Admin intervenes
engine.undo();

// 3. State is now exactly as it was before the fold
// The actionTo pointer is back on p1
```

### Tournament Blind Schedules

For tournaments, you can define a blind structure. The engine does not auto-increment automatically (as that is often time-based), but provides a simple API to advance levels.

```typescript
const engine = new PokerEngine({
  initialStack: 1500,
  blindStructure: [
    { smallBlind: 10, bigBlind: 20, ante: 0 }, // Level 1
    { smallBlind: 20, bigBlind: 40, ante: 0 }, // Level 2
    { smallBlind: 50, bigBlind: 100, ante: 10 }, // Level 3
  ],
});

// ... Play some hands ...

// Advance to Level 2
engine.nextBlindLevel();
console.log(engine.blinds); // { smallBlind: 20, bigBlind: 40 }
```

### Scalability & Worker Threads

For high-volume applications (e.g., 10,000 concurrent tables), running poker logic on the main Node.js event loop can block I/O. Because the engine is state-in/state-out, it is trivial to offload to **Worker Threads**.

```typescript
// worker.ts
import { parentPort } from "worker_threads";
import { PokerEngine } from "@pokertools/engine";

parentPort?.on("message", (msg) => {
  if (msg.type === "PROCESS_ACTION") {
    // 1. Rehydrate engine from snapshot
    const engine = PokerEngine.restore(msg.snapshot);
    // 2. Run logic
    const newState = engine.act(msg.action);
    // 3. Send result back to Main Thread
    parentPort?.postMessage({ status: "success", state: newState });
  }
});
```

## Security & Integrity

### View Masking (Anti-Cheat)

**Critical:** Never send the full `GameState` result from `state` to a client. It contains the Deck and Opponent Hole Cards.

Use the built-in view generator to create a sanitized version for specific players.

```typescript
// Server Code
const globalState = engine.state;

// Send to Alice (Seat 1)
// - Hides Bob's cards
// - Hides the Deck
// - Respects shownCards for granular visibility
const aliceView = engine.view("p1");
socket.to("p1").emit("gameState", aliceView);

// Send to Bob (Seat 2)
const bobView = engine.view("p2");
socket.to("p2").emit("gameState", bobView);
```

#### Granular Card Visibility (New Feature)

At showdown, players can control which cards are revealed using the `shownCards` field:

```typescript
// Player state after showdown
player.hand = ["As", "Kd"]; // Actual cards (always preserved)
player.shownCards = [0, 1]; // Both cards shown (winner)

// Or for selective showing
player.shownCards = [0]; // Only left card shown
player.shownCards = null; // Mucked (no cards shown)

// Public view respects shownCards and preserves positional context:
// - shownCards: [0, 1] → hand: ["As", "Kd"]  (both visible)
// - shownCards: [0]    → hand: ["As", null]  (left visible, right hidden)
// - shownCards: [1]    → hand: [null, "Kd"]  (left hidden, right visible)
// - shownCards: null   → hand: null          (completely mucked)
```

**Important:** The view masking preserves positional context by using `null` for hidden cards. This ensures clients know which card is being shown (left vs right).

#### Optional Show Actions

Players can reveal their cards after showdown:

```typescript
// Loser reveals both cards to show a bluff
engine.act({
  type: ActionType.SHOW,
  playerId: "loser123",
  // cardIndices optional - defaults to all cards [0, 1]
});

// Or show only specific cards
engine.act({
  type: ActionType.SHOW,
  playerId: "player456",
  cardIndices: [0], // Show only left card
});

// Winner can also explicitly show (already shown by default)
engine.act({
  type: ActionType.SHOW,
  playerId: "winner789",
});
```

### Invariant Auditing

The engine implements strict accounting logic. After every single action, it runs an internal audit to ensure **Conservation of Chips**.

$$\sum(\text{PlayerStacks}) + \sum(\text{Pots}) + \sum(\text{CurrentBets}) = \text{InitialChips}$$

If a logic bug ever causes a chip to duplicate or vanish, the engine throws a `CriticalStateError`.

**Recommendation:** Wrap your `act` calls in a try/catch. If this error occurs, **freeze the table** immediately. It indicates a serious data integrity issue.

### Integer Arithmetic

To ensure financial accuracy, the engine strictly forbids floating-point numbers.

- **Input:** All stacks, bets, and blinds must be Integers (representing cents or the smallest chip unit).
- **Internal:** Pot divisions use integer division with deterministic remainder distribution (by position).
- **Safety:** This prevents "Penny Drift" exploits common in JavaScript floating-point math.

## Rule Logic & Edge Cases

This engine isn't just a loop; it is a strict implementation of standard TDA (Tournament Directors Association) rules.

### 1. Heads-Up Positioning

In a standard game (3+ players), the Small Blind is to the left of the Button.

- **The Trap:** In Heads-Up (2 players), the **Button IS the Small Blind**.
- **The Rule:** The Button acts **first** Pre-Flop, and acts **last** Post-Flop.
- **Implementation:** The engine detects when exactly 2 players are active (not folded/busted) and automatically swaps the blind posting order and action order to comply with this rule.

### 2. The "Incomplete Raise"

- **Scenario:** Player A bets 100. Player B is All-In for 120 (Raise of 20). Min raise is 100.
- **The Rule:** Since the raise (20) is less than 50% (or 100% depending on ruleset) of the min-raise, the betting is **NOT** re-opened for Player A. Player A can only CALL or FOLD. They cannot re-raise.
- **Implementation:** The engine tracks `legalActions` and will throw `ILLEGAL_ACTION` if Player A attempts to raise in this spot.

### 3. Split Pot "Odd Chip" Resolution

In split pots (e.g., High-Low or Tie), chip counts often result in decimals (e.g., 25 chips / 2 players = 12.5).

- **The Rule:** The odd chip goes to the player in the **worst position** (closest to the left of the button). In High-Low games, the odd chip goes to the High hand.
- **Implementation:** The engine resolves this deterministically using seat indexes relative to the dealer button.

### 4. Side Pots (Iterative Subtraction)

The engine handles complex multi-way all-ins.

- **Scenario:** A (100 chips), B (500 chips), C (1000 chips) all go All-In.
- **Pot 1 (Main):** 300 chips (100 each from A, B, C). A, B, and C contest this.
- **Pot 2 (Side):** 800 chips (400 each from B and C). Only B and C contest this.
- **Remaining:** C's extra 500 chips are returned (no one to match).
- **Resolution:** The engine evaluates hands for Pot 2 first, awards it, then evaluates Pot 1.

## API Reference

### `PokerEngine` Class

| Method        | Arguments               | Returns       | Description                                        |
| ------------- | ----------------------- | ------------- | -------------------------------------------------- |
| `constructor` | `config`                | `PokerEngine` | Creates a new table instance.                      |
| `sit`         | `seat, id, name, stack` | `void`        | Adds a player to a specific seat.                  |
| `stand`       | `id`                    | `void`        | Removes a player.                                  |
| `deal`        | `none`                  | `void`        | Starts the hand (Shuffles/Posts Blinds).           |
| `act`         | `action`                | `GameState`   | Executes a move.                                   |
| `undo`        | `none`                  | `boolean`     | Reverts state to previous step.                    |
| `state`       | _(Getter)_              | `GameState`   | The full, internal, unmasked state.                |
| `view`        | `id?`                   | `PublicState` | Masked state for a player (or spectator if no ID). |
| `snapshot`    | _(Getter)_              | `object`      | Serializable JSON for database storage.            |
| `restore`     | `snapshot`              | `PokerEngine` | **Static.** Recreates engine from backup.          |
| `history`     | `none`                  | `string`      | Generates the text log (PHH/PokerStars).           |
| `on`          | `fn(act, old, new)`     | `unsub`       | Subscribe to state changes.                        |

### `Action` Types

```typescript
interface Action {
  type: ActionType;
  playerId: string;
  amount?: number; // Required for BET and RAISE
}

enum ActionType {
  FOLD = "FOLD",
  CHECK = "CHECK",
  CALL = "CALL",
  BET = "BET", // Opening a bet
  RAISE = "RAISE", // Increasing an existing bet
  TIMEOUT = "TIMEOUT",
  TIME_BANK = "TIME_BANK", // Extends turn using time bank
}
```

## Error Handling

The engine throws typed errors. You should wrap `act` calls in a `try/catch` block.

| Error Code                   | Description                        | Recommended Action                   |
| ---------------------------- | ---------------------------------- | ------------------------------------ |
| `CRITICAL_INVARIANT_FAILURE` | Chips disappeared/duplicated.      | **FREEZE GAME**. Contact Support.    |
| `NOT_YOUR_TURN`              | Player acted out of order.         | Ignore or warn client.               |
| `INVALID_AMOUNT`             | Bet is below min-raise or > stack. | Reject action, ask for valid amount. |
| `ILLEGAL_ACTION`             | Tried to Check when facing a bet.  | Reject action.                       |
| `STALE_STATE`                | Optimistic UI mismatch.            | Send fresh `view()` to client.       |

## Contributing

This project is part of the `@pokertools` monorepo.

1. Clone the repository.
2. Run `npm install`.
3. Run `npm test`.

**Note:** The test suite includes over 500 edge-case scenarios including split pots, kickers, and side-pot math. Please ensure all pass before submitting a PR.

## License

MIT
