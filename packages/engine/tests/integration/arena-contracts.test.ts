import { ActionType, ErrorCodes, PlayerStatus, Street } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";
import { calculateTotalChips } from "../../src/utils/invariants";

function createShortStackEngine(): PokerEngine {
  const engine = new PokerEngine({
    smallBlind: 500,
    bigBlind: 1050,
    maxPlayers: 3,
  });

  engine.sit(0, "A", "Short stack", 200);
  engine.sit(1, "B", "Small blind", 2000);
  engine.sit(2, "C", "Big blind", 2000);
  engine.deal();

  expect(engine.state.actionTo).toBe(0);
  expect(engine.state.currentBets.get(0)).toBeUndefined();
  expect(engine.state.currentBets.get(2)).toBe(1050);
  return engine;
}

describe("browser tournament integration contracts", () => {
  test("an amount-less CALL commits only a short stack's remaining chips", () => {
    const engine = createShortStackEngine();
    const call = { type: ActionType.CALL, playerId: "A" } as const;

    expect(engine.validate(call)).toEqual({ valid: true });
    engine.act(call);

    expect(engine.state.players[0]!.stack).toBe(0);
    expect(engine.state.currentBets.get(0)).toBe(200);
    expect(engine.state.players[0]!.status).toBe(PlayerStatus.ALL_IN);
    expect(engine.state.actionHistory[0].action).toMatchObject({
      type: ActionType.CALL,
      amount: 200,
    });
  });

  test("RAISE uses raise-to semantics and rejects an all-in below the price to call", () => {
    const engine = createShortStackEngine();
    const raise = { type: ActionType.RAISE, playerId: "A", amount: 200 } as const;

    expect(engine.validate(raise)).toMatchObject({
      valid: false,
      code: ErrorCodes.RAISE_TOO_SMALL,
    });
    expect(engine.validate({ type: ActionType.RAISE, playerId: "A", amount: 2000 })).toMatchObject({
      valid: false,
      code: ErrorCodes.RAISE_TOO_SMALL,
    });
    expect(() => engine.act(raise)).toThrow("must be greater than current bet 1050");
  });

  test("standing a third player enables heads-up blinds, action order, and button rotation", () => {
    const engine = new PokerEngine({ smallBlind: 50, bigBlind: 100, maxPlayers: 3 });
    engine.sit(0, "A", "A", 2000);
    engine.sit(1, "B", "B", 2000);
    engine.sit(2, "C", "C", 2000);

    engine.deal();
    engine.act({ type: ActionType.FOLD, playerId: "A" });
    engine.act({ type: ActionType.FOLD, playerId: "B" });
    engine.stand("B");

    engine.deal();
    expect(engine.state.buttonSeat).toBe(2);
    expect(engine.state.currentBets.get(2)).toBe(50);
    expect(engine.state.currentBets.get(0)).toBe(100);
    expect(engine.state.actionTo).toBe(2);

    engine.act({ type: ActionType.CALL, playerId: "C" });
    engine.act({ type: ActionType.CHECK, playerId: "A" });
    expect(engine.state.street).toBe(Street.FLOP);
    expect(engine.state.actionTo).toBe(0);

    engine.act({ type: ActionType.FOLD, playerId: "A" });
    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);
    expect(engine.state.currentBets.get(0)).toBe(50);
    expect(engine.state.currentBets.get(2)).toBe(100);
    expect(engine.state.actionTo).toBe(0);
  });

  test("a seated zero-stack player is a dead seat when dealing heads-up", () => {
    const source = new PokerEngine({ smallBlind: 50, bigBlind: 100, maxPlayers: 3 });
    source.sit(0, "A", "A", 2000);
    source.sit(1, "B", "B", 100);
    source.sit(2, "C", "C", 2000);

    const snapshot = source.snapshot;
    snapshot.players[1] = { ...snapshot.players[1]!, stack: 0 };
    const engine = PokerEngine.restore(snapshot);

    expect(() => engine.deal()).not.toThrow();
    expect(engine.state.buttonSeat).toBe(0);
    expect(engine.state.players[1]!.hand).toBeNull();
    expect(engine.state.currentBets.has(1)).toBe(false);
    expect(engine.state.activePlayers).not.toContain(1);
    expect(engine.state.currentBets.get(0)).toBe(50);
    expect(engine.state.currentBets.get(2)).toBe(100);
    expect(engine.state.actionTo).toBe(0);
  });

  test("winner state identifies players by seat", () => {
    const engine = new PokerEngine({ smallBlind: 50, bigBlind: 100, maxPlayers: 2 });
    engine.sit(0, "A", "Alice", 2000);
    engine.sit(1, "B", "Bob", 2000);
    engine.deal();

    const foldingSeat = engine.state.actionTo!;
    engine.act({
      type: ActionType.FOLD,
      playerId: engine.state.players[foldingSeat]!.id,
    });

    expect(engine.state.winners).toHaveLength(1);
    expect(engine.state.winners![0]).toMatchObject({
      seat: expect.any(Number),
      amount: expect.any(Number),
    });
    expect(engine.state.winners![0]).not.toHaveProperty("playerId");
    expect(engine.state.winners![0]).not.toHaveProperty("playerName");
    expect(engine.state.players[engine.state.winners![0].seat]!.id).toBeDefined();
    expect(calculateTotalChips(engine.state)).toBe(4000);
  });
});
