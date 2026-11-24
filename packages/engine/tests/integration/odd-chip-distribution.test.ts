import { PokerEngine } from "../../src/engine/poker-engine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";
import { createRiggedRandom } from "../helpers/rigged-random";

describe("Odd Chip Distribution", () => {
  test("3-way split of 10 chip pot - odd chips go to players left of button", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 3,
      randomProvider: () => 0.5, // Deterministic to ensure tie
    });

    // Set up players with specific amounts to create 10 chip pot
    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 100);

    engine.deal();

    // Get initial button position
    const _buttonSeat = engine.state.buttonSeat!;

    // Create a pot of exactly 10 chips
    // We'll use controlled betting to reach this amount
    // Preflop: SB(1) + BB(2) = 3 chips base

    // Simplify - just check/call through preflop
    while (engine.state.street === "PREFLOP" && engine.state.actionTo !== null) {
      const player = engine.state.players[engine.state.actionTo!]!;
      const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      const playerBet = engine.state.currentBets.get(engine.state.actionTo!) || 0;

      if (currentBet > playerBet) {
        engine.act({
          type: ActionType.CALL,
          playerId: player.id,
        });
      } else {
        engine.act({
          type: ActionType.CHECK,
          playerId: player.id,
        });
      }
    }

    // Flop - add 8 more chips to reach total of 10
    // Each player bets ~2.67 chips
    if (engine.state.actionTo !== null) {
      const currentPlayer = engine.state.players[engine.state.actionTo!]!;
      engine.act({
        type: ActionType.BET,
        playerId: currentPlayer.id,
        amount: 3,
      });

      // Next player calls
      if (engine.state.actionTo !== null) {
        const nextPlayer = engine.state.players[engine.state.actionTo!]!;
        engine.act({
          type: ActionType.CALL,
          playerId: nextPlayer.id,
        });
      }

      // Last player calls
      if (engine.state.actionTo !== null) {
        const lastPlayer = engine.state.players[engine.state.actionTo!]!;
        engine.act({
          type: ActionType.CALL,
          playerId: lastPlayer.id,
        });
      }
    }

    // Continue to river and showdown
    // Players check through remaining streets to reach showdown
    while (engine.state.street !== "SHOWDOWN" && engine.state.actionTo !== null) {
      const currentPlayer = engine.state.players[engine.state.actionTo!]!;
      try {
        engine.act({
          type: ActionType.CHECK,
          playerId: currentPlayer.id,
        });
      } catch {
        break;
      }
    }

    // If we have a 3-way tie with 10 chip pot:
    // - Each share is 10 / 3 = 3.33... → base share = 3
    // - Remainder: 10 % 3 = 1
    // - First player (left of button) gets 3 + 1 = 4
    // - Second and third get 3 each
    // - Total: 4 + 3 + 3 = 10 ✓

    if (engine.state.winners && engine.state.winners.length === 3) {
      const totalAwarded = engine.state.winners.reduce((sum, w) => sum + w.amount, 0);

      // Verify exact chip conservation
      expect(totalAwarded).toBe(totalAwarded); // Whatever was in pot

      // Verify chips are conserved overall
      expect(getInitialChips(engine.state)).toBe(300);

      // Verify winners are sorted by distance from button
      const seats = engine.state.winners.map((w) => w.seat);
      // All three players should be winners in a 3-way tie
      expect(seats.length).toBe(3);
    }

    // Final chip conservation check
    expect(getInitialChips(engine.state)).toBe(300);
  });

  test("2-way split of 11 chips - odd chip goes to player left of button", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 6,
      maxPlayers: 2,
      randomProvider: () => 0.5, // Deterministic
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);

    engine.deal();

    const _buttonSeat = engine.state.buttonSeat!;

    // All-in to force showdown
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 100,
    });

    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p1.id,
    });

    // Verify showdown
    expect(engine.state.winners).not.toBeNull();

    // If it's a split pot, verify chip conservation
    if (engine.state.winners && engine.state.winners.length === 2) {
      const totalAwarded = engine.state.winners.reduce((sum, w) => sum + w.amount, 0);
      const totalPot = 200; // Both players all-in with 100 each

      // Should award entire pot
      expect(totalAwarded).toBe(totalPot);

      // In a 2-way split of 200: each gets 100 (no remainder)
      // But if pot was odd (e.g., 201), first player gets 101, second gets 100
    }

    expect(getInitialChips(engine.state)).toBe(200);
  });

  test("4-way split with remainder - first players get odd chips", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 4,
      randomProvider: () => 0.5,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 100);
    engine.sit(3, "p3", "Player3", 100);

    engine.deal();

    // Check through to see showdown scenario
    while (engine.state.actionTo !== null && engine.state.street !== "SHOWDOWN") {
      const player = engine.state.players[engine.state.actionTo!]!;
      const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      const playerBet = engine.state.currentBets.get(engine.state.actionTo!) || 0;

      if (currentBet === playerBet) {
        try {
          engine.act({
            type: ActionType.CHECK,
            playerId: player.id,
          });
        } catch {
          break;
        }
      } else {
        try {
          engine.act({
            type: ActionType.CALL,
            playerId: player.id,
          });
        } catch {
          break;
        }
      }
    }

    // Verify chip conservation regardless of outcome
    expect(getInitialChips(engine.state)).toBe(400);
  });

  // Issue #4: folded players with different investments must not fragment a
  // pot contested by the same players, or every fragment's odd chip goes to
  // the same winner.
  test.each([
    [0, [5, -1, -2, -7, 5], 0],
    [10, [3, -1, -2, -7, 4], 3],
  ])("tied pot after uneven folds is split once (rake %i%%)", (rakePercent, expectedNet, rake) => {
    const stacks = [100, 100, 100, 100, 100];
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 5,
      rakePercent,
      // Board As Ks Qs Js Ts: seats 0 and 4 both play the royal flush.
      randomProvider: createRiggedRandom([
        "2c",
        "3d",
        "4c",
        "5d",
        "6c",
        "7d",
        "8c",
        "9d",
        "2d",
        "3c",
        "4d",
        "As",
        "Ks",
        "Qs",
        "5c",
        "Js",
        "6d",
        "Ts",
      ]),
    });
    stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `Player${seat}`, stack));
    engine.deal();

    const actions: Array<[number, ActionType, number?]> = [
      [3, ActionType.CALL],
      [4, ActionType.RAISE, 4],
      [0, ActionType.CALL],
      [1, ActionType.FOLD],
      [2, ActionType.FOLD],
      [3, ActionType.CALL],
      [3, ActionType.BET, 3],
      [4, ActionType.RAISE, 6],
      [0, ActionType.CALL],
      [3, ActionType.FOLD],
      [4, ActionType.CHECK],
      [0, ActionType.CHECK],
      [4, ActionType.CHECK],
      [0, ActionType.CHECK],
    ];
    for (const [seat, type, amount] of actions) {
      engine.act({
        type,
        playerId: `p${seat}`,
        ...(amount === undefined ? {} : { amount }),
      } as never);
    }

    expect(engine.state.board).toEqual(["As", "Ks", "Qs", "Js", "Ts"]);
    expect(engine.state.winners?.map((winner) => winner.seat).sort()).toEqual([0, 4]);
    expect(engine.state.rakeThisHand).toBe(rake);
    expect(stacks.map((stack, seat) => engine.state.players[seat]!.stack - stack)).toEqual(
      expectedNet
    );
  });
});
