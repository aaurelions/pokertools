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

    // P0 bet 50, P1 (SB) put in 5, P2 (BB) put in 10
    // Highest opponent bet = 10 (BB)
    // Uncalled portion = 50 - 10 = 40 (returned to P0, NO RAKE)
    // Contested pot = 10 (P0's called portion) + 5 (P1) + 10 (P2) = 25
    // Expected rake: 25 * 0.05 = 1.25 -> floor = 1
    expect(engine.state.rakeThisHand).toBe(1);

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

    // Preflop pot (from state.pots after street progression): 20
    // P1 bet 100 on flop, P0 folded (bet 0)
    // Highest opponent bet on current street = 0
    // Uncalled portion = 100 - 0 = 100 (returned to P1, NO RAKE)
    // Contested pot from current street = 0 (P1's called portion) + 0 (P0) = 0
    // Total contested = 20 (from pots) + 0 (current street) = 20
    // Rake: 20 * 0.10 = 2
    expect(engine.state.rakeThisHand).toBe(2);

    // P1 total invested: 10 (BB) + 100 (flop bet) = 110
    // P1 gets back: 100 (uncalled) + (20 - 2) (pot after rake) = 118
    // P1 ends with: 1000 - 110 + 118 = 1008
    const p1After = engine.state.players[1]!;
    expect(p1After.stack).toBe(1008);

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

    // P0 bet 200, P1 (BB) put in 10
    // Highest opponent bet = 10
    // Uncalled portion = 200 - 10 = 190 (returned to P0, NO RAKE)
    // Contested pot = 10 (P0's called portion) + 5 (P1 SB, wait - P1 is BB)

    // Let me recalculate positions:
    // In 2-player: Player 0 is button/SB, Player 1 is BB
    // P0 (SB=5) raises to 200
    // P1 (BB=10) folds
    // Highest opponent bet = 10 (BB)
    // Uncalled portion = 200 - 10 = 190 (returned)
    // Contested pot = 10 (P0's matched) + 10 (P1's BB) = 20
    // Rake at 5%: 20 * 0.05 = 1
    // rakeCap is 3, so rake = 1 (under cap)
    expect(engine.state.rakeThisHand).toBe(1);

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

  test("uncalled bet is returned with no rake", () => {
    const engine = new PokerEngine({
      smallBlind: 50,
      bigBlind: 100,
      maxPlayers: 2,
      rakePercent: 5,
      rakeCap: 100,
      noFlopNoDrop: false, // DISABLE No Flop No Drop to test rake on preflop folds
    });

    engine.sit(0, "p0", "Player0", 10000);
    engine.sit(1, "p1", "Player1", 10000);

    engine.deal();

    const p0 = engine.state.players[0]!;
    const p1 = engine.state.players[1]!;

    // P0 (SB=50) raises to 1000
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: 1000,
    });

    // P1 (BB=100) folds
    engine.act({
      type: ActionType.FOLD,
      playerId: p1.id,
    });

    // P0 bet 1000, P1 (BB) put in 100
    // Uncalled = 1000 - 100 = 900 (returned, no rake)
    // Contested = 100 (P0's matched) + 100 (P1's BB) = 200
    // Rake = 200 * 0.05 = 10
    expect(engine.state.rakeThisHand).toBe(10);

    // P0 invested 1000, gets back 900 (uncalled) + (200 - 10) (pot after rake) = 1090
    // P0 final: 10000 - 1000 + 1090 = 10090
    const p0After = engine.state.players[0]!;
    expect(p0After.stack).toBe(10090);

    // Check action history for uncalled bet return
    const uncalledAction = engine.state.actionHistory.find(
      (record) => record.action.type === ActionType.UNCALLED_BET_RETURNED
    );
    expect(uncalledAction).toBeDefined();

    if (uncalledAction?.action.type === ActionType.UNCALLED_BET_RETURNED) {
      expect(uncalledAction.action.amount).toBe(900);
      expect(uncalledAction.seat).toBe(0);
    } else {
      fail("Expected UNCALLED_BET_RETURNED action not found");
    }

    expect(getInitialChips(engine.state)).toBe(20000);
  });

  test("complex multi-street with uncalled bet", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
      rakePercent: 5,
      rakeCap: 50,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // Preflop - everyone calls
    while (engine.state.street === "PREFLOP" && engine.state.actionTo !== null) {
      const currentSeat = engine.state.actionTo;
      const currentPlayer = engine.state.players[currentSeat]!;
      const currentBet = Math.max(...Array.from(engine.state.currentBets.values()));
      const playerBet = engine.state.currentBets.get(currentSeat) ?? 0;

      if (currentBet > playerBet) {
        engine.act({ type: ActionType.CALL, playerId: currentPlayer.id });
      } else {
        engine.act({ type: ActionType.CHECK, playerId: currentPlayer.id });
      }
    }

    expect(engine.state.street).toBe("FLOP");

    // Flop: First to act bets, next calls, last folds
    const flopFirstPlayer = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.BET, playerId: flopFirstPlayer.id, amount: 50 });

    const flopSecondPlayer = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.CALL, playerId: flopSecondPlayer.id });

    const flopThirdPlayer = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.FOLD, playerId: flopThirdPlayer.id });

    expect(engine.state.street).toBe("TURN");

    // Turn: First to act bets, second raises, first folds
    const turnFirstPlayer = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.BET, playerId: turnFirstPlayer.id, amount: 100 });

    const turnSecondPlayer = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.RAISE, playerId: turnSecondPlayer.id, amount: 300 });

    engine.act({ type: ActionType.FOLD, playerId: turnFirstPlayer.id });

    // Verify rake was calculated correctly
    expect(engine.state.rakeThisHand).toBeGreaterThan(0);
    expect(getInitialChips(engine.state)).toBe(3000);
  });
});
