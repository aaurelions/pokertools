import { ActionType, Street, type Action } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";

function table(stacks: number[]) {
  const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: stacks.length });
  stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `Player ${seat}`, stack));
  engine.deal();
  return engine;
}

describe("Review regressions", () => {
  test("public views do not expose private cards through undo snapshots", () => {
    const engine = table([1000, 1000, 1000]);
    engine.act({ type: ActionType.CALL, playerId: "p0" });
    expect(engine.state.previousStates.length).toBeGreaterThan(0);
    const view = engine.view("p0");
    expect(view.players[1]!.hand).toBeNull();
    expect(view.deck).toEqual([]);
    expect(view.previousStates).toEqual([]);
    expect(JSON.parse(JSON.stringify(view)).previousStates).toEqual([]);
  });

  test("timeout fold awards the hand immediately", () => {
    const engine = table([1000, 1000]);
    engine.act({ type: ActionType.TIMEOUT, playerId: "p0" });
    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners?.[0].seat).toBe(1);
    expect(engine.state.players[0]!.isSittingOut).toBe(true);
    expect(engine.state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0)).toBe(2000);
  });

  test("a sitting-out checked hand automatically folds to a later bet", () => {
    const engine = table([1000, 1000]);
    engine.act({ type: ActionType.CALL, playerId: "p0" });
    engine.act({ type: ActionType.CHECK, playerId: "p1" });
    engine.act({ type: ActionType.TIMEOUT, playerId: "p1" });
    engine.act({ type: ActionType.BET, playerId: "p0", amount: 20 });
    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners?.[0].seat).toBe(0);
    expect(engine.state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0)).toBe(2000);
  });

  test("antes do not inflate the call or minimum raise", () => {
    const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10, ante: 2, maxPlayers: 3 });
    [0, 1, 2].forEach((seat) => engine.sit(seat, `p${seat}`, `Player ${seat}`, 100));
    engine.deal();
    expect(engine.state.currentBets.get(2)).toBe(10);
    expect(engine.state.minRaise).toBe(20);
    expect(engine.state.pots.reduce((sum, pot) => sum + pot.amount, 0)).toBe(6);
    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 20 });
    engine.act({ type: ActionType.FOLD, playerId: "p1" });
    engine.act({ type: ActionType.FOLD, playerId: "p2" });
    expect(engine.state.players.reduce((sum, p) => sum + (p?.stack ?? 0), 0)).toBe(300);
  });

  test("fold hand history reports starting stacks and gross pot including rake", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      rakePercent: 10,
      noFlopNoDrop: false,
    });
    [0, 1, 2].forEach((seat) => engine.sit(seat, `p${seat}`, `Player ${seat}`, 1000));
    engine.deal();
    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 50 });
    engine.act({ type: ActionType.FOLD, playerId: "p1" });
    engine.act({ type: ActionType.FOLD, playerId: "p2" });
    const history = engine.getHandHistory();
    expect(history.players.map((p) => p.startingStack)).toEqual([1000, 1000, 1000]);
    expect(history.totalPot).toBe(25);
    expect(engine.state.winners![0].amount).toBe(23);
    expect(engine.state.rakeThisHand).toBe(2);
  });

  test("time bank activation expires when the player acts", () => {
    const engine = table([1000, 1000]);
    engine.act({ type: ActionType.TIME_BANK, playerId: "p0" });
    expect(engine.state.timeBankActiveSeat).toBe(0);
    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 30 });
    engine.act({ type: ActionType.RAISE, playerId: "p1", amount: 50 });
    expect(engine.state.actionTo).toBe(0);
    expect(engine.state.timeBankActiveSeat).toBeNull();
  });

  test("preflop minimum raise includes the big blind", () => {
    const engine = table([1000, 1000, 1000]);
    expect(engine.state.minRaise).toBe(20);
    expect(() => engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 15 })).toThrow();
  });

  test.each([ActionType.BET, ActionType.RAISE])(
    "%s cannot reopen a prior caller after a short all-in",
    (type) => {
      const engine = table([1000, 120, 1000, 1000]);
      engine.act({ type: ActionType.RAISE, playerId: "p3", amount: 100 });
      engine.act({ type: ActionType.CALL, playerId: "p0" });
      engine.act({ type: ActionType.RAISE, playerId: "p1", amount: 120 });
      engine.act({ type: ActionType.CALL, playerId: "p2" });
      engine.act({ type: ActionType.CALL, playerId: "p3" });
      expect(engine.state.actionTo).toBe(0);
      expect(() => engine.act({ type, playerId: "p0", amount: 300 })).toThrow(/re-opened/);
      // The BET alias still permits calling the increased wager.
      engine.act({ type: ActionType.BET, playerId: "p0", amount: 120 });
      expect(engine.state.street).toBe(Street.FLOP);
      expect(engine.state.minRaise).toBe(10);
      expect(engine.state.lastRaiseAmount).toBe(10);
    }
  );

  test("cumulative short all-ins reopen the original raiser", () => {
    const engine = table([1000, 140, 190, 1000]);
    engine.act({ type: ActionType.RAISE, playerId: "p3", amount: 100 });
    engine.act({ type: ActionType.CALL, playerId: "p0" });
    engine.act({ type: ActionType.RAISE, playerId: "p1", amount: 140 });
    engine.act({ type: ActionType.RAISE, playerId: "p2", amount: 190 });
    expect(engine.state.minRaise).toBe(280);
    engine.act({ type: ActionType.RAISE, playerId: "p3", amount: 280 });
    expect(engine.state.currentBets.get(3)).toBe(280);
  });

  test.each([NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid chip value %s through every action entry point",
    (amount) => {
      const engine = table([1000, 1000]);
      const action = { type: ActionType.BET, playerId: "p0", amount } as Action;
      expect(engine.validate(action).valid).toBe(false);
      expect(() => engine.optimisticAct(action)).toThrow();
      expect(() => engine.act(action)).toThrow();
    }
  );

  test.each([NaN, Infinity, 1.5])(
    "rejects invalid blind value %s at construction",
    (smallBlind) => {
      expect(() => new PokerEngine({ smallBlind, bigBlind: 20 })).toThrow();
    }
  );

  test("initial state uses the injected clock", () => {
    expect(new PokerEngine({ smallBlind: 5, bigBlind: 10 }, () => 123).state.timestamp).toBe(123);
  });
});
