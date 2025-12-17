import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus, Street } from "@pokertools/types";
import { IllegalActionError } from "../../src/errors/IllegalActionError";

/**
 * Helper to play through to showdown by checking/calling
 */
function playToShowdown(engine: PokerEngine, maxActions = 20): void {
  let actionCount = 0;
  while (engine.state.street !== Street.SHOWDOWN && actionCount < maxActions) {
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

describe("Showdown Actions - SHOW and MUCK", () => {
  describe("SHOW action", () => {
    test("should allow player to show cards at showdown", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      // Get to showdown
      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      expect(engine.state.street).toBe(Street.SHOWDOWN);

      // Find loser
      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      // Loser should be mucked initially
      expect(loser.shownCards).toBe(null);

      // Show cards
      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
      });

      const updatedLoser = engine.state.players[loserSeat]!;
      expect(updatedLoser.shownCards).toEqual([0, 1]);
    });

    test("should show specific card indices", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      // Show only first card
      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
        cardIndices: [0],
      });

      const updatedLoser = engine.state.players[loserSeat]!;
      expect(updatedLoser.shownCards).toEqual([0]);
    });

    test("should filter invalid card indices", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      // Try to show invalid indices (out of bounds)
      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
        cardIndices: [5, 10, -1],
      });

      // Should do nothing since all indices are invalid
      const updatedLoser = engine.state.players[loserSeat]!;
      expect(updatedLoser.shownCards).toBe(null);
    });

    test("should throw error if player not found", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: "non-existent",
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: "non-existent",
        });
      }).toThrow("Player non-existent not found");
    });

    test("should throw error if not at showdown", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const player = engine.state.players[0]!;

      expect(engine.state.street).not.toBe(Street.SHOWDOWN);

      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: player.id,
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: player.id,
        });
      }).toThrow("Can only show cards at showdown");
    });

    test("should throw error if player has folded", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      const player0 = engine.state.players[0]!;

      // Player 0 folds
      engine.act({
        type: ActionType.FOLD,
        playerId: player0.id,
      });

      // Play to showdown with remaining players
      playToShowdown(engine);

      expect(engine.state.street).toBe(Street.SHOWDOWN);
      expect(engine.state.players[0]!.status).toBe(PlayerStatus.FOLDED);

      // Folded player cannot show
      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: player0.id,
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.SHOW,
          playerId: player0.id,
        });
      }).toThrow("Cannot show cards after folding");
    });

    test("should record action in history", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      const historyLengthBefore = engine.state.actionHistory.length;

      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
      });

      expect(engine.state.actionHistory.length).toBe(historyLengthBefore + 1);
      const lastAction = engine.state.actionHistory[engine.state.actionHistory.length - 1];
      expect(lastAction.action.type).toBe(ActionType.SHOW);
      expect(lastAction.seat).toBe(loserSeat);
    });
  });

  describe("MUCK action", () => {
    test("should allow loser to muck cards at showdown", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      // Initially mucked
      expect(loser.shownCards).toBe(null);

      // First show
      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
      });

      expect(engine.state.players[loserSeat]!.shownCards).toEqual([0, 1]);

      // Then muck
      engine.act({
        type: ActionType.MUCK,
        playerId: loser.id,
      });

      const updatedLoser = engine.state.players[loserSeat]!;
      expect(updatedLoser.shownCards).toBe(null);
      expect(updatedLoser.hand).not.toBe(null); // Hand is preserved
    });

    test("should throw error if player not found", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: "non-existent",
        });
      }).toThrow(IllegalActionError);
    });

    test("should throw error if not at showdown", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const player = engine.state.players[0]!;

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: player.id,
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: player.id,
        });
      }).toThrow("Can only muck cards at showdown");
    });

    test("should throw error if player has folded", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      const player0 = engine.state.players[0]!;

      engine.act({
        type: ActionType.FOLD,
        playerId: player0.id,
      });

      playToShowdown(engine);

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: player0.id,
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: player0.id,
        });
      }).toThrow("Cannot muck cards after folding");
    });

    test("should throw error if winner tries to muck", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const winnerPlayer = engine.state.players[winner.seat]!;

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: winnerPlayer.id,
        });
      }).toThrow(IllegalActionError);

      expect(() => {
        engine.act({
          type: ActionType.MUCK,
          playerId: winnerPlayer.id,
        });
      }).toThrow("Winners cannot muck");
    });

    test("should record action in history", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      do {
        engine.deal();
        playToShowdown(engine);
      } while (engine.state.winners && engine.state.winners.length > 1);

      const winner = engine.state.winners![0];
      const loserSeat = winner.seat === 0 ? 1 : 0;
      const loser = engine.state.players[loserSeat]!;

      // Show first
      engine.act({
        type: ActionType.SHOW,
        playerId: loser.id,
      });

      const historyLengthBefore = engine.state.actionHistory.length;

      engine.act({
        type: ActionType.MUCK,
        playerId: loser.id,
      });

      expect(engine.state.actionHistory.length).toBe(historyLengthBefore + 1);
      const lastAction = engine.state.actionHistory[engine.state.actionHistory.length - 1];
      expect(lastAction.action.type).toBe(ActionType.MUCK);
      expect(lastAction.seat).toBe(loserSeat);
    });
  });
});
