/**
 * Regression tests for issue #5: betting must close when exactly one live
 * player has chips, everyone else is all-in, and that player owes no call.
 */
import { PokerEngine } from "../../src/engine/poker-engine";
import { ActionType, Street } from "@pokertools/types";
import { calculateTotalChips } from "../../src/utils/invariants";
import { createRiggedRandom } from "../helpers/rigged-random";

function table(stacks: number[], topCards: string[], blinds = { smallBlind: 1, bigBlind: 2 }) {
  const engine = new PokerEngine({
    ...blinds,
    maxPlayers: stacks.length,
    rakePercent: 0,
    randomProvider: createRiggedRandom(topCards),
  });
  stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `Player ${seat}`, stack));
  engine.deal();
  return engine;
}

function act(engine: PokerEngine, seat: number, type: ActionType, amount?: number) {
  engine.act({ type, playerId: `p${seat}`, ...(amount === undefined ? {} : { amount }) } as never);
}

function net(engine: PokerEngine, stacks: number[]) {
  return stacks.map((stack, seat) => engine.state.players[seat]!.stack - stack);
}

describe("lone player with chips against all-in opponents", () => {
  test("a fold that leaves one player with chips and no call runs out the board", () => {
    const stacks = [50, 30, 200, 200];
    const engine = table(stacks, [
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
    ]);

    act(engine, 3, ActionType.RAISE, 50);
    act(engine, 0, ActionType.CALL); // all-in
    act(engine, 1, ActionType.CALL); // all-in
    act(engine, 2, ActionType.CALL);
    act(engine, 2, ActionType.BET, 50);
    act(engine, 3, ActionType.CALL);
    act(engine, 2, ActionType.FOLD); // turn, no bet outstanding

    expect(engine.state.actionTo).toBeNull();
    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.board).toEqual(["3c", "4d", "As", "Qs", "Js"]);
    expect(engine.state.winners).not.toBeNull();
    // Main 120 -> seat 1 (pair of threes); side 60 -> seat 3 (A-Q-J-9 beats
    // A-Q-J-6); seat 3 takes the 100 that only it can win.
    expect(net(engine, stacks)).toEqual([-50, 90, -100, 60]);
    expect(calculateTotalChips(engine.state)).toBe(480);
  });

  test.each([[[1, 200]], [[200, 1]], [[2, 1]]])(
    "blinds %j that already close the action run out to showdown",
    (stacks) => {
      // Seat 0 holds K-K, seat 1 holds A-A.
      const engine = table(stacks, [
        "Ks",
        "As",
        "Kh",
        "Ah",
        "2s",
        "2c",
        "7d",
        "9h",
        "2h",
        "4s",
        "2d",
        "Jc",
      ]);

      expect(engine.state.actionTo).toBeNull();
      expect(engine.state.board).toEqual(["2c", "7d", "9h", "4s", "Jc"]);
      expect(engine.state.winners).toEqual([expect.objectContaining({ seat: 1, amount: 2 })]);
      expect(net(engine, stacks)).toEqual([-1, 1]);
    }
  );

  test("the lone player must still act when facing an unmatched all-in", () => {
    const engine = table([200, 7], [], { smallBlind: 5, bigBlind: 10 });

    expect(engine.state.actionTo).toBe(0);
  });

  test("the lone player must still act when an all-in raise exceeds their bet", () => {
    const engine = table([100, 1000], []);

    act(engine, 0, ActionType.RAISE, 100); // all-in

    expect(engine.state.actionTo).toBe(1);
  });

  test("the big blind keeps its option while two players have chips", () => {
    const engine = table([5, 100, 100], [], { smallBlind: 5, bigBlind: 10 });

    act(engine, 0, ActionType.CALL); // all-in for 5
    act(engine, 1, ActionType.CALL);

    expect(engine.state.actionTo).toBe(2);
  });
});
