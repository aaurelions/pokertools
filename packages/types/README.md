# @pokertools/types

Pure TypeScript type definitions for poker game engine. This package contains zero runtime code - only type definitions.

## Installation

```bash
npm install @pokertools/types
```

## Usage

```typescript
import {
  Action,
  GameState,
  Player,
  Pot,
  ActionType,
  PlayerStatus,
  Street,
} from "@pokertools/types";

// Use types in your application
const player: Player = {
  id: "player1",
  name: "Alice",
  seat: 0,
  stack: 1000,
  hand: null,
  shownCards: null, // New: tracks which cards are visible at showdown
  status: PlayerStatus.WAITING,
  betThisStreet: 0,
  totalInvestedThisHand: 0,
  isSittingOut: false,
  timeBank: 30,
};

const action: Action = {
  type: ActionType.RAISE,
  playerId: "player1",
  amount: 100,
  timestamp: Date.now(),
};
```

## Type Exports

### Core Types

- `Action` - Player actions (fold, check, call, bet, raise, etc.)
- `GameState` - Complete game state
- `Player` - Player information
- `Pot` - Pot information (main and side pots)
- `Config` - Game configuration
- `PublicState` - Masked state for public view
- `HandHistory` - Hand history information

### Enums

- `ActionType` - All possible action types
- `PlayerStatus` - Player statuses (active, folded, all-in, etc.)
- `Street` - Betting rounds (preflop, flop, turn, river, showdown)

### Interfaces

All types are readonly and immutable by design.

## Philosophy

This package follows these principles:

1. **Pure Types Only** - No runtime code, no validation, no logic
2. **Immutable by Design** - All fields are readonly
3. **Zero Dependencies** - Lightweight for frontend use
4. **Single Source of Truth** - Used by engine, API, and SDK

## Related Packages

- `@pokertools/engine` - Game engine (depends on this package)
- `@pokertools/api` - REST/WebSocket API (depends on this package)
- `@pokertools/sdk` - Frontend SDK (depends on this package)

## License

MIT
