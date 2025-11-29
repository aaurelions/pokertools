import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("Min-Raise After Incomplete Raise (TDA/WSOP Rules)", () => {
  test("incomplete all-in raise does NOT reopen betting but sets correct min-raise", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 120); // Short stack
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // P0 bets 100
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 100,
    });

    // Check state after P0's raise
    // minRaise = raiseAmount + raiseIncrement = 100 + 90 = 190
    expect(engine.state.minRaise).toBe(190); // 100 + 90
    expect(engine.state.lastRaiseAmount).toBe(90); // 100 - 10 (BB)

    // P1 goes all-in for 120 (incomplete raise: only +20 when min is +90)
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: 120,
    });

    // Check state after P1's incomplete raise
    // minRaise should be: 120 (current bet) + 90 (original increment) = 210
    expect(engine.state.minRaise).toBe(210);
    expect(engine.state.lastRaiseAmount).toBe(90); // Unchanged (incomplete raise)
    expect(engine.state.lastAggressorSeat).toBe(0); // Unchanged (incomplete raise)

    // P2 must raise to at least 210 (not just 120 + 20)
    const p2 = engine.state.players[2]!;

    // This should be valid (220 > 210)
    expect(() => {
      engine.act({
        type: ActionType.RAISE,
        playerId: p2.id,
        amount: 220,
      });
    }).not.toThrow();

    expect(engine.state.currentBets.get(2)).toBe(220);
  });

  test("standard raise correctly updates min-raise", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
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

    // Raise increment: 50 - 10 = 40
    // minRaise: 50 + 40 = 90
    expect(engine.state.minRaise).toBe(90);
    expect(engine.state.lastRaiseAmount).toBe(40);

    // P1 raises to 100 (complete raise: +50 which is > 40)
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: 100,
    });

    // New raise increment: 100 - 50 = 50
    // minRaise: 100 + 50 = 150
    expect(engine.state.minRaise).toBe(150);
    expect(engine.state.lastRaiseAmount).toBe(50);
    expect(engine.state.lastAggressorSeat).toBe(1);
  });

  test("scenario: P1 bets 100, P2 all-in 120, P3 must raise to 220 minimum", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 5, // Need 5 players so someone is left after incomplete raise
    });

    engine.sit(0, "p0", "Player0", 1000); // Button
    engine.sit(1, "p1", "Player1", 120); // SB - short stack
    engine.sit(2, "p2", "Player2", 1000); // BB
    engine.sit(3, "p3", "Player3", 1000); // UTG
    engine.sit(4, "p4", "Player4", 1000); // UTG+1

    engine.deal();

    // P3 (UTG) raises to 100
    const p3 = engine.state.players[3]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p3.id,
      amount: 100,
    });

    // P4 (UTG+1) calls 100
    const p4 = engine.state.players[4]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p4.id,
    });

    // P0 (button) folds
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p0.id,
    });

    // P1 (SB) goes all-in for 120 (incomplete: only +20 instead of +90)
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: 120,
    });

    // Action is now on P2 (BB) - they haven't acted yet
    // Min raise should be 120 + 90 = 210
    expect(engine.state.minRaise).toBe(210);

    // P2 tries to raise to 200 (should fail - only +80)
    const p2 = engine.state.players[2]!;
    expect(() => {
      engine.act({
        type: ActionType.RAISE,
        playerId: p2.id,
        amount: 200,
      });
    }).toThrow(); // Should throw RAISE_TOO_SMALL

    // P2 raises to 220 (should succeed - meets min)
    engine.act({
      type: ActionType.RAISE,
      playerId: p2.id,
      amount: 220,
    });

    expect(engine.state.currentBets.get(2)).toBe(220);
  });
});
