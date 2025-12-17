import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import {
  createSnapshot,
  restoreFromSnapshot,
  serializeSnapshot,
  deserializeSnapshot,
  validateSnapshot,
  Snapshot,
} from "../../src/utils/serialization";

describe("Serialization - Snapshot Functions", () => {
  describe("createSnapshot", () => {
    test("should create JSON-serializable snapshot from game state", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);

      expect(snapshot).toBeDefined();
      expect(snapshot.handId).toBe(engine.state.handId);
      expect(snapshot.players).toEqual(engine.state.players);
      expect(snapshot.maxPlayers).toBe(2);
      expect(snapshot.smallBlind).toBe(5);
      expect(snapshot.bigBlind).toBe(10);
    });

    test("should convert Maps to plain objects", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);

      // currentBets should be plain object
      expect(snapshot.currentBets).toBeInstanceOf(Object);
      expect(snapshot.currentBets).not.toBeInstanceOf(Map);

      // timeBanks should be plain object
      expect(snapshot.timeBanks).toBeInstanceOf(Object);
      expect(snapshot.timeBanks).not.toBeInstanceOf(Map);
    });

    test("should truncate previous states to last 10", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      // Make several actions to create history
      for (let i = 0; i < 15; i++) {
        try {
          if (engine.state.actionTo === null) break;
          const player = engine.state.players[engine.state.actionTo]!;
          engine.act({
            type: ActionType.CHECK,
            playerId: player.id,
          });
        } catch (_e) {
          break;
        }
      }

      const snapshot = createSnapshot(engine.state);

      // Should have at most 10 previous states
      expect(snapshot.previousStates.length).toBeLessThanOrEqual(10);
    });

    test("should preserve all critical state fields", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        ante: 1,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);

      expect(snapshot.config).toEqual(engine.state.config);
      expect(snapshot.handNumber).toBe(engine.state.handNumber);
      expect(snapshot.buttonSeat).toBe(engine.state.buttonSeat);
      expect(snapshot.deck).toEqual(Array.from(engine.state.deck));
      expect(snapshot.board).toEqual(Array.from(engine.state.board));
      expect(snapshot.street).toBe(engine.state.street);
      expect(snapshot.pots).toEqual(Array.from(engine.state.pots));
      expect(snapshot.minRaise).toBe(engine.state.minRaise);
      expect(snapshot.lastRaiseAmount).toBe(engine.state.lastRaiseAmount);
      expect(snapshot.actionTo).toBe(engine.state.actionTo);
      expect(snapshot.lastAggressorSeat).toBe(engine.state.lastAggressorSeat);
      expect(snapshot.activePlayers).toEqual(Array.from(engine.state.activePlayers));
      expect(snapshot.rakeThisHand).toBe(engine.state.rakeThisHand);
      expect(snapshot.ante).toBe(engine.state.ante);
      expect(snapshot.blindLevel).toBe(engine.state.blindLevel);
    });
  });

  describe("restoreFromSnapshot", () => {
    test("should restore game state from snapshot", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const restored = restoreFromSnapshot(snapshot);

      expect(restored.handId).toBe(engine.state.handId);
      expect(restored.players).toEqual(engine.state.players);
      expect(restored.maxPlayers).toBe(engine.state.maxPlayers);
      expect(restored.smallBlind).toBe(engine.state.smallBlind);
      expect(restored.bigBlind).toBe(engine.state.bigBlind);
    });

    test("should convert plain objects back to Maps", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const restored = restoreFromSnapshot(snapshot);

      // currentBets should be Map
      expect(restored.currentBets).toBeInstanceOf(Map);
      expect(restored.currentBets.get(0)).toBeDefined();

      // timeBanks should be Map
      expect(restored.timeBanks).toBeInstanceOf(Map);
    });

    test("should handle missing rakeThisHand field", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      // Remove rakeThisHand to simulate old snapshot format
      delete (snapshot as any).rakeThisHand;

      const restored = restoreFromSnapshot(snapshot);

      expect(restored.rakeThisHand).toBe(0);
    });

    test("should restore previous states recursively", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      // Make some actions
      for (let i = 0; i < 5; i++) {
        try {
          if (engine.state.actionTo === null) break;
          const player = engine.state.players[engine.state.actionTo]!;
          engine.act({
            type: ActionType.CHECK,
            playerId: player.id,
          });
        } catch (_e) {
          break;
        }
      }

      const snapshot = createSnapshot(engine.state);
      const restored = restoreFromSnapshot(snapshot);

      expect(restored.previousStates.length).toBe(snapshot.previousStates.length);
      for (const prevState of restored.previousStates) {
        expect(prevState.currentBets).toBeInstanceOf(Map);
        expect(prevState.timeBanks).toBeInstanceOf(Map);
      }
    });
  });

  describe("serializeSnapshot and deserializeSnapshot", () => {
    test("should serialize snapshot to JSON string", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const json = serializeSnapshot(snapshot);

      expect(typeof json).toBe("string");
      expect(json.length).toBeGreaterThan(0);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    test("should deserialize JSON string to snapshot", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const json = serializeSnapshot(snapshot);
      const deserialized = deserializeSnapshot(json);

      expect(deserialized.handId).toBe(snapshot.handId);
      expect(deserialized.players).toEqual(snapshot.players);
      expect(deserialized.maxPlayers).toBe(snapshot.maxPlayers);
    });

    test("should roundtrip serialize and deserialize", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const json = serializeSnapshot(snapshot);
      const deserialized = deserializeSnapshot(json);
      const restored = restoreFromSnapshot(deserialized);

      expect(restored.handId).toBe(engine.state.handId);
      expect(restored.players).toEqual(engine.state.players);
      expect(restored.currentBets).toBeInstanceOf(Map);
      expect(restored.timeBanks).toBeInstanceOf(Map);
    });
  });

  describe("validateSnapshot", () => {
    test("should validate correct snapshot", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.deal();

      const snapshot = createSnapshot(engine.state);
      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(true);
    });

    test("should reject snapshot without handId", () => {
      const snapshot = {
        handId: "",
        maxPlayers: 2,
        players: [null, null],
      } as Snapshot;

      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(false);
    });

    test("should reject snapshot with invalid maxPlayers", () => {
      const snapshot = {
        handId: "test-hand-123",
        maxPlayers: 1, // Too few
        players: [null],
      } as Snapshot;

      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(false);
    });

    test("should reject snapshot with too many maxPlayers", () => {
      const snapshot = {
        handId: "test-hand-123",
        maxPlayers: 11, // Too many
        players: new Array(11).fill(null),
      } as Snapshot;

      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(false);
    });

    test("should reject snapshot with mismatched players array length", () => {
      const snapshot = {
        handId: "test-hand-123",
        maxPlayers: 4,
        players: [null, null], // Length doesn't match maxPlayers
      } as Snapshot;

      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(false);
    });

    test("should handle exceptions gracefully", () => {
      const snapshot = null as any;

      const isValid = validateSnapshot(snapshot);

      expect(isValid).toBe(false);
    });
  });

  describe("Full integration test", () => {
    test("should create, serialize, deserialize, restore, and validate", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 3,
        ante: 1,
      });

      engine.sit(0, "p0", "Player0", 1000);
      engine.sit(1, "p1", "Player1", 1000);
      engine.sit(2, "p2", "Player2", 1000);
      engine.deal();

      // Make some actions
      engine.act({ type: ActionType.CALL, playerId: engine.state.players[0]!.id });

      const originalHandId = engine.state.handId;

      // Create snapshot
      const snapshot = createSnapshot(engine.state);
      expect(validateSnapshot(snapshot)).toBe(true);

      // Serialize
      const json = serializeSnapshot(snapshot);
      expect(json.length).toBeGreaterThan(0);

      // Deserialize
      const deserialized = deserializeSnapshot(json);
      expect(validateSnapshot(deserialized)).toBe(true);

      // Restore
      const restored = restoreFromSnapshot(deserialized);

      // Verify
      expect(restored.handId).toBe(originalHandId);
      expect(restored.players.length).toBe(3);
      expect(restored.currentBets).toBeInstanceOf(Map);
      expect(restored.timeBanks).toBeInstanceOf(Map);
      expect(restored.smallBlind).toBe(5);
      expect(restored.bigBlind).toBe(10);
      expect(restored.ante).toBe(1);
    });
  });
});
