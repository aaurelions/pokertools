import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("Minimum Raise Calculation", () => {
  test("minimum raise should be previous bet + raise increment, not double", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // P0 acts first (UTG in 3-player)
    // P0 bets 50 (raise from 20 to 50, increment is 30)
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 50,
    });

    // Check minRaise - should be 50 + 30 = 80, NOT 100 (50 * 2)
    expect(engine.state.minRaise).toBe(80);

    // P1 raises to minimum (80)
    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: 80,
    });

    // Now minRaise should be 80 + 30 = 110
    expect(engine.state.minRaise).toBe(110);
  });

  test("minimum raise after bet should be bet + bet", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // Preflop action completes
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p0.id,
    });

    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.CHECK,
      playerId: p1.id,
    });

    // Flop
    // P1 bets 50
    const p1Flop = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.BET,
      playerId: p1Flop.id,
      amount: 50,
    });

    // minRaise should be 50 + 50 = 100
    expect(engine.state.minRaise).toBe(100);
  });

  test("reraise minimum after initial raise", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // P0 raises to 6 (from 2, increment is 4)
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 6,
    });

    // minRaise should be 6 + 4 = 10
    expect(engine.state.minRaise).toBe(10);
    expect(engine.state.lastRaiseAmount).toBe(4);

    // P1 raises to 10 (minimum)
    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: 10,
    });

    // New raise increment is 10 - 6 = 4
    // minRaise should be 10 + 4 = 14
    expect(engine.state.minRaise).toBe(14);

    // P2 raises to 18 (increment of 8, which is 2x the minimum)
    const p2 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p2.id,
      amount: 18,
    });

    // New raise increment is 18 - 10 = 8
    // minRaise should be 18 + 8 = 26
    expect(engine.state.minRaise).toBe(26);
  });
});
