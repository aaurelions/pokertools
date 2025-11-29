import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("BET to RAISE Auto-Conversion", () => {
  test("BET action is auto-converted to RAISE when facing big blind", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // P0 is SB/Button, faces BB of 10
    const p0 = engine.state.players[0]!;

    // Send BET action (should auto-convert to RAISE)
    expect(() => {
      engine.act({
        type: ActionType.BET,
        playerId: p0.id,
        amount: 50,
      });
    }).not.toThrow();

    // Should have successfully raised
    expect(engine.state.currentBets.get(0)).toBe(50);
  });

  test("BET action is auto-converted to RAISE when facing existing bet", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // P0 calls
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p0.id,
    });

    // P1 calls
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p1.id,
    });

    // P2 checks
    const p2 = engine.state.players[2]!;
    engine.act({
      type: ActionType.CHECK,
      playerId: p2.id,
    });

    // Now on flop
    expect(engine.state.street).toBe("FLOP");

    // P1 (SB, first to act) bets 50
    engine.act({
      type: ActionType.BET,
      playerId: p1.id,
      amount: 50,
    });

    // P2 (BB) uses BET action facing the bet (should auto-convert to RAISE)
    expect(() => {
      engine.act({
        type: ActionType.BET,
        playerId: p2.id,
        amount: 150,
      });
    }).not.toThrow();

    // Should have successfully raised
    expect(engine.state.currentBets.get(2)).toBe(150);
  });

  test("BET action works normally when no existing bet", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    // P0 calls
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p0.id,
    });

    // P1 checks
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.CHECK,
      playerId: p1.id,
    });

    // Now on flop with no bets
    expect(engine.state.street).toBe("FLOP");
    expect(Math.max(...Array.from(engine.state.currentBets.values()), 0)).toBe(0);

    // P1 bets (no conversion needed)
    expect(() => {
      engine.act({
        type: ActionType.BET,
        playerId: p1.id,
        amount: 50,
      });
    }).not.toThrow();

    expect(engine.state.currentBets.get(1)).toBe(50);
  });

  test("action history records RAISE when BET is auto-converted", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    const p0 = engine.state.players[0]!;

    // Send BET action
    engine.act({
      type: ActionType.BET,
      playerId: p0.id,
      amount: 50,
    });

    // Action history should show RAISE, not BET
    const lastAction = engine.state.actionHistory[engine.state.actionHistory.length - 1];
    expect(lastAction.action.type).toBe(ActionType.RAISE);
  });

  test("BET validation still applies (minimum bet size)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();

    const p0 = engine.state.players[0]!;

    // Try to bet less than BB (should fail validation)
    expect(() => {
      engine.act({
        type: ActionType.BET,
        playerId: p0.id,
        amount: 5, // Less than BB of 10
      });
    }).toThrow();
  });
});
