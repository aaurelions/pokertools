# @pokertools/types

The shared contract layer of the monorepo. Every package imports its domain types from
here, and Zod schemas validate data at the API boundary.

## Installation

::: code-group

```bash [npm]
npm install @pokertools/types
```

```bash [pnpm]
pnpm add @pokertools/types
```

:::

## Actions

Every state transition is an `Action` — a discriminated union on `type`.

### ActionType table

| Type                    | Category   | Payload                       | Description                                          |
| :---------------------- | :--------- | :---------------------------- | :--------------------------------------------------- |
| `SIT`                   | Management | `seat`, `stack`, `name`, `id` | Sit at a seat with chips                             |
| `STAND`                 | Management | —                             | Leave the table                                      |
| `ADD_CHIPS`             | Management | `amount`                      | Top up chips                                         |
| `RESERVE_SEAT`          | Management | `seat`                        | Hold a seat for late join                            |
| `DEAL`                  | Dealing    | —                             | Shuffle, deal, post blinds/antes                     |
| `FOLD`                  | Betting    | —                             | Fold current hand                                    |
| `CHECK`                 | Betting    | —                             | Check                                                |
| `CALL`                  | Betting    | —                             | Call the current wager                               |
| `BET`                   | Betting    | `amount`                      | Open bet (or **CALL alias** when matching the wager) |
| `RAISE`                 | Betting    | `amount`                      | Raise to `amount`                                    |
| `SHOW`                  | Showdown   | —                             | Reveal hand at showdown                              |
| `MUCK`                  | Showdown   | —                             | Muck losing hand                                     |
| `TIMEOUT`               | Special    | —                             | Auto fold/check (workers)                            |
| `TIME_BANK`             | Special    | —                             | Activate the time bank                               |
| `UNCALLED_BET_RETURNED` | Special    | —                             | Internal: uncalled bet refund                        |
| `NEXT_BLIND_LEVEL`      | Tournament | —                             | Advance blind level                                  |

```ts
import { ActionType } from "@pokertools/types";

// Full raise to 60
const raise: Action = {
  type: ActionType.RAISE,
  playerId: "p0",
  amount: 60,
  timestamp: Date.now(),
};
```

The client action whitelist (`CLIENT_ACTION_TYPES`) restricts what the API accepts from
sockets: management and internal actions are never reachable by clients.

## Game state

`GameState` is the immutable snapshot of a table:

| Field                | Type                  | Description                                            |
| :------------------- | :-------------------- | :----------------------------------------------------- |
| `handId`             | `string`              | Stable hand identifier                                 |
| `street`             | `Street`              | `PREFLOP` \| `FLOP` \| `TURN` \| `RIVER` \| `SHOWDOWN` |
| `players`            | `(Player \| null)[]`  | Seat-indexed player slots                              |
| `deck`               | `number[]`            | Card codes (masked in public views)                    |
| `currentBets`        | `Map<number, number>` | Live wagers per seat                                   |
| `pots`               | `Pot[]`               | Collected pots (main + side)                           |
| `minRaise`           | `number`              | Minimum raise-to total                                 |
| `lastRaiseAmount`    | `number`              | Last full raise increment                              |
| `lastAggressorSeat`  | `number \| null`      | Seat of the last aggressor                             |
| `actionTo`           | `number \| null`      | Seat to act                                            |
| `activePlayers`      | `number[]`            | Seats still live                                       |
| `winners`            | `Winner[] \| null`    | Showdown awards                                        |
| `rakeThisHand`       | `number`              | Rake taken this hand                                   |
| `actionHistory`      | `ActionRecord[]`      | Every action with pot/stack effects                    |
| `previousStates`     | `GameState[]`         | Undo snapshots (stripped from public views)            |
| `timeBankActiveSeat` | `number \| null`      | Seat with a running time bank                          |
| `config`             | `TableConfig`         | Immutable table configuration                          |
| `handNumber`         | `number`              | Hand counter                                           |
| `timestamp`          | `number`              | Last update (engine clock)                             |

### Player

| Field                   | Description                               |
| :---------------------- | :---------------------------------------- |
| `id` / `name`           | Identity                                  |
| `seat`                  | Seat index                                |
| `stack`                 | Current chip count                        |
| `hand`                  | `Card[] \| null` — private until shown    |
| `shownCards`            | Cards revealed at showdown                |
| `status`                | See `PlayerStatus` below                  |
| `betThisStreet`         | Wager on the current street               |
| `totalInvestedThisHand` | Chips invested this hand (for settlement) |
| `isSittingOut`          | Away flag — timeouts use this             |
| `isDealer`              | Button position                           |

### Resident enums

```ts
export const enum PlayerStatus {
  ACTIVE = "ACTIVE",
  FOLDED = "FOLDED",
  ALL_IN = "ALL_IN",
  SITTING_OUT = "SITTING_OUT",
  WAITING = "WAITING",
  BUSTED = "BUSTED",
  RESERVED = "RESERVED",
}

export const enum Street {
  PREFLOP = "PREFLOP",
  FLOP = "FLOP",
  TURN = "TURN",
  RIVER = "RIVER",
  SHOWDOWN = "SHOWDOWN",
}
```

## Configuration

```ts
interface TableConfig {
  maxPlayers: number; // 2..10
  smallBlind: number;
  bigBlind: number;
  ante?: number; // dead money, not part of live wagers
  initialStack?: number; // tournament-style bench
  rakePercent?: number; // 0..100
  rakeCap?: number;
  noFlopNoDrop?: boolean; // rake applies to flop+ pots only
  minBuyIn?: number; // cash tables
  maxBuyIn?: number;
  blindStructure?: BlindLevel[]; // tournament mode
  allowRebuy?: boolean;
  timeBankSeconds?: number; // default 10s deduction
  clientMode?: boolean; // strict mode for optimistic clients
}
```

## API DTOs

`PublicState`, `TournamentDetails`, `HandHistory`, `TableListItem` and friends model what
the API returns. All are Zod-validated:

```ts
import { publicStateSchema } from "@pokertools/types";

const parsed = publicStateSchema.safeParse(response.body);
if (!parsed.success) {
  // handle invalid server response
}
```

## Error codes

| Code                        | Meaning                                                 |
| :-------------------------- | :------------------------------------------------------ |
| `INVALID_AMOUNT`            | Non-finite, fractional, negative or unsafe chip amounts |
| `INVALID_SEAT`              | Seat outside `0..maxPlayers-1` or non-integer           |
| `CANNOT_RERAISE`            | Betting not reopened (TDA rule 47)                      |
| `RAISE_TOO_SMALL`           | Raise below the minimum raise-to                        |
| `NOT_YOUR_TURN`             | Action received out of turn                             |
| `INSUFFICIENT_CHIPS`        | Stack too small for the wager                           |
| `TABLE_FULL` / `SEAT_TAKEN` | Seat management conflicts                               |
| `ILLEGAL_ACTION`            | Everything else the state machine rejects               |

## WebSocket messages

The API pushes `STATE_UPDATE` frames over `pubsub:table:{tableId}` carrying
`{ tableId, version, timestamp }`; the SDK fetches the new state over HTTP and keeps a
local version cache.
