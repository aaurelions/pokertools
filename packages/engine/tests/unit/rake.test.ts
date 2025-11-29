import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

/**
 * Helper to play through to showdown by checking/calling
 */
function playToShowdown(engine: PokerEngine, maxActions = 20): void {
  let actionCount = 0;
  while (engine.state.street !== "SHOWDOWN" && actionCount < maxActions) {
    if (engine.state.actionTo === null) break;

    const player = engine.state.players[engine.state.actionTo!]!;
    const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
    const playerBet = engine.state.currentBets.get(engine.state.actionTo!) || 0;

    try {
      if (currentBet > playerBet) {
        engine.act({
          type: ActionType.CALL,
          playerId: player.id,
        });
      } else {
        engine.act({
          type: ActionType.CHECK,
          playerId: player.id,
        });
      }
    } catch (_e) {
      break;
    }
    actionCount++;
  }
}

describe("Rake", () => {
  test("rake is collected from cash game pot at showdown", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      rakePercent: 5, // 5% rake
      rakeCap: 10,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();
    playToShowdown(engine);

    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.winners).not.toBeNull();

    // Pot is 20 (blinds), rake should be 20 * 0.05 = 1
    expect(engine.state.rakeThisHand).toBe(1);

    // Chip conservation
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("rake cap is enforced", () => {
    const engine = new PokerEngine({
      smallBlind: 50,
      bigBlind: 100,
      maxPlayers: 2,
      rakePercent: 10, // 10% rake
      rakeCap: 15, // Cap at 15 chips
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();
    playToShowdown(engine);

    // Pot is 200 (blinds), 10% would be 20, but capped at 15
    expect(engine.state.rakeThisHand).toBe(15);

    // Chip conservation
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("no rake for tournaments", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 2,
      rakePercent: 5,
      rakeCap: 10,
      blindStructure: [
        { smallBlind: 10, bigBlind: 20, ante: 0 },
        { smallBlind: 20, bigBlind: 40, ante: 0 },
      ],
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();
    playToShowdown(engine);

    // No rake in tournaments
    expect(engine.state.rakeThisHand).toBe(0);

    // Winner gets full pot
    const winnerAmount = engine.state.winners!.reduce((sum, w) => sum + w.amount, 0);
    expect(winnerAmount).toBeGreaterThan(0);

    // Chip conservation
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("rake is reset each hand", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      rakePercent: 5,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Hand 1
    engine.deal();
    playToShowdown(engine);

    const rakeHand1 = engine.state.rakeThisHand;
    expect(rakeHand1).toBeGreaterThan(0);

    // Hand 2
    engine.deal();
    expect(engine.state.rakeThisHand).toBe(0); // Reset

    playToShowdown(engine);
    expect(engine.state.rakeThisHand).toBeGreaterThan(0);
  });

  test("rake with zero percent is not collected", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      rakePercent: 0,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();
    playToShowdown(engine);

    expect(engine.state.rakeThisHand).toBe(0);

    // Chip conservation
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("no rake when not configured", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      // No rakePercent configured
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    engine.deal();
    playToShowdown(engine);

    expect(engine.state.rakeThisHand).toBe(0);
  });
});
