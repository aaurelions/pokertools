import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Rake on Non-Showdown Hands", () => {
  test("rake is collected when hand ends by folding (No Flop No Drop does NOT apply)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      rakePercent: 5, // 5% rake
      rakeCap: 10,
      noFlopNoDrop: false, // Disable No Flop No Drop for this test
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // P0 raises to 50
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 50,
    });

    // P1 folds
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p1.id,
    });

    // P2 folds
    const p2 = engine.state.players[2]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p2.id,
    });

    // Pot before rake: 50 (P0) + 5 (P1 SB) + 10 (P2 BB) = 65
    // Expected rake: 65 * 0.05 = 3.25 -> floor = 3
    expect(engine.state.rakeThisHand).toBe(3);

    // Hand should be at showdown (everyone folded or all-in)
    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.winners).not.toBeNull();

    // Chip conservation: 3000 (initial) should equal stacks + invested + rake
    expect(getInitialChips(engine.state)).toBe(3000);
  });

  test("rake is collected on flop when someone folds", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      rakePercent: 10, // 10% rake
      rakeCap: 20,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // Both check to flop
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p0.id,
    });

    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.CHECK,
      playerId: p1.id,
    });

    expect(engine.state.street).toBe("FLOP");

    // P1 bets 100
    engine.act({
      type: ActionType.BET,
      playerId: p1.id,
      amount: 100,
    });

    // P0 folds
    engine.act({
      type: ActionType.FOLD,
      playerId: p0.id,
    });

    // P1 posted BB (10), then bet 100 on flop = 110 total
    // P0 posted SB (5), called to 10 preflop, then folded on flop = 10 total
    // Total pot: 120
    // Rake: 120 * 0.10 = 12
    expect(engine.state.rakeThisHand).toBe(12);

    // After rake: 108
    // P1 ends with starting chips (1000) - invested (110) + pot after rake (108) = 998
    const p1After = engine.state.players[1]!;
    expect(p1After.stack).toBe(998);

    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("rake cap is applied on non-showdown hands", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      rakePercent: 5,
      rakeCap: 3, // Low cap
      noFlopNoDrop: false, // Disable No Flop No Drop for this test
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // P0 raises big
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 200,
    });

    // P1 folds
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p1.id,
    });

    // Pot: 5 + 200 = 205
    // Rake at 5%: 205 * 0.05 = 10.25 -> floor = 10
    // But rakeCap is 3
    expect(engine.state.rakeThisHand).toBe(3);

    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("no rake for tournaments (non-showdown hands)", () => {
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 2,
      blindStructure: [
        { smallBlind: 25, bigBlind: 50, ante: 0 },
        { smallBlind: 50, bigBlind: 100, ante: 0 },
      ],
      rakePercent: 5, // Should be ignored
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // P0 raises
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 200,
    });

    // P1 folds
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p1.id,
    });

    // No rake in tournaments
    expect(engine.state.rakeThisHand).toBe(0);

    expect(getInitialChips(engine.state)).toBe(2000);
  });
});
