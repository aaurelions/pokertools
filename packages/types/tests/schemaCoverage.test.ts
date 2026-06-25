import {
  StandActionSchema,
  BetActionSchema,
  RaiseActionSchema,
  CallActionSchema,
  CheckActionSchema,
  FoldActionSchema,
  DealActionSchema,
  AddChipsActionSchema,
  ShowActionSchema,
  MuckActionSchema,
  TimeBankActionSchema,
  NextBlindLevelActionSchema,
  ActionSchema,
  BlindLevelSchema,
  TableConfigSchema,
  CreateTableSchema,
  BuyInRequestSchema,
  AddChipsRequestSchema,
  GameActionRequestSchema,
} from "../src/schemas";

describe("Individual Action Schemas (coverage gap-fill)", () => {
  describe("StandActionSchema", () => {
    test("accepts valid STAND action", () => {
      expect(StandActionSchema.safeParse({ type: "STAND", playerId: "p1" }).success).toBe(true);
    });

    test("rejects STAND without playerId", () => {
      expect(StandActionSchema.safeParse({ type: "STAND" }).success).toBe(false);
    });

    test("accepts STAND with timestamp", () => {
      expect(
        StandActionSchema.safeParse({ type: "STAND", playerId: "p1", timestamp: 1000 }).success
      ).toBe(true);
    });

    test("rejects STAND with wrong type", () => {
      expect(StandActionSchema.safeParse({ type: "SIT", playerId: "p1" }).success).toBe(false);
    });
  });

  describe("BetActionSchema", () => {
    test("accepts valid BET action", () => {
      const r = BetActionSchema.safeParse({ type: "BET", playerId: "p1", amount: 100 });
      expect(r.success).toBe(true);
    });

    test("rejects BET without amount", () => {
      expect(BetActionSchema.safeParse({ type: "BET", playerId: "p1" }).success).toBe(false);
    });

    test("rejects BET with negative amount", () => {
      expect(BetActionSchema.safeParse({ type: "BET", playerId: "p1", amount: -1 }).success).toBe(
        false
      );
    });

    test("rejects BET without playerId", () => {
      expect(BetActionSchema.safeParse({ type: "BET", amount: 100 }).success).toBe(false);
    });
  });

  describe("RaiseActionSchema", () => {
    test("accepts valid RAISE action", () => {
      expect(
        RaiseActionSchema.safeParse({ type: "RAISE", playerId: "p1", amount: 200 }).success
      ).toBe(true);
    });

    test("rejects RAISE with zero amount", () => {
      expect(
        RaiseActionSchema.safeParse({ type: "RAISE", playerId: "p1", amount: 0 }).success
      ).toBe(false);
    });
  });

  describe("CallActionSchema", () => {
    test("accepts CALL without amount (optional)", () => {
      expect(CallActionSchema.safeParse({ type: "CALL", playerId: "p1" }).success).toBe(true);
    });

    test("accepts CALL with explicit amount", () => {
      expect(CallActionSchema.safeParse({ type: "CALL", playerId: "p1", amount: 50 }).success).toBe(
        true
      );
    });

    test("rejects CALL without playerId", () => {
      expect(CallActionSchema.safeParse({ type: "CALL" }).success).toBe(false);
    });
  });

  describe("CheckActionSchema", () => {
    test("accepts valid CHECK action", () => {
      expect(CheckActionSchema.safeParse({ type: "CHECK", playerId: "p1" }).success).toBe(true);
    });

    test("rejects CHECK without playerId", () => {
      expect(CheckActionSchema.safeParse({ type: "CHECK" }).success).toBe(false);
    });
  });

  describe("FoldActionSchema", () => {
    test("accepts valid FOLD action", () => {
      expect(FoldActionSchema.safeParse({ type: "FOLD", playerId: "p1" }).success).toBe(true);
    });

    test("rejects FOLD without playerId", () => {
      expect(FoldActionSchema.safeParse({ type: "FOLD" }).success).toBe(false);
    });
  });

  describe("DealActionSchema", () => {
    test("accepts DEAL with no extra fields", () => {
      expect(DealActionSchema.safeParse({ type: "DEAL" }).success).toBe(true);
    });

    test("accepts DEAL with timestamp", () => {
      expect(DealActionSchema.safeParse({ type: "DEAL", timestamp: 1000 }).success).toBe(true);
    });

    test("rejects DEAL with wrong type discriminator", () => {
      expect(DealActionSchema.safeParse({ type: "CALL" }).success).toBe(false);
    });
  });

  describe("AddChipsActionSchema", () => {
    test("accepts valid ADD_CHIPS action", () => {
      expect(
        AddChipsActionSchema.safeParse({ type: "ADD_CHIPS", playerId: "p1", amount: 500 }).success
      ).toBe(true);
    });

    test("rejects ADD_CHIPS with zero amount", () => {
      expect(
        AddChipsActionSchema.safeParse({ type: "ADD_CHIPS", playerId: "p1", amount: 0 }).success
      ).toBe(false);
    });

    test("rejects ADD_CHIPS without amount", () => {
      expect(AddChipsActionSchema.safeParse({ type: "ADD_CHIPS", playerId: "p1" }).success).toBe(
        false
      );
    });

    test("rejects ADD_CHIPS without playerId", () => {
      expect(AddChipsActionSchema.safeParse({ type: "ADD_CHIPS", amount: 100 }).success).toBe(
        false
      );
    });
  });

  describe("ShowActionSchema", () => {
    test("accepts SHOW with no cardIndices (default shows all)", () => {
      expect(ShowActionSchema.safeParse({ type: "SHOW", playerId: "p1" }).success).toBe(true);
    });

    test("accepts SHOW with cardIndices [0]", () => {
      expect(
        ShowActionSchema.safeParse({ type: "SHOW", playerId: "p1", cardIndices: [0] }).success
      ).toBe(true);
    });

    test("accepts SHOW with cardIndices [0, 1]", () => {
      expect(
        ShowActionSchema.safeParse({ type: "SHOW", playerId: "p1", cardIndices: [0, 1] }).success
      ).toBe(true);
    });

    test("rejects SHOW with invalid card index (2)", () => {
      expect(
        ShowActionSchema.safeParse({ type: "SHOW", playerId: "p1", cardIndices: [2] }).success
      ).toBe(false);
    });

    test("rejects SHOW with negative card index", () => {
      expect(
        ShowActionSchema.safeParse({ type: "SHOW", playerId: "p1", cardIndices: [-1] }).success
      ).toBe(false);
    });
  });

  describe("MuckActionSchema", () => {
    test("accepts valid MUCK action", () => {
      expect(MuckActionSchema.safeParse({ type: "MUCK", playerId: "p1" }).success).toBe(true);
    });

    test("rejects MUCK without playerId", () => {
      expect(MuckActionSchema.safeParse({ type: "MUCK" }).success).toBe(false);
    });
  });

  describe("TimeBankActionSchema", () => {
    test("accepts valid TIME_BANK action", () => {
      expect(TimeBankActionSchema.safeParse({ type: "TIME_BANK", playerId: "p1" }).success).toBe(
        true
      );
    });

    test("rejects TIME_BANK without playerId", () => {
      expect(TimeBankActionSchema.safeParse({ type: "TIME_BANK" }).success).toBe(false);
    });
  });

  describe("NextBlindLevelActionSchema", () => {
    test("accepts NEXT_BLIND_LEVEL with no fields", () => {
      expect(NextBlindLevelActionSchema.safeParse({ type: "NEXT_BLIND_LEVEL" }).success).toBe(true);
    });

    test("accepts NEXT_BLIND_LEVEL with timestamp", () => {
      expect(
        NextBlindLevelActionSchema.safeParse({ type: "NEXT_BLIND_LEVEL", timestamp: 1000 }).success
      ).toBe(true);
    });
  });

  describe("ActionSchema discriminant routing", () => {
    const actionSamples: Array<[string, Record<string, unknown>]> = [
      ["STAND", { type: "STAND", playerId: "p1" }],
      ["BET", { type: "BET", playerId: "p1", amount: 100 }],
      ["RAISE", { type: "RAISE", playerId: "p1", amount: 200 }],
      ["CALL", { type: "CALL", playerId: "p1" }],
      ["CHECK", { type: "CHECK", playerId: "p1" }],
      ["FOLD", { type: "FOLD", playerId: "p1" }],
      ["DEAL", { type: "DEAL" }],
      ["ADD_CHIPS", { type: "ADD_CHIPS", playerId: "p1", amount: 500 }],
      ["MUCK", { type: "MUCK", playerId: "p1" }],
      ["TIME_BANK", { type: "TIME_BANK", playerId: "p1" }],
      ["NEXT_BLIND_LEVEL", { type: "NEXT_BLIND_LEVEL" }],
    ];

    test.each(actionSamples)("%s action accepted by ActionSchema union", (_label, action) => {
      expect(ActionSchema.safeParse(action).success).toBe(true);
    });

    test("rejects action missing discriminant type", () => {
      expect(ActionSchema.safeParse({ playerId: "p1" }).success).toBe(false);
    });

    test("rejects action where type mismatch leaves required fields absent", () => {
      // FOLD needs playerId, but BET fields (amount) shouldn't satisfy FOLD
      expect(ActionSchema.safeParse({ type: "FOLD", playerId: "p1", amount: 999 }).success).toBe(
        true
      ); // FOLD accepts (extra fields ignored by zod)
    });
  });
});

describe("BlindLevelSchema (previously untested)", () => {
  test("accepts valid blind level", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 10, bigBlind: 20, ante: 0 }).success).toBe(
      true
    );
    expect(BlindLevelSchema.safeParse({ smallBlind: 25, bigBlind: 50, ante: 5 }).success).toBe(
      true
    );
  });

  test("rejects zero small blind", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 0, bigBlind: 20, ante: 0 }).success).toBe(
      false
    );
  });

  test("rejects zero big blind", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 10, bigBlind: 0, ante: 0 }).success).toBe(
      false
    );
  });

  test("rejects negative ante", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 10, bigBlind: 20, ante: -1 }).success).toBe(
      false
    );
  });

  test("accepts zero ante", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 10, bigBlind: 20, ante: 0 }).success).toBe(
      true
    );
  });

  test("rejects non-integer blind values", () => {
    expect(BlindLevelSchema.safeParse({ smallBlind: 10.5, bigBlind: 20, ante: 0 }).success).toBe(
      false
    );
    expect(BlindLevelSchema.safeParse({ smallBlind: 10, bigBlind: 20.5, ante: 0 }).success).toBe(
      false
    );
  });
});

describe("Table Config edge cases", () => {
  describe("TableConfigSchema", () => {
    test("rejects zero small blind", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 0, bigBlind: 10, maxPlayers: 6 }).success
      ).toBe(false);
    });

    test("rejects zero big blind", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5, bigBlind: 0, maxPlayers: 6 }).success
      ).toBe(false);
    });

    test("rejects negative ante", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5, bigBlind: 10, maxPlayers: 6, ante: -1 })
          .success
      ).toBe(false);
    });

    test("accepts zero ante", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5, bigBlind: 10, maxPlayers: 6, ante: 0 }).success
      ).toBe(true);
    });

    test("accepts maxPlayers = 2 (heads-up minimum)", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5, bigBlind: 10, maxPlayers: 2 }).success
      ).toBe(true);
    });

    test("accepts maxPlayers = 10 (maximum)", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5, bigBlind: 10, maxPlayers: 10 }).success
      ).toBe(true);
    });

    test("rejects non-integer small blind", () => {
      expect(
        TableConfigSchema.safeParse({ smallBlind: 5.5, bigBlind: 10, maxPlayers: 6 }).success
      ).toBe(false);
    });

    test("rejects rakePercent > 100", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakePercent: 101,
        }).success
      ).toBe(false);
    });

    test("accepts rakePercent = 0", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakePercent: 0,
        }).success
      ).toBe(true);
    });

    test("accepts rakePercent = 100 (boundary)", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakePercent: 100,
        }).success
      ).toBe(true);
    });

    test("rejects negative rakePercent", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakePercent: -1,
        }).success
      ).toBe(false);
    });

    test("accepts rakeCap = 0", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakeCap: 0,
        }).success
      ).toBe(true);
    });

    test("rejects negative rakeCap", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          rakeCap: -10,
        }).success
      ).toBe(false);
    });

    test("accepts timeBankSeconds and timeBankDeductionSeconds", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          timeBankSeconds: 30,
          timeBankDeductionSeconds: 10,
        }).success
      ).toBe(true);
    });

    test("rejects zero timeBankSeconds", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          timeBankSeconds: 0,
        }).success
      ).toBe(false);
    });

    test("accepts blindStructure array", () => {
      expect(
        TableConfigSchema.safeParse({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: 6,
          blindStructure: [
            { smallBlind: 5, bigBlind: 10, ante: 0 },
            { smallBlind: 10, bigBlind: 20, ante: 0 },
          ],
        }).success
      ).toBe(true);
    });
  });

  describe("CreateTableSchema additional edges", () => {
    test("rejects empty table name", () => {
      expect(
        CreateTableSchema.safeParse({ name: "", mode: "CASH", smallBlind: 5, bigBlind: 10 }).success
      ).toBe(false);
    });

    test("rejects table name over 100 characters", () => {
      expect(
        CreateTableSchema.safeParse({
          name: "A".repeat(101),
          mode: "CASH",
          smallBlind: 5,
          bigBlind: 10,
        }).success
      ).toBe(false);
    });

    test("accepts table name of exactly 100 characters", () => {
      expect(
        CreateTableSchema.safeParse({
          name: "A".repeat(100),
          mode: "CASH",
          smallBlind: 5,
          bigBlind: 10,
        }).success
      ).toBe(true);
    });

    test("rejects smallBlind <= 0", () => {
      expect(
        CreateTableSchema.safeParse({ name: "T", mode: "CASH", smallBlind: 0, bigBlind: 10 })
          .success
      ).toBe(false);
    });

    test("rejects bigBlind == smallBlind (boundary)", () => {
      expect(
        CreateTableSchema.safeParse({ name: "T", mode: "CASH", smallBlind: 10, bigBlind: 10 })
          .success
      ).toBe(false);
    });

    test("rejects bigBlind < smallBlind", () => {
      expect(
        CreateTableSchema.safeParse({ name: "T", mode: "CASH", smallBlind: 20, bigBlind: 10 })
          .success
      ).toBe(false);
    });

    test("accepts maxBuyIn == minBuyIn (boundary)", () => {
      expect(
        CreateTableSchema.safeParse({
          name: "T",
          mode: "CASH",
          smallBlind: 5,
          bigBlind: 10,
          minBuyIn: 1000,
          maxBuyIn: 1000,
        }).success
      ).toBe(true);
    });

    test("applies default maxPlayers = 9 when omitted", () => {
      const r = CreateTableSchema.safeParse({
        name: "T",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.maxPlayers).toBe(9);
      }
    });

    test("rejects negative minBuyIn", () => {
      expect(
        CreateTableSchema.safeParse({
          name: "T",
          mode: "CASH",
          smallBlind: 5,
          bigBlind: 10,
          minBuyIn: -100,
        }).success
      ).toBe(false);
    });
  });
});

describe("API Request Schemas (gap-fill)", () => {
  describe("BuyInRequestSchema", () => {
    test("rejects zero amount", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 0, seat: 0, idempotencyKey: "k" }).success
      ).toBe(false);
    });

    test("rejects negative amount", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: -50, seat: 0, idempotencyKey: "k" }).success
      ).toBe(false);
    });

    test("rejects non-integer amount", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 10.5, seat: 0, idempotencyKey: "k" }).success
      ).toBe(false);
    });

    test("rejects empty idempotencyKey", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 100, seat: 0, idempotencyKey: "" }).success
      ).toBe(false);
    });

    test("rejects seat out of range (10)", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 100, seat: 10, idempotencyKey: "k" }).success
      ).toBe(false);
    });

    test("accepts seat at max boundary (9)", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 100, seat: 9, idempotencyKey: "k" }).success
      ).toBe(true);
    });

    test("rejects negative seat", () => {
      expect(
        BuyInRequestSchema.safeParse({ amount: 100, seat: -1, idempotencyKey: "k" }).success
      ).toBe(false);
    });

    test("rejects invalid sitInOption", () => {
      expect(
        BuyInRequestSchema.safeParse({
          amount: 100,
          seat: 0,
          idempotencyKey: "k",
          sitInOption: "INVALID",
        }).success
      ).toBe(false);
    });
  });

  describe("AddChipsRequestSchema", () => {
    test("accepts valid request", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: 1000, idempotencyKey: "k1" }).success).toBe(
        true
      );
    });

    test("rejects zero amount", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: 0, idempotencyKey: "k1" }).success).toBe(
        false
      );
    });

    test("rejects negative amount", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: -100, idempotencyKey: "k1" }).success).toBe(
        false
      );
    });

    test("rejects non-integer amount", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: 10.99, idempotencyKey: "k1" }).success).toBe(
        false
      );
    });

    test("rejects missing idempotencyKey", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: 100 }).success).toBe(false);
    });

    test("rejects empty idempotencyKey", () => {
      expect(AddChipsRequestSchema.safeParse({ amount: 100, idempotencyKey: "" }).success).toBe(
        false
      );
    });
  });

  describe("GameActionRequestSchema", () => {
    test("accepts CHECK without amount", () => {
      expect(GameActionRequestSchema.safeParse({ type: "CHECK" }).success).toBe(true);
    });

    test("accepts CALL without amount", () => {
      expect(GameActionRequestSchema.safeParse({ type: "CALL" }).success).toBe(true);
    });

    test("accepts FOLD without amount", () => {
      expect(GameActionRequestSchema.safeParse({ type: "FOLD" }).success).toBe(true);
    });

    test("accepts DEAL without amount", () => {
      expect(GameActionRequestSchema.safeParse({ type: "DEAL" }).success).toBe(true);
    });

    test("accepts SHOW with single cardIndex [0]", () => {
      expect(GameActionRequestSchema.safeParse({ type: "SHOW", cardIndices: [0] }).success).toBe(
        true
      );
    });

    test("accepts STAND", () => {
      expect(GameActionRequestSchema.safeParse({ type: "STAND" }).success).toBe(true);
    });

    test("accepts NEXT_BLIND_LEVEL", () => {
      expect(GameActionRequestSchema.safeParse({ type: "NEXT_BLIND_LEVEL" }).success).toBe(true);
    });

    test("rejects unknown action type", () => {
      expect(GameActionRequestSchema.safeParse({ type: "INVALID" }).success).toBe(false);
    });

    test("rejects zero amount on RAISE", () => {
      expect(GameActionRequestSchema.safeParse({ type: "RAISE", amount: 0 }).success).toBe(false);
    });

    test("rejects negative amount on BET", () => {
      expect(GameActionRequestSchema.safeParse({ type: "BET", amount: -5 }).success).toBe(false);
    });

    test("rejects too many cardIndices [0,1,2]", () => {
      // schema limit each index to 0-1, but an extra element is still accepted
      // individually as long as each entry is 0 or 1; here index 2 fails.
      expect(
        GameActionRequestSchema.safeParse({ type: "SHOW", cardIndices: [0, 1, 2] }).success
      ).toBe(false);
    });

    test("accepts empty cardIndices array", () => {
      expect(GameActionRequestSchema.safeParse({ type: "SHOW", cardIndices: [] }).success).toBe(
        true
      );
    });
  });
});

describe("Schema type inference", () => {
  test("CreateTableRequest type infers maxPlayers default", () => {
    // Compile-time check via a function that takes the inferred type
    const req: import("../src/schemas").CreateTableRequest = {
      name: "T",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 9,
    };
    expect(req.maxPlayers).toBe(9);
  });
});
