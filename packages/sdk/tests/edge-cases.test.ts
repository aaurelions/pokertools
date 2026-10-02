import { describe, it, expect } from "vitest";
import { PlayerStatus, Street, SitInOption } from "@pokertools/types";
import type { PublicState, PublicPlayer } from "@pokertools/types";
import {
  formatChips,
  parseChips,
  getActivePlayer,
  getTotalPot,
  getActivePlayers,
  suitToEmoji,
  formatCard,
  formatCards,
  getStreetName,
  abbreviateNumber,
} from "../src/utils";
import {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  generateIdempotencyKey,
} from "../src/auth";

const createPlayer = (overrides: Partial<PublicPlayer> = {}): PublicPlayer => ({
  id: "player1",
  name: "Test Player",
  stack: 1000,
  betThisStreet: 0,
  status: PlayerStatus.ACTIVE,
  hand: null,
  shownCards: null,
  totalInvestedThisHand: 0,
  isSittingOut: false,
  timeBank: 30,
  seat: 0,
  pendingAddOn: 0,
  sitInOption: SitInOption.IMMEDIATE,
  reservationExpiry: null,
  ...overrides,
});

const createState = (overrides: Partial<PublicState> = {}): PublicState => ({
  config: {
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 6,
  },
  maxPlayers: 6,
  handNumber: 1,
  buttonSeat: null,
  deck: [],
  board: [],
  street: Street.PREFLOP,
  pots: [],
  currentBets: new Map(),
  minRaise: 10,
  lastRaiseAmount: 0,
  actionTo: 0,
  lastAggressorSeat: null,
  activePlayers: [0, 1],
  winners: null,
  rakeThisHand: 0,
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  blindLevel: 0,
  timeBanks: new Map(),
  timeBankActiveSeat: null,
  actionHistory: [],
  previousStates: [],
  timestamp: Date.now(),
  handId: "test-hand",
  players: [createPlayer({ id: "player1", seat: 0 }), createPlayer({ id: "player2", seat: 1 })],
  viewingPlayerId: null,
  version: 1,
  ...overrides,
});

describe("Chip formatting edge cases", () => {
  describe("formatChips", () => {
    it("formats zero as a bare integer", () => {
      expect(formatChips(0)).toBe("0");
    });

    it("formats a single chip as a bare integer", () => {
      expect(formatChips(1)).toBe("1");
    });

    it("displays 100 chips as 100, never as $1.00", () => {
      expect(formatChips(100)).toBe("100");
    });

    it("formats large amounts with grouping and no currency", () => {
      expect(formatChips(1_000_000)).toBe("1,000,000");
      expect(formatChips(1_000_000_000)).toBe("1,000,000,000");
    });

    it("rejects fractions, unsafe integers and negatives", () => {
      expect(() => formatChips(10.5)).toThrow();
      expect(() => formatChips(Number.MAX_SAFE_INTEGER + 1)).toThrow();
      expect(() => formatChips(-100)).toThrow();
    });
  });

  describe("parseChips", () => {
    it("parses plain integer chip text", () => {
      expect(parseChips("1000")).toBe(1000);
      expect(parseChips("1050")).toBe(1050);
      expect(parseChips("1")).toBe(1);
      expect(parseChips("99")).toBe(99);
    });

    it("parses optional comma grouping without scaling", () => {
      expect(parseChips("1,000")).toBe(1000);
      expect(parseChips("1,234,567")).toBe(1_234_567);
    });

    it("parses zero", () => {
      expect(parseChips("0")).toBe(0);
    });

    it("parses surrounding whitespace but rejects internal junk", () => {
      expect(parseChips(" 1000 ")).toBe(1000);
      expect(() => parseChips(" 1 000 ")).toThrow();
    });

    it("rejects currency symbols and dollar strings", () => {
      expect(() => parseChips("$1000")).toThrow();
      expect(() => parseChips("$1,000")).toThrow();
      expect(() => parseChips("€10.50")).toThrow();
      expect(() => parseChips("£1000")).toThrow();
    });

    it("rejects fractions", () => {
      expect(() => parseChips("10.50")).toThrow();
      expect(() => parseChips("0.01")).toThrow();
      expect(() => parseChips("1.5")).toThrow();
    });

    it("rejects exponent notation and trailing junk", () => {
      expect(() => parseChips("1e3")).toThrow();
      expect(() => parseChips("1000abc")).toThrow();
      expect(() => parseChips("1000 ")).not.toThrow();
      expect(() => parseChips("1,00")).toThrow();
    });

    it("rejects negative amounts", () => {
      expect(() => parseChips("-1000")).toThrow();
      expect(() => parseChips("-$10.00")).toThrow();
    });

    it("rejects unsafe integers", () => {
      expect(() => parseChips("9007199254740993")).toThrow();
    });

    it("throws on completely invalid strings", () => {
      expect(() => parseChips("invalid")).toThrow();
      expect(() => parseChips("abc")).toThrow();
    });

    it("throws on empty string", () => {
      expect(() => parseChips("")).toThrow();
    });

    it("throws on pure symbol string", () => {
      expect(() => parseChips("$$$")).toThrow();
    });
  });
});

describe("Numeric abbreviation edge cases", () => {
  describe("abbreviateNumber", () => {
    it("returns 0 as-is", () => {
      expect(abbreviateNumber(0)).toBe("0");
    });

    it("returns negative as-is (no abbreviation)", () => {
      expect(abbreviateNumber(-1000)).toBe("-1000");
      expect(abbreviateNumber(-1000000)).toBe("-1000000");
    });

    it("abbreviates exactly 1000 as 1.0K", () => {
      expect(abbreviateNumber(1000)).toBe("1.0K");
    });

    it("abbreviates exactly 1,000,000 as 1.0M", () => {
      expect(abbreviateNumber(1000000)).toBe("1.0M");
    });

    it("abbreviates 999,999 as thousands", () => {
      expect(abbreviateNumber(999999)).toBe("1000.0K");
    });

    it("abbreviates 999,999,999 as millions", () => {
      expect(abbreviateNumber(999999999)).toBe("1000.0M");
    });

    it("handles decimal precision (1.1K, 1.5K, 1.25M)", () => {
      expect(abbreviateNumber(1100)).toBe("1.1K");
      expect(abbreviateNumber(1500)).toBe("1.5K");
      expect(abbreviateNumber(1250000)).toBe("1.3M");
    });
  });
});

describe("Card / street display edge cases", () => {
  describe("formatCard", () => {
    it("returns strings with unexpected length unchanged", () => {
      expect(formatCard("")).toBe("");
      expect(formatCard("A")).toBe("A");
      expect(formatCard("AhK")).toBe("AhK");
      expect(formatCard("AhKs")).toBe("AhKs");
    });

    it("formats mixed-case rank characters (e.g. lowercase a)", () => {
      // Uppercasing rank: 'a' -> 'A', suit symbol resolved from lowercase
      expect(formatCard("ah")).toBe("A♥");
      expect(formatCard("kd")).toBe("K♦");
    });
  });

  describe("formatCards", () => {
    it("handles empty array", () => {
      expect(formatCards([])).toBe("");
    });

    it("handles array with single null", () => {
      expect(formatCards([null])).toBe("🂠");
    });

    it("handles array with mixed valid + null (3 entries)", () => {
      expect(formatCards(["As", null, "Kd"])).toBe("A♠ 🂠 K♦");
    });
  });

  describe("suitToEmoji", () => {
    it("handles uppercase suit letters by lowercasing them first", () => {
      // Implementation lowercases input before lookup, so uppercase suits resolve.
      expect(suitToEmoji("S")).toBe("♠");
      expect(suitToEmoji("H")).toBe("♥");
      expect(suitToEmoji("D")).toBe("♦");
      expect(suitToEmoji("C")).toBe("♣");
    });

    it("handles empty string returns empty", () => {
      expect(suitToEmoji("")).toBe("");
    });
  });

  describe("getStreetName", () => {
    it("returns undefined-ish as-is for empty string", () => {
      expect(getStreetName("")).toBe("");
    });
  });
});

describe("State utilities edge cases", () => {
  describe("getActivePlayer", () => {
    it("returns active player when actionTo matches a valid seat", () => {
      const state = createState({ actionTo: 1 });
      const player = getActivePlayer(state);
      expect(player?.id).toBe("player2");
    });

    it("returns null if actionTo points at an empty seat", () => {
      const state = createState({
        actionTo: 5,
        players: [
          createPlayer({ id: "player1", seat: 0 }),
          createPlayer({ id: "player2", seat: 1 }),
          null,
          null,
          null,
          null,
        ] as Array<PublicPlayer | null>,
      });
      expect(getActivePlayer(state)).toBeNull();
    });
  });

  describe("getTotalPot", () => {
    it("returns 0 with empty pots array", () => {
      const state = createState({ pots: [] });
      expect(getTotalPot(state)).toBe(0);
    });
  });

  describe("Player Filters", () => {
    it("getActivePlayers ignores reserved / waiting players (filtered to ACTIVE+chips)", () => {
      const state = createState({
        players: [
          createPlayer({ id: "p1", status: PlayerStatus.ACTIVE, stack: 100 }),
          createPlayer({ id: "p2", status: PlayerStatus.ALL_IN, stack: 0 }),
          createPlayer({ id: "p3", status: PlayerStatus.ACTIVE, stack: 0 }),
          null,
        ] as Array<PublicPlayer | null>,
      });
      const active = getActivePlayers(state);
      // ALL_IN is not FOLDED so passes the filter; stack > 0 ? p1 yes, p2 no, p3 no
      expect(active.find((p) => p.id === "p1")).toBeTruthy();
      expect(active.find((p) => p.id === "p2")).toBeUndefined();
      expect(active.find((p) => p.id === "p3")).toBeUndefined();
    });
  });
});

describe("Auth utility edge cases", () => {
  describe("parseSiweMessage", () => {
    it("parses message with all optional fields populated", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
        statement: "Sign in to PokerTools",
        expirationTime: "2024-12-31T23:59:59.999Z",
        notBefore: "2024-01-01T00:00:00.000Z",
        requestId: "req-123",
        resources: ["https://poker.example.com/tables", "https://poker.example.com/user"],
      });

      const parsed = parseSiweMessage(original);

      expect(parsed.domain).toBe("poker.example.com");
      expect(parsed.address).toBe("0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
      expect(parsed.uri).toBe("https://poker.example.com");
      expect(parsed.nonce).toBe("abc12345");
      expect(parsed.statement).toBe("Sign in to PokerTools");
      expect(parsed.expirationTime).toEqual(new Date("2024-12-31T23:59:59.999Z"));
      expect(parsed.notBefore).toEqual(new Date("2024-01-01T00:00:00.000Z"));
      expect(parsed.requestId).toBe("req-123");
    });

    it("preserves resources parsing as a list of URIs", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abcdefgh1",
        resources: ["https://r1.example.com", "https://r2.example.com"],
      });
      const parsed = parseSiweMessage(original);
      expect(parsed.resources).toEqual(["https://r1.example.com", "https://r2.example.com"]);
      expect(parsed.domain).toBe("poker.example.com");
      // Check the message text contains the resources
      expect(original).toContain("- https://r1.example.com");
      expect(original).toContain("- https://r2.example.com");
    });

    it("parses a minimally-populated SIWE message", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
      });

      const parsed = parseSiweMessage(original);
      expect(parsed.expirationTime).toBeUndefined();
      expect(parsed.notBefore).toBeUndefined();
      expect(parsed.requestId).toBeUndefined();
    });

    it("handles unparseable/garbage message without throwing", () => {
      expect(() => parseSiweMessage("garbage")).not.toThrow();
      const r = parseSiweMessage("garbage");
      expect(r.domain).toBeUndefined();
    });

    it("parses a message with an empty statement section gracefully", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abc12345",
        // statement omitted
      });
      const parsed = parseSiweMessage(original);
      expect(parsed.statement).toBeUndefined();
    });
  });

  describe("isSiweExpired additional cases", () => {
    it("returns true for an exact past-tense expiration time", () => {
      // Use a clearly past expiration
      const pastDate = "2020-01-01T00:00:00.000Z";
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abcdefgh1",
        expirationTime: pastDate,
      });
      expect(isSiweExpired(message)).toBe(true);
    });

    it("returns false for a far-future expiration", () => {
      const futureDate = "2999-12-31T23:59:59.999Z";
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abcdefgh1",
        expirationTime: futureDate,
      });
      expect(isSiweExpired(message)).toBe(false);
    });

    it("returns false if message has no expiration at all", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        uri: "https://poker.example.com",
        nonce: "abcdefgh1",
      });
      expect(isSiweExpired(message)).toBe(false);
    });
  });

  describe("generateIdempotencyKey", () => {
    it("generates keys that are stable strings (passing uniqueness check)", () => {
      const k1 = generateIdempotencyKey();
      const k2 = generateIdempotencyKey();
      const k3 = generateIdempotencyKey();
      expect(typeof k1).toBe("string");
      expect(k1.length).toBeGreaterThan(0);
      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
      expect(k2).not.toBe(k3);
    });

    it("generates many unique keys (stress check)", () => {
      const set = new Set<string>();
      for (let i = 0; i < 200; i++) {
        set.add(generateIdempotencyKey());
      }
      expect(set.size).toBe(200);
    });
  });
});
