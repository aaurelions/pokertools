import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus, Street } from "@pokertools/types";

describe("Special Actions - TIMEOUT and TIME_BANK", () => {
  describe("TIMEOUT action", () => {
    test("should fold player when they have bet to call", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      // Player 0 (UTG) times out with bet to call
      const player0 = engine.state.players[0]!;
      expect(engine.state.actionTo).toBe(0);

      engine.act({
        type: ActionType.TIMEOUT,
        playerId: player0.id,
      });

      // Player should be folded and sitting out
      const updatedPlayer = engine.state.players[0]!;
      expect(updatedPlayer.status).toBe(PlayerStatus.FOLDED);
      expect(updatedPlayer.isSittingOut).toBe(true);
      expect(engine.state.activePlayers).not.toContain(0);
    });

    test("should check and mark sitting out when no bet to call", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      // Player 0 calls
      engine.act({
        type: ActionType.CALL,
        playerId: engine.state.players[0]!.id,
      });

      // Player 1 checks
      engine.act({
        type: ActionType.CHECK,
        playerId: engine.state.players[1]!.id,
      });

      // Now on flop, player 1 has option to check
      expect(engine.state.street).toBe(Street.FLOP);
      const actionPlayer = engine.state.players[engine.state.actionTo!]!;

      // Get current bet (should be 0)
      const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      expect(currentBet).toBe(0);

      // Timeout when no bet to call
      engine.act({
        type: ActionType.TIMEOUT,
        playerId: actionPlayer.id,
      });

      // Player should NOT be folded but marked sitting out
      const updatedPlayer = engine.state.players.find((p) => p?.id === actionPlayer.id)!;
      expect(updatedPlayer.status).not.toBe(PlayerStatus.FOLDED);
      expect(updatedPlayer.isSittingOut).toBe(true);
      expect(engine.state.activePlayers).toContain(updatedPlayer.seat);
    });

    test("should throw error for non-existent player", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      // Try to timeout non-existent player - should throw
      expect(() => {
        engine.act({
          type: ActionType.TIMEOUT,
          playerId: "non-existent",
        });
      }).toThrow("Player non-existent not found");
    });

    test("should advance action to next player", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      const currentActionTo = engine.state.actionTo;
      const currentPlayer = engine.state.players[currentActionTo!]!;

      engine.act({
        type: ActionType.TIMEOUT,
        playerId: currentPlayer.id,
      });

      // Action should have moved to next player
      expect(engine.state.actionTo).not.toBe(currentActionTo);
      expect(engine.state.actionTo).not.toBeNull();
    });
  });

  describe("TIME_BANK action", () => {
    test("should deduct time from time bank and keep action on same player", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 60,
        timeBankDeductionSeconds: 10,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const actionSeat = engine.state.actionTo!;
      const player = engine.state.players[actionSeat]!;
      const initialTimeBank = engine.state.timeBanks.get(actionSeat) ?? 0;

      engine.act({
        type: ActionType.TIME_BANK,
        playerId: player.id,
      });

      // Time bank should be reduced
      const newTimeBank = engine.state.timeBanks.get(actionSeat) ?? 0;
      expect(newTimeBank).toBe(initialTimeBank - 10);

      // Action should still be on same player
      expect(engine.state.actionTo).toBe(actionSeat);
    });

    test("should force timeout when time bank is zero", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 0,
        timeBankDeductionSeconds: 10,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const actionSeat = engine.state.actionTo!;
      const player = engine.state.players[actionSeat]!;

      // Time bank is 0, so attempting to use it should timeout
      engine.act({
        type: ActionType.TIME_BANK,
        playerId: player.id,
      });

      // Player should be timed out (folded since there's bet to call)
      const updatedPlayer = engine.state.players[actionSeat]!;
      expect(updatedPlayer.status).toBe(PlayerStatus.FOLDED);
      expect(updatedPlayer.isSittingOut).toBe(true);
    });

    test("should handle zero time bank as exhausted", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 0,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const actionSeat = engine.state.actionTo!;
      const player = engine.state.players[actionSeat]!;

      engine.act({
        type: ActionType.TIME_BANK,
        playerId: player.id,
      });

      // Should be timed out
      const updatedPlayer = engine.state.players[actionSeat]!;
      expect(updatedPlayer.status).toBe(PlayerStatus.FOLDED);
      expect(updatedPlayer.isSittingOut).toBe(true);
    });

    test("should deplete time bank to zero minimum", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 5,
        timeBankDeductionSeconds: 10,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const actionSeat = engine.state.actionTo!;
      const player = engine.state.players[actionSeat]!;

      // Initial time bank is 5
      expect(engine.state.timeBanks.get(actionSeat)).toBe(5);

      // Use time bank (deduction is 10, but initial is only 5)
      // Since timebank is > 0 initially, it should deduct and go to 0
      engine.act({
        type: ActionType.TIME_BANK,
        playerId: player.id,
      });

      // Time bank should be 0 (not negative)
      expect(engine.state.timeBanks.get(actionSeat)).toBe(0);
    });

    test("should throw error for non-existent player", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 60,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      expect(() => {
        engine.act({
          type: ActionType.TIME_BANK,
          playerId: "non-existent",
        });
      }).toThrow("Player non-existent not found");
    });

    test("should use default deduction when not configured", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        timeBankSeconds: 60,
        // timeBankDeductionSeconds not set - should default to 10
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const actionSeat = engine.state.actionTo!;
      const player = engine.state.players[actionSeat]!;
      const initialTimeBank = engine.state.timeBanks.get(actionSeat) ?? 0;

      engine.act({
        type: ActionType.TIME_BANK,
        playerId: player.id,
      });

      // Should deduct default 10 seconds
      const newTimeBank = engine.state.timeBanks.get(actionSeat) ?? 0;
      expect(newTimeBank).toBe(initialTimeBank - 10);
    });
  });
});
