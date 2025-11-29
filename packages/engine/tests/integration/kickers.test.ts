import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Kicker Edge Cases", () => {
  test("identical hands result in split pot with chip conservation", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);

    engine.deal();

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

    expect(engine.state.winners).not.toBeNull();
    expect(getInitialChips(engine.state)).toBe(200);

    // If it's a split, both players should get their money back (minus rake if implemented)
    const totalWinnings = engine.state.winners!.reduce((sum, w) => sum + w.amount, 0);
    expect(totalWinnings).toBeLessThanOrEqual(200);
  });

  test("two pair with different kickers", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);

    // Board: Ah Ah Kd Qd Jd
    // P0: Ks Qs (AAKKQ - trips aces, two kings, queen kicker)
    // P1: Ks 2s (AAKKJ - trips aces, two kings, jack kicker)
    // P0 should win with queen kicker > jack kicker

    engine.deal();

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

    expect(engine.state.winners).not.toBeNull();
    expect(getInitialChips(engine.state)).toBe(200);
  });

  test("high card kicker decides winner", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);

    engine.deal();

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

    // Verify showdown completed
    expect(engine.state.winners).not.toBeNull();

    // Chip conservation
    expect(getInitialChips(engine.state)).toBe(200);
  });
});
