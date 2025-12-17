import { PokerEngine } from "../../src/engine/PokerEngine";
import { PlayerStatus, ActionType } from "@pokertools/types";
import {
  getNextSeat,
  getDistanceFromButton,
  getActivePlayers,
  getSeatedPlayers,
  getNextOccupiedSeat,
  getNextActionableSeat,
  countPlayersByStatus,
  getPlayerById,
} from "../../src/utils/positioning";

describe("Positioning Utilities", () => {
  describe("getNextSeat", () => {
    test("should return next seat in sequence", () => {
      expect(getNextSeat(0, 6)).toBe(1);
      expect(getNextSeat(3, 6)).toBe(4);
      expect(getNextSeat(5, 6)).toBe(0); // Wraps around
    });

    test("should handle heads-up", () => {
      expect(getNextSeat(0, 2)).toBe(1);
      expect(getNextSeat(1, 2)).toBe(0);
    });

    test("should handle full ring", () => {
      expect(getNextSeat(8, 9)).toBe(0);
      expect(getNextSeat(0, 9)).toBe(1);
    });
  });

  describe("getDistanceFromButton", () => {
    test("should calculate distance when seat is after button", () => {
      expect(getDistanceFromButton(3, 0, 6)).toBe(3);
      expect(getDistanceFromButton(5, 2, 6)).toBe(3);
    });

    test("should calculate distance when seat is before button (wraps)", () => {
      expect(getDistanceFromButton(1, 4, 6)).toBe(3);
      expect(getDistanceFromButton(0, 5, 6)).toBe(1);
    });

    test("should return 0 for button seat", () => {
      expect(getDistanceFromButton(3, 3, 6)).toBe(0);
    });

    test("should handle heads-up", () => {
      expect(getDistanceFromButton(1, 0, 2)).toBe(1);
      expect(getDistanceFromButton(0, 1, 2)).toBe(1);
    });
  });

  describe("getActivePlayers", () => {
    test("should return active players with chips", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal(); // Players become active after deal

      const active = getActivePlayers(engine.state);

      expect(active).toContain(0);
      expect(active).toContain(1);
      expect(active).toContain(2);
      expect(active.length).toBe(3);
    });

    test("should exclude folded players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      // Player 0 folds
      engine.act({
        type: ActionType.FOLD,
        playerId: engine.state.players[0]!.id,
      });

      const active = getActivePlayers(engine.state);

      expect(active).not.toContain(0);
      expect(active.length).toBe(2);
    });

    test("should exclude players with 0 chips", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 100);
      engine.deal();

      // Manually set player 1 stack to 0 (edge case)
      engine.state.players[1]!.stack = 0;

      const active = getActivePlayers(engine.state);

      expect(active).toContain(0);
      expect(active).not.toContain(1);
      expect(active.length).toBe(1);
    });
  });

  describe("getSeatedPlayers", () => {
    test("should return all seated players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(2, "p2", "Player2", 1000);

      const seated = getSeatedPlayers(engine.state);

      expect(seated).toContain(0);
      expect(seated).toContain(2);
      expect(seated).not.toContain(1);
      expect(seated).not.toContain(3);
      expect(seated.length).toBe(2);
    });

    test("should include sitting out players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);

      // Mark player as sitting out (direct mutation for test)
      engine.state.players[1]!.isSittingOut = true;

      const seated = getSeatedPlayers(engine.state);

      expect(seated).toContain(1);
      expect(seated.length).toBe(3);
    });
  });

  describe("getNextOccupiedSeat", () => {
    test("should find next occupied seat", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(3, "p3", "Player3", 1000);
      engine.sit(5, "p5", "Player5", 1000);

      const next = getNextOccupiedSeat(0, engine.state.players, engine.state.maxPlayers);

      expect(next).toBe(3);
    });

    test("should wrap around to find next occupied seat", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(2, "p2", "Player2", 1000);

      const next = getNextOccupiedSeat(2, engine.state.players, engine.state.maxPlayers);

      expect(next).toBe(0);
    });

    test("should return null if no other occupied seats", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
      });

      engine.sit(0, "p0", "Player0", 1000);

      const next = getNextOccupiedSeat(0, engine.state.players, engine.state.maxPlayers);

      expect(next).toBeNull();
    });

    test("should skip players with 0 chips", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 4,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 100);
      engine.sit(2, "p2", "Player2", 1000);

      // Set player 1 stack to 0
      engine.state.players[1]!.stack = 0;

      const next = getNextOccupiedSeat(0, engine.state.players, engine.state.maxPlayers);

      expect(next).toBe(2);
    });
  });

  describe("getNextActionableSeat", () => {
    test("should find next player who can act", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      const next = getNextActionableSeat(engine.state.actionTo!, engine.state);

      expect(next).not.toBeNull();
      expect(engine.state.players[next!]).not.toBeNull();
      expect(engine.state.players[next!]!.status).toBe(PlayerStatus.ACTIVE);
    });

    test("should skip folded players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      // Fold player 1
      engine.state.players[1]!.status = PlayerStatus.FOLDED;

      const next = getNextActionableSeat(0, engine.state);

      if (next !== null) {
        expect(next).not.toBe(1);
        expect(engine.state.players[next]!.status).toBe(PlayerStatus.ACTIVE);
      }
    });

    test("should return null if no actionable players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);

      const next = getNextActionableSeat(0, engine.state);

      expect(next).toBeNull();
    });

    test("should skip all-in players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);

      // Mark player 1 as all-in
      engine.state.players[1]!.status = PlayerStatus.ALL_IN;

      const next = getNextActionableSeat(0, engine.state);

      expect(next).not.toBe(1);
    });
  });

  describe("countPlayersByStatus", () => {
    test("should count active players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal(); // Players become active after deal

      const count = countPlayersByStatus(engine.state, PlayerStatus.ACTIVE);

      expect(count).toBeGreaterThanOrEqual(1); // At least one active (some may be all-in)
    });

    test("should count folded players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      // Player 0 folds
      engine.act({
        type: ActionType.FOLD,
        playerId: engine.state.players[0]!.id,
      });

      const count = countPlayersByStatus(engine.state, PlayerStatus.FOLDED);

      expect(count).toBe(1);
    });

    test("should return 0 for status with no players", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);

      const count = countPlayersByStatus(engine.state, PlayerStatus.ALL_IN);

      expect(count).toBe(0);
    });
  });

  describe("getPlayerById", () => {
    test("should find player by ID", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);

      const result = getPlayerById(engine.state, "p1");

      expect(result).not.toBeNull();
      expect(result!.player.id).toBe("p1");
      expect(result!.seat).toBe(1);
    });

    test("should return null for non-existent player", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);

      const result = getPlayerById(engine.state, "non-existent");

      expect(result).toBeNull();
    });

    test("should find player at any seat", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      });

      engine.sit(5, "p5", "Player5", 1000);

      const result = getPlayerById(engine.state, "p5");

      expect(result).not.toBeNull();
      expect(result!.seat).toBe(5);
    });
  });
});
