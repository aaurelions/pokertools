import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

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

describe("shownCards State Hygiene", () => {
  test("shownCards is reset on new deal", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Hand 1: Play to showdown
    // Ensure we don't get a split pot (which has no loser)
    // We re-deal until we have a distinct winner
    do {
      engine.deal();
      playToShowdown(engine);
    } while (engine.state.winners && engine.state.winners.length > 1);

    // Should be at showdown
    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.winners).not.toBeNull();

    // Winner should have shownCards set
    const winner = engine.state.winners![0];
    const winnerPlayer = engine.state.players[winner.seat]!;
    expect(winnerPlayer.shownCards).toEqual([0, 1]);

    // Loser should have shownCards set to null (mucked)
    const loserSeat = winner.seat === 0 ? 1 : 0;
    const loserPlayer = engine.state.players[loserSeat]!;
    expect(loserPlayer.shownCards).toBe(null);

    // Hand 2: Start new hand
    engine.deal();

    // Both players should have shownCards reset to null for the new hand
    expect(engine.state.players[0]!.shownCards).toBe(null);
    expect(engine.state.players[1]!.shownCards).toBe(null);

    // Players should have hands dealt
    expect(engine.state.players[0]!.hand).not.toBe(null);
    expect(engine.state.players[0]!.hand?.length).toBe(2);
    expect(engine.state.players[1]!.hand).not.toBe(null);
    expect(engine.state.players[1]!.hand?.length).toBe(2);
  });

  test("shownCards persists within a hand after SHOW action", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Ensure we don't get a split pot (which has no loser)
    // We re-deal until we have a distinct winner
    do {
      engine.deal();
      playToShowdown(engine);
    } while (engine.state.winners && engine.state.winners.length > 1);

    // Find loser
    const winner = engine.state.winners![0];
    const loserSeat = winner.seat === 0 ? 1 : 0;
    const loser = engine.state.players[loserSeat]!;

    // Loser should be mucked initially
    expect(loser.shownCards).toBe(null);

    // Loser shows cards
    engine.act({
      type: ActionType.SHOW,
      playerId: loser.id,
    });

    // Loser should now have shownCards set
    const loserAfterShow = engine.state.players[loserSeat]!;
    expect(loserAfterShow.shownCards).toEqual([0, 1]);

    // shownCards should persist until next deal
    expect(engine.state.players[loserSeat]!.shownCards).toEqual([0, 1]);

    // New hand
    engine.deal();

    // shownCards should be reset
    expect(engine.state.players[loserSeat]!.shownCards).toBe(null);
  });

  test("shownCards supports granular showing", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Ensure we don't get a split pot (which has no loser)
    // We re-deal until we have a distinct winner
    do {
      engine.deal();
      playToShowdown(engine);
    } while (engine.state.winners && engine.state.winners.length > 1);

    // Find loser
    const winner = engine.state.winners![0];
    const loserSeat = winner.seat === 0 ? 1 : 0;
    const loser = engine.state.players[loserSeat]!;

    // Show only left card (index 0)
    engine.act({
      type: ActionType.SHOW,
      playerId: loser.id,
      cardIndices: [0],
    });

    const loserAfterShow = engine.state.players[loserSeat]!;
    expect(loserAfterShow.shownCards).toEqual([0]);

    // Show the right card too
    engine.act({
      type: ActionType.SHOW,
      playerId: loser.id,
      cardIndices: [0, 1],
    });

    const loserAfterBothShown = engine.state.players[loserSeat]!;
    expect(loserAfterBothShown.shownCards).toEqual([0, 1]);
  });
});
