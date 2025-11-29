import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Chip Conservation Bug Debug", () => {
  test("reproduce 50-50 heads-up bug", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    // Two players with 50 chips each
    engine.sit(0, "p0", "Player0", 50);
    engine.sit(1, "p1", "Player1", 50);

    // Deal
    engine.deal();

    const initialChips = getInitialChips(engine.state);

    // Should be 100 (50+50)
    expect(initialChips).toBe(100);
  });

  test("reproduce with larger stacks", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 500);
    engine.sit(1, "p1", "Player1", 500);

    engine.deal();

    const initialChips = getInitialChips(engine.state);
    expect(initialChips).toBe(1000);
  });

  test("check if bug occurs after call", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 50);
    engine.sit(1, "p1", "Player1", 50);

    engine.deal();

    // Button/SB acts first in heads-up preflop
    const actionTo = engine.state.actionTo;
    const player = engine.state.players[actionTo!];

    if (player) {
      try {
        // Try to call
        engine.act({
          type: ActionType.CALL,
          playerId: player.id,
          timestamp: Date.now(),
        });
      } catch (_error) {
        // Expected to potentially fail
      }
    }
  });
});
