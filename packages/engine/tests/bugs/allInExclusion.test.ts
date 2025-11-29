import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, Street } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";
import { getBlindPositions } from "../../src/rules/blinds";
import { getNextSeat } from "../../src/utils/positioning";

describe("All-In Exclusion Bug", () => {
  test("all-in player should not lose equity when active players fold", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    // Seat 3 players: P0 has 500, P1 has 500, P2 has only 10 (short stack)
    engine.sit(0, "p0", "Player0", 500);
    engine.sit(1, "p1", "Player1", 500);
    engine.sit(2, "p2", "Player2", 10); // Short stack will be all-in on BB

    const initialChips = getInitialChips(engine.state);
    expect(initialChips).toBe(1010);

    // Deal - P2 will be all-in as BB
    engine.deal();

    // After deal, P2 should be all-in (10 chips in BB)
    const p2 = engine.state.players[2];
    expect(p2?.stack).toBe(0);
    expect(p2?.status).toBe("ALL_IN");

    // Verify chips are still conserved
    expect(getInitialChips(engine.state)).toBe(1010);

    // Determine who acts first dynamically
    // Logic: Preflop action starts at the player after the Big Blind
    // Depending on button logic, BB might vary, so we calculate it from state
    const blinds = getBlindPositions(engine.state);
    expect(blinds).not.toBeNull();

    // Calculate expected UTG (Under The Gun)
    // Start searching from seat after Big Blind
    let expectedActor = getNextSeat(blinds!.bigBlindSeat, engine.state.maxPlayers);
    // Find first active player
    while (true) {
      const p = engine.state.players[expectedActor];
      if (p && p.status === "ACTIVE" && p.stack > 0) break;
      expectedActor = getNextSeat(expectedActor, engine.state.maxPlayers);
    }

    let currentPlayer = engine.state.players[engine.state.actionTo!]!;

    // Ensure the engine's choice matches standard poker rules
    expect(currentPlayer.seat).toBe(expectedActor);

    // P0 folds (or whoever is first)
    engine.act({
      type: ActionType.FOLD,
      playerId: currentPlayer.id,
    });

    // Chips should still be conserved
    expect(getInitialChips(engine.state)).toBe(1010);

    // Next player acts
    currentPlayer = engine.state.players[engine.state.actionTo!]!;

    // P1 folds (or whoever is next)
    engine.act({
      type: ActionType.FOLD,
      playerId: currentPlayer.id,
    });

    // CRITICAL CHECK: P2 (All-In) should win the pot, not lose it
    // The hand should NOT have ended when P0 folded because P2 is still live
    const finalChips = getInitialChips(engine.state);
    expect(finalChips).toBe(1010);

    // P2 should have won the pot
    expect(engine.state.winners).not.toBeNull();
    const p2Final = engine.state.players[2]!;

    // P2 started with 10, went all-in with 10
    // Should win back their 10 + the blinds from P0 and P1
    // SB (5) + BB (10 from P2) = 15 total pot
    expect(p2Final.stack).toBeGreaterThan(10);
  });

  test("hand should not end when active player folds but all-in players remain", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 10); // Short stack

    engine.deal();

    // P2 is now all-in for BB
    expect(engine.state.players[2]?.status).toBe("ALL_IN");

    // First player raises
    const firstActor = engine.state.players[engine.state.actionTo!]!;
    const p0Bet = engine.state.currentBets.get(firstActor.seat) || 0;
    engine.act({
      type: ActionType.RAISE,
      playerId: firstActor.id,
      amount: p0Bet + 20,
    });

    // Next player folds
    const secondActor = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: secondActor.id,
    });

    // At this point:
    // - P0 is active
    // - P1 is folded
    // - P2 is all-in
    // Hand should NOT end immediately since P2 is still in

    // Chips should be conserved
    expect(getInitialChips(engine.state)).toBe(210);

    // P2 (all-in) should still have a chance to win
    // The hand should auto-runout to showdown since only 1 active player remains
    expect(engine.state.street).toBe(Street.SHOWDOWN);

    // Winners should be determined (showdown completed)
    expect(engine.state.winners).not.toBeNull();

    // Chips should still be conserved after showdown
    expect(getInitialChips(engine.state)).toBe(210);
  });

  test("auto-runout correctly deals all streets without infinite recursion", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 10);

    engine.deal();

    // P2 is all-in
    expect(engine.state.players[2]?.status).toBe("ALL_IN");

    // First actor raises
    const firstActor = engine.state.players[engine.state.actionTo!]!;
    const p0Bet = engine.state.currentBets.get(firstActor.seat) || 0;
    engine.act({
      type: ActionType.RAISE,
      playerId: firstActor.id,
      amount: p0Bet + 20,
    });

    // Second actor folds - this triggers the fold logic
    const secondActor = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: secondActor.id,
    });

    // After P1 folds, only P0 (active) and P2 (all-in) remain
    // This should trigger auto-runout without infinite recursion
    expect(engine.state.street).toBe(Street.SHOWDOWN);

    // Should have dealt full board during auto-runout
    expect(engine.state.board.length).toBe(5);

    // Chips conserved
    expect(getInitialChips(engine.state)).toBe(210);
  });

  test("chip conservation with short stack going all-in on blind", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    });

    // 3 players: P2 is short stack
    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 10); // Will be all-in on blind

    expect(getInitialChips(engine.state)).toBe(210);

    engine.deal();

    // P2 should be all-in after posting blind
    expect(engine.state.players[2]?.status).toBe("ALL_IN");
    expect(getInitialChips(engine.state)).toBe(210);

    // Scenario: both other players fold
    // The all-in player should still win
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p0.id,
    });

    expect(getInitialChips(engine.state)).toBe(210);

    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p1.id,
    });

    // Final chip count should still be 210
    expect(getInitialChips(engine.state)).toBe(210);

    // P2 should have won the pot
    expect(engine.state.winners).not.toBeNull();
    const p2Final = engine.state.players[2]!;
    expect(p2Final.stack).toBeGreaterThan(10);
  });
});
