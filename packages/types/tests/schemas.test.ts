/**
 * Tests for Zod schemas alignment with TypeScript interfaces
 *
 * These tests verify that Zod schemas correctly validate data
 * according to their TypeScript interface counterparts.
 */

import {
  SitActionSchema,
  ReserveSeatActionSchema,
  TimeoutActionSchema,
  ActionSchema,
  UncalledBetReturnedActionSchema,
  TableConfigSchema,
  CreateTableSchema,
  BuyInRequestSchema,
  GameActionRequestSchema,
} from "../src/schemas";

describe("Action Schemas", () => {
  describe("SitActionSchema", () => {
    test("accepts valid SIT action without sitInOption", () => {
      const action = {
        type: "SIT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        stack: 1000,
      };

      const result = SitActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    test("accepts valid SIT action with sitInOption IMMEDIATE", () => {
      const action = {
        type: "SIT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        stack: 1000,
        sitInOption: "IMMEDIATE",
      };

      const result = SitActionSchema.safeParse(action);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sitInOption).toBe("IMMEDIATE");
      }
    });

    test("accepts valid SIT action with sitInOption WAIT_FOR_BB", () => {
      const action = {
        type: "SIT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        stack: 1000,
        sitInOption: "WAIT_FOR_BB",
      };

      const result = SitActionSchema.safeParse(action);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sitInOption).toBe("WAIT_FOR_BB");
      }
    });

    test("rejects invalid sitInOption value", () => {
      const action = {
        type: "SIT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        stack: 1000,
        sitInOption: "INVALID",
      };

      const result = SitActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });
  });

  describe("ReserveSeatActionSchema", () => {
    test("accepts valid RESERVE_SEAT action with expiryTimestamp", () => {
      const action = {
        type: "RESERVE_SEAT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        expiryTimestamp: Date.now() + 30000,
      };

      const result = ReserveSeatActionSchema.safeParse(action);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expiryTimestamp).toBeGreaterThan(0);
      }
    });

    test("rejects RESERVE_SEAT action without expiryTimestamp", () => {
      const invalidAction = {
        type: "RESERVE_SEAT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        // Missing expiryTimestamp
      };

      const result = ReserveSeatActionSchema.safeParse(invalidAction);
      expect(result.success).toBe(false);
    });

    test("rejects RESERVE_SEAT action with non-positive expiryTimestamp", () => {
      const invalidAction = {
        type: "RESERVE_SEAT",
        playerId: "player1",
        playerName: "Alice",
        seat: 0,
        expiryTimestamp: 0,
      };

      const result = ReserveSeatActionSchema.safeParse(invalidAction);
      expect(result.success).toBe(false);
    });
  });

  describe("TimeoutActionSchema", () => {
    test("accepts TIMEOUT action without timestamp (optional)", () => {
      const action = {
        type: "TIMEOUT",
        playerId: "player1",
      };

      const result = TimeoutActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    test("accepts TIMEOUT action with timestamp", () => {
      const action = {
        type: "TIMEOUT",
        playerId: "player1",
        timestamp: Date.now(),
      };

      const result = TimeoutActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    test("rejects TIMEOUT action with invalid timestamp", () => {
      const action = {
        type: "TIMEOUT",
        playerId: "player1",
        timestamp: -1,
      };

      const result = TimeoutActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });
  });

  describe("UncalledBetReturnedActionSchema", () => {
    test("accepts valid UNCALLED_BET_RETURNED action", () => {
      const action = {
        type: "UNCALLED_BET_RETURNED",
        playerId: "player1",
        amount: 100,
      };

      const result = UncalledBetReturnedActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    test("rejects UNCALLED_BET_RETURNED without amount", () => {
      const action = {
        type: "UNCALLED_BET_RETURNED",
        playerId: "player1",
      };

      const result = UncalledBetReturnedActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });

    test("rejects UNCALLED_BET_RETURNED with zero amount", () => {
      const action = {
        type: "UNCALLED_BET_RETURNED",
        playerId: "player1",
        amount: 0,
      };

      const result = UncalledBetReturnedActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });
  });

  describe("ActionSchema union", () => {
    test("accepts UNCALLED_BET_RETURNED in union", () => {
      const action = {
        type: "UNCALLED_BET_RETURNED",
        playerId: "player1",
        amount: 100,
      };

      const result = ActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    });

    test("accepts all standard actions", () => {
      const actions = [
        { type: "FOLD", playerId: "p1" },
        { type: "CHECK", playerId: "p1" },
        { type: "CALL", playerId: "p1" },
        { type: "BET", playerId: "p1", amount: 100 },
        { type: "RAISE", playerId: "p1", amount: 200 },
        { type: "DEAL" },
        { type: "SHOW", playerId: "p1" },
        { type: "MUCK", playerId: "p1" },
        { type: "TIME_BANK", playerId: "p1" },
        { type: "TIMEOUT", playerId: "p1" },
        { type: "NEXT_BLIND_LEVEL" },
        { type: "STAND", playerId: "p1" },
        {
          type: "SIT",
          playerId: "p1",
          playerName: "Test",
          seat: 0,
          stack: 1000,
        },
        { type: "ADD_CHIPS", playerId: "p1", amount: 500 },
        {
          type: "RESERVE_SEAT",
          playerId: "p1",
          playerName: "Test",
          seat: 0,
          expiryTimestamp: Date.now() + 30000,
        },
      ];

      for (const action of actions) {
        const result = ActionSchema.safeParse(action);
        expect(result.success).toBe(true);
      }
    });

    test("rejects unknown action type", () => {
      const action = {
        type: "UNKNOWN_ACTION",
        playerId: "p1",
      };

      const result = ActionSchema.safeParse(action);
      expect(result.success).toBe(false);
    });
  });
});

describe("Table Configuration Schemas", () => {
  describe("TableConfigSchema", () => {
    test("accepts valid config", () => {
      const config = {
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 9,
      };

      const result = TableConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    test("rejects when bigBlind <= smallBlind", () => {
      const config = {
        smallBlind: 10,
        bigBlind: 10,
        maxPlayers: 9,
      };

      const result = TableConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    test("rejects maxPlayers < 2", () => {
      const config = {
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 1,
      };

      const result = TableConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    test("rejects maxPlayers > 10", () => {
      const config = {
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 11,
      };

      const result = TableConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    test("accepts optional fields", () => {
      const config = {
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
        ante: 1,
        rakePercent: 5,
        rakeCap: 100,
        timeBankSeconds: 30,
        timeBankDeductionSeconds: 10,
      };

      const result = TableConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  describe("CreateTableSchema", () => {
    test("accepts valid create table request", () => {
      const request = {
        name: "Table 1",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
      };

      const result = CreateTableSchema.safeParse(request);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxPlayers).toBe(9); // default
      }
    });

    test("accepts TOURNAMENT mode", () => {
      const request = {
        name: "Tournament 1",
        mode: "TOURNAMENT",
        smallBlind: 25,
        bigBlind: 50,
        maxPlayers: 6,
      };

      const result = CreateTableSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("rejects invalid mode", () => {
      const request = {
        name: "Table 1",
        mode: "INVALID",
        smallBlind: 5,
        bigBlind: 10,
      };

      const result = CreateTableSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    test("validates minBuyIn/maxBuyIn relationship", () => {
      const invalidRequest = {
        name: "Table 1",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        minBuyIn: 1000,
        maxBuyIn: 500, // Less than minBuyIn
      };

      const result = CreateTableSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });
});

describe("API Request Schemas", () => {
  describe("BuyInRequestSchema", () => {
    test("accepts valid buy-in request", () => {
      const request = {
        amount: 1000,
        seat: 0,
        idempotencyKey: "unique-key-123",
      };

      const result = BuyInRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("accepts buy-in with sitInOption", () => {
      const request = {
        amount: 1000,
        seat: 0,
        idempotencyKey: "unique-key-123",
        sitInOption: "WAIT_FOR_BB",
      };

      const result = BuyInRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("rejects missing idempotencyKey", () => {
      const request = {
        amount: 1000,
        seat: 0,
      };

      const result = BuyInRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  describe("GameActionRequestSchema", () => {
    test("accepts action with amount", () => {
      const request = {
        type: "RAISE",
        amount: 200,
      };

      const result = GameActionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("accepts action without amount", () => {
      const request = {
        type: "FOLD",
      };

      const result = GameActionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("accepts SHOW with cardIndices", () => {
      const request = {
        type: "SHOW",
        cardIndices: [0, 1],
      };

      const result = GameActionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    test("rejects invalid cardIndices", () => {
      const request = {
        type: "SHOW",
        cardIndices: [0, 2], // 2 is invalid (max is 1)
      };

      const result = GameActionRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });
});

describe("Edge Cases", () => {
  describe("Seat validation", () => {
    test("accepts seat 0 (minimum)", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "Test",
        seat: 0,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(true);
    });

    test("accepts seat 9 (maximum)", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "Test",
        seat: 9,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(true);
    });

    test("rejects seat 10 (out of range)", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "Test",
        seat: 10,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects negative seat", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "Test",
        seat: -1,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects non-integer seat", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "Test",
        seat: 1.5,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(false);
    });
  });

  describe("Amount validation", () => {
    test("rejects zero amount", () => {
      const action = {
        type: "BET",
        playerId: "p1",
        amount: 0,
      };
      expect(ActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects negative amount", () => {
      const action = {
        type: "BET",
        playerId: "p1",
        amount: -100,
      };
      expect(ActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects non-integer amount", () => {
      const action = {
        type: "BET",
        playerId: "p1",
        amount: 100.5,
      };
      expect(ActionSchema.safeParse(action).success).toBe(false);
    });
  });

  describe("String validation", () => {
    test("rejects empty playerId", () => {
      const action = {
        type: "FOLD",
        playerId: "",
      };
      expect(ActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects empty playerName", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "",
        seat: 0,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(false);
    });

    test("rejects playerName over 50 characters", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "A".repeat(51),
        seat: 0,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(false);
    });

    test("accepts playerName of exactly 50 characters", () => {
      const action = {
        type: "SIT",
        playerId: "p1",
        playerName: "A".repeat(50),
        seat: 0,
        stack: 100,
      };
      expect(SitActionSchema.safeParse(action).success).toBe(true);
    });
  });
});
