# 🃏 @pokertools/types

> **TypeScript type definitions and Zod schemas for the PokerTools ecosystem**

[![npm version](https://img.shields.io/npm/v/@pokertools/types.svg)](https://www.npmjs.com/package/@pokertools/types)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

This package provides the **single source of truth** for all type definitions used across the PokerTools monorepo. It includes TypeScript interfaces, enums, and Zod validation schemas that ensure type safety from the game engine to the API to the client SDK.

---

## 📦 Installation

```bash
npm install @pokertools/types
```

```bash
yarn add @pokertools/types
```

```bash
pnpm add @pokertools/types
```

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        @pokertools/types                                    │
│                     Single Source of Truth                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    Engine     │         │      API      │         │  Client SDK   │
│ @pokertools/  │         │ @pokertools/  │         │   Frontend    │
│    engine     │         │     api       │         │  Application  │
└───────────────┘         └───────────────┘         └───────────────┘
        │                         │                         │
        └─────────────────────────┴─────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │    Shared Contracts       │
                    │  • Type Safety            │
                    │  • Runtime Validation     │
                    │  • Consistent Behavior    │
                    └───────────────────────────┘
```

---

## 📚 Type Categories

| Category          | Description               | Files                             |
| ----------------- | ------------------------- | --------------------------------- |
| 🎮 **Game State** | Core game state types     | `GameState.ts`, `PublicState.ts`  |
| 👤 **Player**     | Player model and status   | `Player.ts`                       |
| 🎯 **Actions**    | All game actions          | `Action.ts`, `ActionWhitelist.ts` |
| 💰 **Pot**        | Pot management            | `Pot.ts`                          |
| ⚙️ **Config**     | Table configuration       | `Config.ts`                       |
| 📜 **History**    | Hand history records      | `HandHistory.ts`                  |
| 🔌 **WebSocket**  | Real-time protocol        | `WebSocketMessages.ts`            |
| ❌ **Errors**     | Error codes and responses | `ErrorCodes.ts`                   |
| ✅ **Schemas**    | Zod validation schemas    | `schemas.ts`                      |
| 🌐 **API**        | REST API DTOs             | `api/*.ts`                        |

---

## 🎮 Game State Types

### GameState

The central immutable game state containing all information about the current hand.

```typescript
import { GameState, Street, Winner } from "@pokertools/types";

// GameState structure
interface GameState {
  // Table Configuration
  config: TableConfig;
  players: ReadonlyArray<Player | null>; // Indexed by seat (0-9)
  maxPlayers: number;

  // Hand State
  handNumber: number;
  buttonSeat: number | null;
  deck: readonly number[]; // Remaining cards (integer codes)
  board: readonly string[]; // Community cards ["As", "Kd", ...]
  street: Street;

  // Betting State
  pots: readonly Pot[];
  currentBets: ReadonlyMap<number, number>; // Seat -> bet amount
  minRaise: number;
  lastRaiseAmount: number;
  actionTo: number | null; // Current actor's seat
  lastAggressorSeat: number | null;

  // Hand Progress
  activePlayers: readonly number[]; // Non-folded seats
  winners: readonly Winner[] | null;
  rakeThisHand: number;

  // Blind Tracking
  smallBlind: number;
  bigBlind: number;
  ante: number;
  blindLevel: number; // Tournament level index

  // Time Bank
  timeBanks: ReadonlyMap<number, number>;
  timeBankActiveSeat: number | null;

  // History
  actionHistory: readonly ActionRecord[];
  previousStates: readonly GameState[];

  // Metadata
  timestamp: number;
  handId: string;
}
```

### Street Enum

```typescript
import { Street } from "@pokertools/types";

const enum Street {
  PREFLOP = "PREFLOP",
  FLOP = "FLOP",
  TURN = "TURN",
  RIVER = "RIVER",
  SHOWDOWN = "SHOWDOWN",
}

// Usage
if (state.street === Street.FLOP) {
  console.log("Flop cards:", state.board.slice(0, 3));
}
```

### Winner Type

```typescript
import { Winner } from "@pokertools/types";

interface Winner {
  seat: number;
  amount: number;
  hand: readonly string[] | null; // Best 5 cards or null if uncontested
  handRank: string | null; // "Full House, Aces full of Kings"
}
```

### PublicState

Sanitized game state for client consumption with hidden information masked.

```typescript
import { PublicState, PublicPlayer } from "@pokertools/types";

interface PublicState extends Omit<GameState, "deck" | "players"> {
  deck: readonly number[]; // Always empty
  players: ReadonlyArray<PublicPlayer | null>;
  viewingPlayerId: string | null; // null = spectator
  version: number; // For state sync
}

// PublicPlayer has masked cards
interface PublicPlayer extends Omit<Player, "hand"> {
  hand: ReadonlyArray<string | null> | null;
  // Examples:
  // ["As", "Kd"] - both visible
  // [null, null] - both hidden
  // ["As", null] - left card visible only
  // null - no cards (mucked/folded)
}
```

---

## 👤 Player Types

### Player Interface

```typescript
import { Player, PlayerStatus, SitInOption } from "@pokertools/types";

interface Player {
  id: string; // Unique player ID
  name: string; // Display name
  seat: number; // 0-9 seat index
  stack: number; // Current chips (integer)
  hand: ReadonlyArray<string | null> | null; // Hole cards
  shownCards: readonly number[] | null; // Indices shown at showdown
  status: PlayerStatus;
  betThisStreet: number;
  totalInvestedThisHand: number;
  isSittingOut: boolean;
  timeBank: number; // Seconds remaining
  pendingAddOn: number; // Chips waiting for next hand
  sitInOption: SitInOption;
  reservationExpiry: number | null;
}
```

### PlayerStatus Enum

```typescript
import { PlayerStatus } from "@pokertools/types";

const enum PlayerStatus {
  ACTIVE = "ACTIVE", // In hand, can act
  FOLDED = "FOLDED", // Folded this hand
  ALL_IN = "ALL_IN", // No chips left to bet
  SITTING_OUT = "SITTING_OUT", // Not playing
  WAITING = "WAITING", // At table, not in hand yet
  BUSTED = "BUSTED", // Stack = 0
  RESERVED = "RESERVED", // Seat reserved, awaiting payment
}

// Status flow diagram:
//
// RESERVED ──► WAITING ──► ACTIVE ──┬──► FOLDED
//                  ▲                │
//                  │                ├──► ALL_IN
//                  │                │
//                  └────────────────┴──► BUSTED
//                                   │
//                                   └──► SITTING_OUT
```

### SitInOption Enum

```typescript
import { SitInOption } from "@pokertools/types";

const enum SitInOption {
  IMMEDIATE = "IMMEDIATE", // Sit in right away
  WAIT_FOR_BB = "WAIT_FOR_BB", // Wait for big blind position
}

// Usage in cash games
const sitAction: SitAction = {
  type: ActionType.SIT,
  playerId: "user123",
  playerName: "Alice",
  seat: 3,
  stack: 1000,
  sitInOption: SitInOption.WAIT_FOR_BB,
};
```

---

## 🎯 Action Types

### ActionType Enum

```typescript
import { ActionType } from "@pokertools/types";

const enum ActionType {
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

### Action Interfaces

```typescript
import {
  Action,
  SitAction,
  StandAction,
  DealAction,
  FoldAction,
  CheckAction,
  CallAction,
  BetAction,
  RaiseAction,
  ShowAction,
  MuckAction,
  AddChipsAction,
  ReserveSeatAction,
  TimeoutAction,
  TimeBankAction,
  UncalledBetReturnedAction,
  NextBlindLevelAction,
} from "@pokertools/types";

// SIT - Join a table
const sit: SitAction = {
  type: ActionType.SIT,
  playerId: "user123",
  playerName: "Alice",
  seat: 0,
  stack: 1000,
  sitInOption: SitInOption.IMMEDIATE, // optional
};

// STAND - Leave table
const stand: StandAction = {
  type: ActionType.STAND,
  playerId: "user123",
};

// DEAL - Start new hand
const deal: DealAction = {
  type: ActionType.DEAL,
};

// FOLD - Forfeit hand
const fold: FoldAction = {
  type: ActionType.FOLD,
  playerId: "user123",
};

// CHECK - Pass (no bet to call)
const check: CheckAction = {
  type: ActionType.CHECK,
  playerId: "user123",
};

// CALL - Match current bet
const call: CallAction = {
  type: ActionType.CALL,
  playerId: "user123",
  amount: 50, // optional, for history tracking
};

// BET - Opening bet
const bet: BetAction = {
  type: ActionType.BET,
  playerId: "user123",
  amount: 100, // Total bet size
};

// RAISE - Raise existing bet
const raise: RaiseAction = {
  type: ActionType.RAISE,
  playerId: "user123",
  amount: 300, // Total raise amount
};

// SHOW - Show cards at showdown
const show: ShowAction = {
  type: ActionType.SHOW,
  playerId: "user123",
  cardIndices: [0, 1], // optional: [0], [1], [0,1], or omit for all
};

// MUCK - Hide cards at showdown
const muck: MuckAction = {
  type: ActionType.MUCK,
  playerId: "user123",
};

// ADD_CHIPS - Rebuy/top-up (applied next hand)
const addChips: AddChipsAction = {
  type: ActionType.ADD_CHIPS,
  playerId: "user123",
  amount: 500,
};

// RESERVE_SEAT - Lock seat while processing payment
const reserve: ReserveSeatAction = {
  type: ActionType.RESERVE_SEAT,
  playerId: "user123",
  playerName: "Alice",
  seat: 0,
  expiryTimestamp: Date.now() + 30000, // 30 seconds
};

// TIMEOUT - Player ran out of time
const timeout: TimeoutAction = {
  type: ActionType.TIMEOUT,
  playerId: "user123",
  timestamp: Date.now(), // optional
};

// TIME_BANK - Activate time bank
const timeBank: TimeBankAction = {
  type: ActionType.TIME_BANK,
  playerId: "user123",
};

// UNCALLED_BET_RETURNED - Internal engine action
const uncalled: UncalledBetReturnedAction = {
  type: ActionType.UNCALLED_BET_RETURNED,
  playerId: "user123",
  amount: 50,
};

// NEXT_BLIND_LEVEL - Tournament blind increase
const nextLevel: NextBlindLevelAction = {
  type: ActionType.NEXT_BLIND_LEVEL,
};
```

### Action Union Type

```typescript
import { Action } from "@pokertools/types";

// Action is a discriminated union of all action types
type Action =
  | SitAction
  | StandAction
  | AddChipsAction
  | ReserveSeatAction
  | DealAction
  | FoldAction
  | CheckAction
  | CallAction
  | BetAction
  | RaiseAction
  | ShowAction
  | MuckAction
  | TimeoutAction
  | TimeBankAction
  | UncalledBetReturnedAction
  | NextBlindLevelAction;

// Type narrowing with discriminated unions
function handleAction(action: Action): void {
  switch (action.type) {
    case ActionType.BET:
      console.log(`Bet: ${action.amount}`);
      break;
    case ActionType.RAISE:
      console.log(`Raise to: ${action.amount}`);
      break;
    case ActionType.FOLD:
      console.log(`${action.playerId} folded`);
      break;
    // ... handle other actions
  }
}
```

### Action Whitelist

```typescript
import { ALLOWED_GAMEPLAY_ACTIONS, isAllowedGameplayAction } from "@pokertools/types";

// Actions allowed through the API gameplay endpoint
// Management actions (SIT, ADD_CHIPS, RESERVE_SEAT) require dedicated endpoints
const ALLOWED_GAMEPLAY_ACTIONS: readonly ActionType[] = [
  ActionType.DEAL,
  ActionType.CHECK,
  ActionType.CALL,
  ActionType.RAISE,
  ActionType.BET,
  ActionType.FOLD,
  ActionType.SHOW,
  ActionType.MUCK,
  ActionType.TIME_BANK,
  ActionType.STAND,
  ActionType.NEXT_BLIND_LEVEL,
];

// Type guard
if (isAllowedGameplayAction(action.type)) {
  // Safe to process through gameplay endpoint
}
```

### ActionRecord

```typescript
import { ActionRecord } from "@pokertools/types";

interface ActionRecord {
  action: Action;
  seat: number | null; // null for table-level actions
  resultingPot: number;
  resultingStack: number;
  street?: string;
}
```

---

## 💰 Pot Types

```typescript
import { Pot, PotType } from "@pokertools/types";

type PotType = "MAIN" | "SIDE";

interface Pot {
  amount: number; // Total chips
  eligibleSeats: readonly number[]; // Who can win
  type: PotType;
  capPerPlayer: number; // Max contribution
}

// Pot diagram for side pots:
//
// Player A: 100 chips (all-in)
// Player B: 300 chips (all-in)
// Player C: 500 chips (active)
//
// ┌─────────────────────────────────────────┐
// │ MAIN POT: 300 (100 × 3)                 │
// │ Eligible: [A, B, C]                     │
// ├─────────────────────────────────────────┤
// │ SIDE POT 1: 400 (200 × 2)               │
// │ Eligible: [B, C]                        │
// ├─────────────────────────────────────────┤
// │ SIDE POT 2: 200 (uncalled portion)      │
// │ Returned to: C                          │
// └─────────────────────────────────────────┘
```

---

## ⚙️ Configuration Types

### TableConfig

```typescript
import { TableConfig, BlindLevel } from "@pokertools/types";

interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  ante?: number; // Default: 0
  maxPlayers?: number; // 2-10, default: 9
  initialStack?: number; // Tournament starting stack
  blindStructure?: readonly BlindLevel[]; // Tournament schedule
  timeBankSeconds?: number; // Default: 30
  timeBankDeductionSeconds?: number; // Default: 10
  randomProvider?: () => number; // Default: Math.random
  rakePercent?: number; // 0-100, cash games
  rakeCap?: number; // Max rake per pot
  noFlopNoDrop?: boolean; // No rake if ends preflop, default: true
  validateIntegrity?: boolean; // Chip conservation checks, default: true
  isClient?: boolean; // Client mode (masked cards)
}

interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  ante: number;
}

// Example: Cash game config
const cashConfig: TableConfig = {
  smallBlind: 1,
  bigBlind: 2,
  maxPlayers: 9,
  rakePercent: 5,
  rakeCap: 10,
};

// Example: Tournament config
const tournamentConfig: TableConfig = {
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
  ],
};
```

---

## 📜 Hand History Types

```typescript
import {
  HandHistory,
  HandHistoryPlayer,
  StreetHistory,
  HandHistoryActionRecord,
  WinnerRecord,
  ExportOptions,
} from "@pokertools/types";

interface HandHistory {
  handId: string;
  timestamp: number;
  tableName: string;
  gameType: "Cash" | "Tournament";
  stakes: {
    smallBlind: number;
    bigBlind: number;
    ante: number;
  };
  maxPlayers: number;
  buttonSeat: number;
  players: readonly HandHistoryPlayer[];
  streets: readonly StreetHistory[];
  winners: readonly WinnerRecord[];
  totalPot: number;
}

interface HandHistoryPlayer {
  seat: number;
  name: string;
  startingStack: number;
  endingStack: number;
  cards?: readonly string[]; // If shown
}

interface StreetHistory {
  street: Street;
  board: readonly string[];
  actions: readonly HandHistoryActionRecord[];
  pot: number;
}

interface HandHistoryActionRecord {
  seat: number;
  playerName: string;
  action: Action;
  amount?: number;
  isAllIn?: boolean;
  timestamp: number;
}

interface WinnerRecord {
  seat: number;
  playerName: string;
  amount: number;
  hand?: readonly string[];
  handRank?: string;
}

interface ExportOptions {
  format: "pokerstars" | "json" | "compact";
  includeHoleCards?: boolean;
  timezone?: string;
}
```

---

## 🔌 WebSocket Protocol

### Client → Server Messages

```typescript
import { ClientMessage, JoinTableMessage, LeaveTableMessage, PingMessage } from "@pokertools/types";

// JOIN - Subscribe to table updates
const join: JoinTableMessage = {
  type: "JOIN",
  tableId: "table123",
  requestId: "req-001", // optional correlation ID
};

// LEAVE - Unsubscribe from table
const leave: LeaveTableMessage = {
  type: "LEAVE",
  tableId: "table123",
  requestId: "req-002",
};

// PING - Application-level heartbeat
const ping: PingMessage = {
  type: "PING",
  requestId: "ping-001",
  timestamp: Date.now(), // optional
};

// Union type
type ClientMessage = JoinTableMessage | LeaveTableMessage | PingMessage;
```

### Server → Client Messages

```typescript
import {
  ServerMessage,
  SnapshotMessage,
  StateUpdateMessage,
  ErrorMessage,
  AckMessage,
  PongMessage,
  ActionNotificationMessage,
} from "@pokertools/types";

// SNAPSHOT - Full state when joining
const snapshot: SnapshotMessage = {
  type: "SNAPSHOT",
  tableId: "table123",
  state: publicState, // PublicState
  timestamp: Date.now(),
};

// STATE_UPDATE - Lightweight change notification
const update: StateUpdateMessage = {
  type: "STATE_UPDATE",
  tableId: "table123",
  version: 42,
  timestamp: Date.now(),
};

// ERROR - Error response
const error: ErrorMessage = {
  type: "ERROR",
  code: "INVALID_ACTION",
  message: "Cannot check when there's a bet to call",
  requestId: "req-001",
  context: { currentBet: 100 },
};

// ACK - Success acknowledgment
const ack: AckMessage = {
  type: "ACK",
  requestId: "req-001",
  message: "Joined table successfully",
};

// PONG - Response to PING
const pong: PongMessage = {
  type: "PONG",
  requestId: "ping-001",
  timestamp: Date.now(),
};

// ACTION - Player action notification (for UX)
const actionNotif: ActionNotificationMessage = {
  type: "ACTION",
  tableId: "table123",
  playerId: "user123",
  actionType: "RAISE",
  amount: 300,
  timestamp: Date.now(),
};
```

### Type Guards

```typescript
import {
  isClientMessage,
  isJoinMessage,
  isLeaveMessage,
  isPingMessage,
  isServerMessage,
} from "@pokertools/types";

// Usage
function handleMessage(data: unknown): void {
  if (isClientMessage(data)) {
    if (isJoinMessage(data)) {
      subscribeToTable(data.tableId);
    } else if (isLeaveMessage(data)) {
      unsubscribeFromTable(data.tableId);
    } else if (isPingMessage(data)) {
      sendPong(data.requestId);
    }
  }
}
```

### Zod Schemas for Runtime Validation

```typescript
import { ClientMessageSchema, parseClientMessage, safeParseClientMessage } from "@pokertools/types";

// Throws on invalid input
const message = parseClientMessage(jsonData);

// Returns result object
const result = safeParseClientMessage(jsonData);
if (result.success) {
  handleMessage(result.data);
} else {
  console.error("Invalid message:", result.error);
}
```

---

## ❌ Error Codes

### ErrorCodes Object

```typescript
import { ErrorCodes, ErrorCode } from "@pokertools/types";

const ErrorCodes = {
  // Generic
  INVALID_ACTION: "INVALID_ACTION",

  // Player errors
  PLAYER_NOT_FOUND: "PLAYER_NOT_FOUND",
  PLAYER_NOT_ACTIVE: "PLAYER_NOT_ACTIVE",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  NO_CHIPS: "NO_CHIPS",
  NOT_SEATED: "NOT_SEATED",

  // Betting errors
  CANNOT_CHECK: "CANNOT_CHECK",
  NOTHING_TO_CALL: "NOTHING_TO_CALL",
  CANNOT_BET: "CANNOT_BET",
  BET_TOO_SMALL: "BET_TOO_SMALL",
  CANNOT_RAISE: "CANNOT_RAISE",
  CANNOT_RERAISE: "CANNOT_RERAISE",
  RAISE_TOO_SMALL: "RAISE_TOO_SMALL",

  // Deal errors
  CANNOT_DEAL: "CANNOT_DEAL",
  NOT_ENOUGH_PLAYERS: "NOT_ENOUGH_PLAYERS",

  // Seat errors
  INVALID_SEAT: "INVALID_SEAT",
  SEAT_OCCUPIED: "SEAT_OCCUPIED",
  INVALID_STACK: "INVALID_STACK",

  // Validation errors
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",

  // Financial errors
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  INVALID_BUY_IN: "INVALID_BUY_IN",

  // Auth errors
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  // Resource errors
  NOT_FOUND: "NOT_FOUND",
  TABLE_NOT_FOUND: "TABLE_NOT_FOUND",

  // Rate limiting
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Server errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

// Type for all error codes
type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

### HTTP Status Mapping

```typescript
import { ERROR_STATUS_MAP, getStatusCodeForError } from "@pokertools/types";

// Get HTTP status for an error code
const status = getStatusCodeForError(ErrorCodes.NOT_YOUR_TURN); // 403

// Full mapping
const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCodes.INVALID_ACTION]: 400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_YOUR_TURN]: 403,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.TABLE_NOT_FOUND]: 404,
  [ErrorCodes.PLAYER_NOT_FOUND]: 404,
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCodes.INTERNAL_ERROR]: 500,
  [ErrorCodes.SERVICE_UNAVAILABLE]: 503,
  // ... see ErrorCodes.ts for full mapping
};
```

### Error Response Interface

```typescript
import { ErrorResponse, createErrorResponse, hasErrorCode } from "@pokertools/types";

interface ErrorResponse {
  error: ErrorCode;
  message: string;
  context?: Record<string, unknown>;
  statusCode?: number;
}

// Create standardized error response
const response = createErrorResponse(
  ErrorCodes.BET_TOO_SMALL,
  "Bet must be at least 10",
  { minBet: 10, attemptedBet: 5 },
  400
);

// Check if error contains a specific code
try {
  engine.applyAction(action);
} catch (error) {
  if (hasErrorCode(error, ErrorCodes.NOT_YOUR_TURN)) {
    showNotYourTurnMessage();
  }
}
```

---

## ✅ Zod Validation Schemas

All schemas provide **runtime validation** that mirrors TypeScript types.

### Action Schemas

```typescript
import {
  ActionSchema,
  SitActionSchema,
  StandActionSchema,
  BetActionSchema,
  RaiseActionSchema,
  CallActionSchema,
  CheckActionSchema,
  FoldActionSchema,
  DealActionSchema,
  AddChipsActionSchema,
  ReserveSeatActionSchema,
  ShowActionSchema,
  MuckActionSchema,
  TimeBankActionSchema,
  TimeoutActionSchema,
  NextBlindLevelActionSchema,
  UncalledBetReturnedActionSchema,
  ValidatedAction,
} from "@pokertools/types";

// Validate any action
const result = ActionSchema.safeParse(userInput);
if (result.success) {
  const action: ValidatedAction = result.data;
  engine.applyAction(action);
} else {
  console.error(result.error.issues);
}

// Validate specific action type
const sitResult = SitActionSchema.safeParse({
  type: "SIT",
  playerId: "user123",
  playerName: "Alice",
  seat: 0,
  stack: 1000,
  sitInOption: "WAIT_FOR_BB",
});
```

### Configuration Schemas

```typescript
import {
  TableConfigSchema,
  BlindLevelSchema,
  CreateTableSchema,
  ValidatedTableConfig,
  ValidatedBlindLevel,
  CreateTableRequest,
} from "@pokertools/types";

// Validate table config
const configResult = TableConfigSchema.safeParse({
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 9,
  rakePercent: 5,
});

// Custom refinements
// - bigBlind must be > smallBlind
// - maxPlayers must be 2-10
// - maxBuyIn >= minBuyIn (if both provided)

// Create table request
const createResult = CreateTableSchema.safeParse({
  name: "High Stakes",
  mode: "CASH",
  smallBlind: 25,
  bigBlind: 50,
  maxPlayers: 6, // defaults to 9 if omitted
  minBuyIn: 1000,
  maxBuyIn: 5000,
});
```

### API Request Schemas

```typescript
import {
  BuyInRequestSchema,
  AddChipsRequestSchema,
  GameActionRequestSchema,
  BuyInRequest,
  AddChipsRequest,
  GameActionRequest,
} from "@pokertools/types";

// Buy-in request validation
const buyInResult = BuyInRequestSchema.safeParse({
  amount: 1000,
  seat: 0,
  idempotencyKey: "unique-key-123",
  sitInOption: "WAIT_FOR_BB",
});

// Add chips request validation
const addChipsResult = AddChipsRequestSchema.safeParse({
  amount: 500,
  idempotencyKey: "unique-key-456",
});

// Game action request validation
const gameActionResult = GameActionRequestSchema.safeParse({
  type: "RAISE",
  amount: 200,
});
```

### Validation Rules Summary

| Schema                    | Key Validations                                  |
| ------------------------- | ------------------------------------------------ |
| `SitActionSchema`         | seat: 0-9, stack: positive int, name: 1-50 chars |
| `ReserveSeatActionSchema` | seat: 0-9, expiryTimestamp: positive int         |
| `BetActionSchema`         | amount: positive int                             |
| `RaiseActionSchema`       | amount: positive int                             |
| `TableConfigSchema`       | bigBlind > smallBlind, maxPlayers: 2-10          |
| `CreateTableSchema`       | mode: CASH\|TOURNAMENT, maxBuyIn >= minBuyIn     |
| `BuyInRequestSchema`      | amount: positive int, idempotencyKey: required   |

---

## 🌐 API DTOs

### Auth Types

```typescript
import { LoginRequest, LoginResponse, NonceResponse } from "@pokertools/types";

interface LoginRequest {
  message: string;
  signature: `0x${string}`; // Ethereum signature format
}

interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
  };
}

interface NonceResponse {
  nonce: string;
}
```

### Table Types

```typescript
import {
  TableListItem,
  GetTablesResponse,
  StandRequest,
  TableStateResponse,
} from "@pokertools/types";

interface TableListItem {
  id: string;
  name: string;
  config: TableConfig;
  status: TableStatus;
}

interface GetTablesResponse {
  tables: TableListItem[];
}

interface TableStateResponse {
  state: PublicState;
}
```

### Common Types

```typescript
import { ApiErrorResponse, SuccessResponse, GameMode, TableStatus } from "@pokertools/types";

interface ApiErrorResponse {
  error: string;
  message?: string;
  code?: string;
}

interface SuccessResponse {
  success: true;
}

type GameMode = "CASH" | "TOURNAMENT";
type TableStatus = "WAITING" | "ACTIVE" | "FINISHED";
```

---

## 🎴 Card Representation

Cards are represented as **2-character strings**:

```
┌─────────────────────────────────────────────────────────────┐
│                    CARD FORMAT: [Rank][Suit]                │
├─────────────────────────────────────────────────────────────┤
│  Ranks: 2, 3, 4, 5, 6, 7, 8, 9, T (10), J, Q, K, A          │
│  Suits: s (♠), h (♥), d (♦), c (♣)                          │
├─────────────────────────────────────────────────────────────┤
│  Examples:                                                  │
│    "As" = Ace of Spades ♠                                   │
│    "Kh" = King of Hearts ♥                                  │
│    "Td" = Ten of Diamonds ♦                                 │
│    "2c" = Two of Clubs ♣                                    │
└─────────────────────────────────────────────────────────────┘
```

### Usage in Types

```typescript
// Hole cards
const hand: string[] = ["As", "Kh"];

// Community board
const board: string[] = ["Td", "Jc", "Qs"];

// Masked cards in PublicPlayer
const maskedHand: (string | null)[] = [null, null];  // Both hidden
const partialHand: (string | null)[] = ["As", null]; // One shown

// Deck uses integer codes internally
const deck: number[] = [0, 1, 2, ...]; // Engine internal use
```

---

## 📖 Complete Example

```typescript
import {
  GameState,
  PublicState,
  Action,
  ActionType,
  PlayerStatus,
  Street,
  ActionSchema,
  ErrorCodes,
} from "@pokertools/types";

// Validate incoming action from client
function processPlayerAction(rawAction: unknown, state: PublicState): void {
  // Runtime validation
  const result = ActionSchema.safeParse(rawAction);

  if (!result.success) {
    throw new Error(`Invalid action: ${result.error.message}`);
  }

  const action = result.data;

  // Type narrowing with discriminated union
  switch (action.type) {
    case ActionType.FOLD:
      console.log(`Player ${action.playerId} folds`);
      break;

    case ActionType.BET:
      console.log(`Player ${action.playerId} bets ${action.amount}`);
      break;

    case ActionType.RAISE:
      console.log(`Player ${action.playerId} raises to ${action.amount}`);
      break;

    case ActionType.CALL:
      console.log(`Player ${action.playerId} calls`);
      break;

    case ActionType.CHECK:
      console.log(`Player ${action.playerId} checks`);
      break;

    default:
      // TypeScript knows all cases are handled
      const _exhaustive: never = action;
  }
}

// Work with public state
function renderTable(state: PublicState): void {
  console.log(`Hand #${state.handNumber} - ${state.street}`);
  console.log(`Board: ${state.board.join(" ") || "(no cards)"}`);
  console.log(`Pot: ${state.pots.reduce((sum, p) => sum + p.amount, 0)}`);

  for (const player of state.players) {
    if (player) {
      const cards = player.hand ? player.hand.map((c) => c ?? "??").join(" ") : "folded";
      console.log(
        `Seat ${player.seat}: ${player.name} (${player.stack}) [${cards}] - ${player.status}`
      );
    }
  }

  if (state.actionTo !== null) {
    const actor = state.players[state.actionTo];
    console.log(`Action to: ${actor?.name}`);
  }
}
```

---

## 🔧 TypeScript Configuration

For optimal type checking, use these compiler options:

```json
{
  "compilerOptions": {
    "strict": true,
    "preserveConstEnums": true,
    "esModuleInterop": true
  }
}
```

**Note:** `preserveConstEnums` is recommended for `const enum` types like `ActionType`, `PlayerStatus`, and `Street`.

---

## 📄 License

MIT © A.Aurelius

---

## 🔗 Related Packages

| Package                               | Description        |
| ------------------------------------- | ------------------ |
| [@pokertools/engine](../engine)       | Game state machine |
| [@pokertools/evaluator](../evaluator) | Hand evaluation    |
| [@pokertools/api](../api)             | REST/WebSocket API |
