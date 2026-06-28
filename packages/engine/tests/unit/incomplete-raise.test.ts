import { PokerEngine } from "../../src/engine/poker-engine";
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

    // Check state after P1's incomplete raise.
    // The all-in changes the call amount to 120, but does not change the next
    // legal full-raise threshold, which remains the previous minimum raise to 190.
    expect(engine.state.minRaise).toBe(190);
    expect(engine.state.lastRaiseAmount).toBe(90); // Unchanged (incomplete raise)
    expect(engine.state.lastAggressorSeat).toBe(0); // Unchanged (incomplete raise)

    // P2 must raise to at least 190: a full raise over the last complete raise.
    const p2 = engine.state.players[2]!;

    // This should be valid (190 meets the unchanged full-raise threshold)
    expect(() => {
      engine.act({
        type: ActionType.RAISE,
        playerId: p2.id,
        amount: 190,
      });
    }).not.toThrow();

    expect(engine.state.currentBets.get(2)).toBe(190);
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
    // Min raise should remain 190; the short all-in did not establish a new raise size.
    expect(engine.state.minRaise).toBe(190);

    // P2 tries to raise to 180 (should fail - below the previous full-raise threshold)
    const p2 = engine.state.players[2]!;
    expect(() => {
      engine.act({
        type: ActionType.RAISE,
        playerId: p2.id,
        amount: 180,
      });
    }).toThrow(); // Should throw RAISE_TOO_SMALL

    // P2 raises to 190 (should succeed - meets min)
    engine.act({
      type: ActionType.RAISE,
      playerId: p2.id,
      amount: 190,
    });

    expect(engine.state.currentBets.get(2)).toBe(190);
  });
});
