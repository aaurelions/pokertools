import { PokerEngine } from "../../src/engine/PokerEngine";
import { ConfigError } from "../../src/errors/ConfigError";

describe("PokerEngine Config Validation", () => {
  describe("smallBlind validation", () => {
    test("rejects zero small blind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 0,
          bigBlind: 20,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: 0,
          bigBlind: 20,
        });
      }).toThrow("Small blind must be positive");
    });

    test("rejects negative small blind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: -10,
          bigBlind: 20,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: -10,
          bigBlind: 20,
        });
      }).toThrow("Small blind must be positive");
    });

    test("accepts positive small blind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 5,
          bigBlind: 10,
        });
      }).not.toThrow();
    });
  });

  describe("bigBlind validation", () => {
    test("rejects bigBlind equal to smallBlind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 10,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 10,
        });
      }).toThrow("Big blind must be greater than small blind");
    });

    test("rejects bigBlind less than smallBlind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 20,
          bigBlind: 10,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: 20,
          bigBlind: 10,
        });
      }).toThrow("Big blind must be greater than small blind");
    });

    test("accepts bigBlind greater than smallBlind", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
        });
      }).not.toThrow();
    });

    test("accepts bigBlind 2x smallBlind (standard)", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 25,
          bigBlind: 50,
        });
      }).not.toThrow();
    });

    test("accepts non-standard blind ratios", () => {
      // Some games use 10/25, 50/100, etc.
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 25,
        });
      }).not.toThrow();

      expect(() => {
        new PokerEngine({
          smallBlind: 1,
          bigBlind: 3,
        });
      }).not.toThrow();
    });
  });

  describe("maxPlayers validation", () => {
    test("rejects maxPlayers = 1", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 1,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 1,
        });
      }).toThrow("Max players must be between 2 and 10");
    });

    test("rejects maxPlayers = 0", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 0,
        });
      }).toThrow(ConfigError);
    });

    test("rejects negative maxPlayers", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: -5,
        });
      }).toThrow(ConfigError);
    });

    test("rejects maxPlayers > 10", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 11,
        });
      }).toThrow(ConfigError);

      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 100,
        });
      }).toThrow(ConfigError);
    });

    test("accepts maxPlayers = 2 (heads-up)", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 2,
        });
      }).not.toThrow();
    });

    test("accepts maxPlayers = 6 (6-max)", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 6,
        });
      }).not.toThrow();
    });

    test("accepts maxPlayers = 9 (full ring)", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 9,
        });
      }).not.toThrow();
    });

    test("accepts maxPlayers = 10", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          maxPlayers: 10,
        });
      }).not.toThrow();
    });

    test("defaults to 9 when maxPlayers not specified", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
      });

      expect(engine.state.maxPlayers).toBe(9);
      expect(engine.state.players).toHaveLength(9);
    });
  });

  describe("ante validation", () => {
    test("accepts ante = 0 (no ante)", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          ante: 0,
        });
      }).not.toThrow();
    });

    test("accepts positive ante", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        ante: 2,
      });

      expect(engine.state.ante).toBe(2);
    });

    test("accepts ante equal to small blind", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        ante: 10,
      });

      expect(engine.state.ante).toBe(10);
    });
  });

  describe("tournament blind structure", () => {
    test("accepts valid blind structure", () => {
      expect(() => {
        new PokerEngine({
          smallBlind: 10,
          bigBlind: 20,
          blindStructure: [
            { smallBlind: 10, bigBlind: 20, ante: 0 },
            { smallBlind: 20, bigBlind: 40, ante: 0 },
            { smallBlind: 30, bigBlind: 60, ante: 5 },
          ],
        });
      }).not.toThrow();
    });

    test("uses first level as initial blinds", () => {
      const engine = new PokerEngine({
        smallBlind: 999, // Should be overridden by blind structure
        bigBlind: 9999,
        blindStructure: [
          { smallBlind: 10, bigBlind: 20, ante: 2 },
          { smallBlind: 20, bigBlind: 40, ante: 4 },
        ],
      });

      expect(engine.state.smallBlind).toBe(10);
      expect(engine.state.bigBlind).toBe(20);
      expect(engine.state.ante).toBe(2);
      expect(engine.state.blindLevel).toBe(0);
    });

    test("allows empty blind structure array", () => {
      // Edge case: empty structure falls back to config blinds
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        blindStructure: [],
      });

      expect(engine.state.smallBlind).toBe(10);
      expect(engine.state.bigBlind).toBe(20);
    });
  });

  describe("time bank configuration", () => {
    test("accepts custom time bank seconds", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        timeBankSeconds: 60,
      });

      expect(engine.state.config.timeBankSeconds).toBe(60);
    });

    test("accepts custom time bank deduction", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        timeBankDeductionSeconds: 5,
      });

      expect(engine.state.config.timeBankDeductionSeconds).toBe(5);
    });
  });

  describe("rake configuration", () => {
    test("accepts rake config for cash games", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        rakePercent: 5,
        rakeCap: 300,
      });

      expect(engine.state.config.rakePercent).toBe(5);
      expect(engine.state.config.rakeCap).toBe(300);
    });

    test("accepts zero rake", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        rakePercent: 0,
        rakeCap: 0,
      });

      expect(engine.state.config.rakePercent).toBe(0);
      expect(engine.state.config.rakeCap).toBe(0);
    });
  });

  describe("random provider", () => {
    test("accepts custom random provider", () => {
      const customRandom = () => {
        return 0.5;
      };

      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        randomProvider: customRandom,
      });

      expect(engine.state.config.randomProvider).toBe(customRandom);
    });

    test("uses Math.random by default", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
      });

      // Should use default (undefined in config means use Math.random)
      expect(engine.state.config.randomProvider).toBeUndefined();
    });
  });

  describe("complete valid configurations", () => {
    test("minimal valid config", () => {
      const engine = new PokerEngine({
        smallBlind: 5,
        bigBlind: 10,
      });

      expect(engine.state.smallBlind).toBe(5);
      expect(engine.state.bigBlind).toBe(10);
      expect(engine.state.maxPlayers).toBe(9); // Default
      expect(engine.state.ante).toBe(0); // Default
    });

    test("full cash game config", () => {
      const engine = new PokerEngine({
        smallBlind: 100,
        bigBlind: 200,
        ante: 25,
        maxPlayers: 6,
        rakePercent: 5,
        rakeCap: 500,
        timeBankSeconds: 30,
        timeBankDeductionSeconds: 10,
      });

      expect(engine.state.config.smallBlind).toBe(100);
      expect(engine.state.config.bigBlind).toBe(200);
      expect(engine.state.ante).toBe(25);
      expect(engine.state.maxPlayers).toBe(6);
    });

    test("full tournament config", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 9,
        blindStructure: [
          { smallBlind: 10, bigBlind: 20, ante: 0 },
          { smallBlind: 20, bigBlind: 40, ante: 0 },
          { smallBlind: 30, bigBlind: 60, ante: 5 },
          { smallBlind: 50, bigBlind: 100, ante: 10 },
        ],
      });

      expect(engine.state.config.blindStructure).toHaveLength(4);
      expect(engine.state.blindLevel).toBe(0);
    });
  });
});
