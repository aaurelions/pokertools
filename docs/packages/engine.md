# @pokertools/engine

The immutable core logic for Texas Hold'em state management. A Redux-style reducer
(`gameReducer`) transforms `GameState` under strict validation; `PokerEngine` wraps it
with a friendlier API, optimistic actions, undo, snapshots and hand-history export.

## Installation

::: code-group

```bash [npm]
npm install @pokertools/engine
```

```bash [pnpm]
pnpm add @pokertools/engine
```

:::

## Quick start — a full hand

```ts
import { PokerEngine } from "@pokertools/engine";
import { ActionType } from "@pokertools/types";

// 3 players, 10/20 blinds
const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 3 });

engine.sit(0, "p0", "Alice", 1000);
engine.sit(1, "p1", "Bob", 1000);
engine.sit(2, "p2", "Carol", 1000);
engine.deal();

console.log(engine.state.actionTo); // 0 — Alice first to act (UTG)

const view = engine.view("p0"); // masked view: only Alice's cards visible
console.log(view.players[0]!.hand); // her two hole cards

engine.act({ type: ActionType.FOLD, playerId: "p0" });
engine.act({ type: ActionType.RAISE, playerId: "p1", amount: 60 });
engine.act({ type: ActionType.CALL, playerId: "p2" });

// Betting round complete → flop dealt automatically
console.log(engine.state.street); // "FLOP"
```

## Engine API

| Member                               | Description                                                                       |
| :----------------------------------- | :-------------------------------------------------------------------------------- |
| `constructor(config, timeProvider?)` | Create a table; `timeProvider` defaults to `Date.now` and is injectable for tests |
| `sit(seat, id, name, stack)`         | Seat a player (validates seat + chip amount)                                      |
| `stand(id)`                          | Remove a player                                                                   |
| `deal()`                             | Shuffle, deal, collect antes, post blinds                                         |
| `act(action)`                        | Validate and apply an action; throws `IllegalActionError` on rule violations      |
| `validate(action)`                   | Dry-run — returns `{ valid: true }` or `{ valid: false, error, code }`            |
| `optimisticAct(action)`              | Apply an action that `validate` has already accepted (client dry-run path)        |
| `undo()`                             | Revert to the previous state snapshot                                             |
| `state`                              | Current `GameState`                                                               |
| `view(playerId?, version?)`          | **Masked** `PublicState` (private cards, deck and undo history stripped)          |
| `snapshot`                           | JSON-serializable snapshot for persistence                                        |
| `restore(snapshot)`                  | Static — rebuild an engine from a snapshot                                        |
| `on(listener)`                       | Subscribe to state-change events; returns unsubscribe                             |
| `nextBlindLevel()`                   | Tournament: advance to the next blind level                                       |
| `history({ format })`                | Export hand history (`"json"` or `"stars"` PokerStars-style text)                 |
| `getHandHistory()`                   | Structured `HandHistory` (players, streets, winners, rake)                        |

## Configuration

| Option                    | Default | Validation                                         |
| :------------------------ | :------ | :------------------------------------------------- |
| `maxPlayers`              | 9       | Integer 2..10                                      |
| `smallBlind` / `bigBlind` | —       | Non-negative safe integers                         |
| `ante`                    | 0       | Dead money — never part of live wagers             |
| `initialStack`            | 0       | Tournament bench refill amount                     |
| `rakePercent`             | 0       | 0..100                                             |
| `rakeCap`                 | 0       | Per-hand rake ceiling                              |
| `noFlopNoDrop`            | true    | No rake unless a flop is dealt                     |
| `minBuyIn` / `maxBuyIn`   | —       | Cash table buy-in bounds                           |
| `blindStructure`          | —       | Tournament levels `{ smallBlind, bigBlind, ante }` |
| `timeBankSeconds`         | 10      | Time-bank deduction per activation                 |
| `allowRebuy`              | false   | Rebuy policy                                       |
| `clientMode`              | false   | Strict validation for optimistic clients           |

```ts
const tournament = new PokerEngine({
  smallBlind: 25,
  bigBlind: 50,
  ante: 5,
  maxPlayers: 6,
  initialStack: 5000,
  blindStructure: [
    { smallBlind: 25, bigBlind: 50, ante: 0 },
    { smallBlind: 50, bigBlind: 100, ante: 5 },
    { smallBlind: 75, bigBlind: 150, ante: 10 },
    // ...
  ],
});
```

## Betting example with raise rules

```ts
const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 4 });
[0, 1, 2, 3].forEach((seat) => engine.sit(seat, `p${seat}`, `P${seat}`, 1000));
engine.deal();

// Alice raises 10 → 20 (minimum raise-to)
engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 20 });

// Bob goes all-in for 24 total — an incomplete raise
engine.act({ type: ActionType.RAISE, playerId: "p1", amount: 24 });

// The raise increment stays 10, so the next minimum is 34, not 40
console.log(engine.state.minRaise); // 34
console.log(engine.state.lastRaiseAmount); // 10
```

### Raise rule reference

| Situation                | Engine behavior                                               |
| :----------------------- | :------------------------------------------------------------ |
| First preflop raise      | Must reach `bigBlind × 2`                                     |
| Full raise               | `minRaise = raiseTo + raiseIncrement`                         |
| Short all-in             | Increment preserved, `minRaise` moves with the new wager      |
| Player already acted     | Cannot re-raise unless betting reopened for **them** (TDA 47) |
| Cumulative short all-ins | Can reopen the original aggressor                             |
| `BET` matching wager     | Normalized to `CALL`                                          |

## Timeouts & time bank

```ts
import { ActionType } from "@pokertools/types";

// The engine models what the API worker does on timeout:
engine.act({ type: ActionType.TIMEOUT, playerId: "p0" });

// Or the player activates their time bank first
engine.act({ type: ActionType.TIME_BANK, playerId: "p0" });
console.log(engine.state.timeBankActiveSeat); // 0
```

A timeout folds if the player faces a wager, otherwise checks. Both paths run through the
normal betting handlers, so a timeout fold can award the last live hand immediately.
Sitting-out players are automatically checked/folded when action reaches them.

## View masking

`engine.view(playerId)` returns a public state where:

- the **deck is empty**
- hole cards of other players are `null`
- `previousStates` (undo snapshots) are removed — they contain unmasked hands

```ts
const masked = engine.view("p0");
masked.players[1]!.hand; // null
masked.deck; // []
masked.previousStates; // []
```

## Hand history

```ts
engine.getHandHistory();
// {
//   handId, tableId, totalPot, rakeThisHand, players: [
//     { id, name, seat, startingStack, endingStack, cards, invested, won, ... }
//   ], streets: [...], winners: [...]
// }

engine.history({ format: "stars" });
// PokerStars-style hand text:
// "PokerTools Hand #123: Hold'em No Limit (5/10)"
// "Seat 1: Alice (1000 in chips)"
// "Alice: raises 10 to 20"
```

Accounting details: fold winners receive **gross** awards (consistent with showdown),
uncalled returns reduce `totalInvestedThisHand`, and `totalPot` includes rake.

## Validation & integrity

All public entry points (`act`, `optimisticAct`, `validate`, `sit`, `deal`) reject:

- non-finite amounts (`NaN`, `Infinity`)
- fractional chips
- negative chips
- values above `Number.MAX_SAFE_INTEGER`

The reducer also runs an integrity check after every action (chip conservation) and can be
configured to throw on failure — not recommended to disable in production.

## Undo (client-side dry runs)

`optimisticAct` + `undo` power instant client UIs: validate once, apply optimistically,
and roll back if the server rejects the same action.

```ts
// Preview a raise without committing to it
const preview = engine.optimisticAct({ type: ActionType.RAISE, playerId: "p0", amount: 60 });
console.log(preview.currentBets.get(0)); // 60

// Server round-trip failed → roll back
engine.undo();
console.log(engine.state.currentBets.get(0)); // 10 (previous wager restored)
```

Undo rewind snapshots are stripped from every **public view** — they contain unmasked
hands and the deck order.

## Tournament lifecycle

```ts
const tournament = new PokerEngine({
  smallBlind: 25,
  bigBlind: 50,
  ante: 5,
  maxPlayers: 6,
  initialStack: 5000,
  blindStructure: [
    { smallBlind: 25, bigBlind: 50, ante: 0 },
    { smallBlind: 50, bigBlind: 100, ante: 5 },
    { smallBlind: 75, bigBlind: 150, ante: 10 },
  ],
});

// Seat everyone (bench-style stacks, ante auto-posted each deal)
[0, 1, 2, 3, 4, 5].forEach((seat) => tournament.sit(seat, `p${seat}`, `Player ${seat}`, 5000));
tournament.deal();
console.log(tournament.state.pots); // ante pot + blind pot

// Level up on schedule — or via the API's blind worker
tournament.nextBlindLevel();
console.log(tournament.state.bigBlind); // 100
console.log(tournament.state.ante); // 5

// A player who loses all chips is eliminated (BUSTED), not seated out
```

## Serialization

```ts
const snap = engine.snapshot; // plain JSON-safe object (Maps converted)
const revived = PokerEngine.restore(snap); // deterministic rebuild
console.log(JSON.stringify(revived.state) === JSON.stringify(engine.state)); // true
```

Snapshots power Redis persistence, auto-deal, timeout workers and hand archiving.
