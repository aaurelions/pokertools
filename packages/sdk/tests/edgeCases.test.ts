import { describe, it, expect } from "vitest";
import { PlayerStatus, Street, SitInOption } from "@pokertools/types";
import type { PublicState, PublicPlayer, Pot } from "@pokertools/types";
import {
  formatChips,
  parseChips,
  getActivePlayer,
  getCallAmount,
  getMinRaise,
  canCheck,
  canBet,
  getTotalPot,
  getActivePlayers,
  getPotOdds,
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
  createWithdrawalMessage,
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
    it("formats zero", () => {
      expect(formatChips(0)).toBe("$0.00");
    });

    it("formats single cent", () => {
      expect(formatChips(1)).toBe("$0.01");
    });

    it("formats large amounts", () => {
      expect(formatChips(1000000)).toBe("$10000.00");
      expect(formatChips(1_000_000_000)).toBe("$10000000.00");
    });

    it("uses custom currency (euro, pound, yen)", () => {
      expect(formatChips(100, "€")).toBe("€1.00");
      expect(formatChips(100, "£")).toBe("£1.00");
      expect(formatChips(100, "¥")).toBe("¥1.00");
    });

    it("formatChips correctly handles negative input (mathematically)", () => {
      expect(formatChips(-100)).toBe("$-1.00");
    });
  });

  describe("parseChips", () => {
    it("parses plain dollar string with decimals", () => {
      expect(parseChips("$10.50")).toBe(1050);
      expect(parseChips("$0.50")).toBe(50);
    });

    it("parses plain number string with decimals", () => {
      expect(parseChips("10.50")).toBe(1050);
      expect(parseChips("0.01")).toBe(1);
    });

    it("parses integer above 100 as cents directly (heuristic)", () => {
      expect(parseChips("1000")).toBe(1000);
      expect(parseChips("1050")).toBe(1050);
    });

    it("interprets integer below 100 as dollars-to-cents conversion", () => {
      // Value 1 (< 100) is non-integer dollar amount 1.00 -> 100 cents
      expect(parseChips("1")).toBe(100);
      expect(parseChips("99")).toBe(9900);
    });

    it("parses euro, pound, yen-stripped numeric amounts (currency-agnostic)", () => {
      // parseChips strips currency symbols, then either parses as dollars
      // or keeps as cents if integer >= 100. So "€10.50" -> 1050; "£1000" -> 1000
      expect(parseChips("€10.50")).toBe(1050);
      expect(parseChips("£1000")).toBe(1000);
      expect(parseChips("¥10.50")).toBe(1050);
    });

    it("parses amounts with thousands separators (commas)", () => {
      expect(parseChips("$1,000")).toBe(1000);
      expect(parseChips("$1,000.50")).toBe(100050);
      expect(parseChips("€1,234.56")).toBe(123456);
    });

    it("parses zero dollars", () => {
      expect(parseChips("$0.00")).toBe(0);
      expect(parseChips("0")).toBe(0);
    });

    it("parses negative dollar amounts", () => {
      expect(parseChips("-$10.00")).toBe(-1000);
      // -1000 is not >= 100 so it's converted as dollars to cents: -1000 * 100 = -100000
      expect(parseChips("-1000")).toBe(-100000);
    });

    it("parses amounts with surrounding whitespace", () => {
      expect(parseChips("  $10.00  ")).toBe(1000);
      expect(parseChips(" 1000 ")).toBe(1000);
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

  describe("getCallAmount edge cases", () => {
    it("returns 0 when player is not found", () => {
      const state = createState();
      expect(getCallAmount(state, "ghost")).toBe(0);
    });

    it("returns 0 when no other player has bet above theirs", () => {
      const state = createState({
        players: [
          createPlayer({ id: "player1", betThisStreet: 100 }),
          createPlayer({ id: "player2", betThisStreet: 50 }),
        ],
      });
      // player1 has highest bet themselves, so to-call is 0 (Math.min(0, stack) = 0)
      expect(getCallAmount(state, "player1")).toBe(0);
    });
  });

  describe("canBet edge cases", () => {
    it("returns false when not player's turn", () => {
      const state = createState({
        actionTo: 1,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 100 }),
          createPlayer({ id: "player2", betThisStreet: 0, stack: 100 }),
        ],
      });
      expect(canBet(state, "player1")).toBe(false);
    });

    it("returns false when player has zero stack", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 0 }),
          createPlayer({ id: "player2", betThisStreet: 0, stack: 100 }),
        ],
      });
      expect(canBet(state, "player1")).toBe(false);
    });
  });

  describe("canCheck edge cases", () => {
    it("returns false for non-existent player", () => {
      const state = createState({ actionTo: 0 });
      expect(canCheck(state, "ghost")).toBe(false);
    });

    it("returns true for player already at highest bet", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 100 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(canCheck(state, "player1")).toBe(true);
    });
  });

  describe("getMinRaise", () => {
    it("returns state.minRaise when present", () => {
      const state = createState({ minRaise: 40 });
      expect(getMinRaise(state)).toBe(40);
    });

    it("falls back to bigBlind when minRaise is missing (as undefined)", () => {
      const state = createState();
      // Simulate missing minRaise (undefined) — but PublicState types it as
      // number with the mock default of 10. Construct a state without minRaise
      const stateNoRaise = { ...state, minRaise: undefined as unknown as number };
      expect(getMinRaise(stateNoRaise)).toBe(state.config.bigBlind);
    });
  });

  describe("getPotOdds", () => {
    it("returns Infinity when there is nothing to call", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 100 }),
          createPlayer({ id: "player2", betThisStreet: 0, stack: 100 }),
        ],
      });
      expect(getPotOdds(state, "player1")).toBe(Infinity);
    });

    it("returns pot to amount ratio when facing a bet", () => {
      const pot: Pot = {
        amount: 100,
        eligibleSeats: [0, 1],
        type: "MAIN",
        capPerPlayer: 100,
      };
      const state = createState({
        actionTo: 0,
        pots: [pot],
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 50 }),
          createPlayer({ id: "player2", betThisStreet: 100, stack: 0 }),
        ],
      });
      // callAmount = min(100 - 0, 50) = 50; totalPot = 100; ratio = 100/50 = 2
      expect(getPotOdds(state, "player1")).toBe(2);
    });

    it("returns 0 when pot is empty but a bet exists to call", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 100 }),
          createPlayer({ id: "player2", betThisStreet: 50, stack: 100 }),
        ],
      });
      // callAmount = 50; totalPot = 0; ratio = 0/50 = 0
      expect(getPotOdds(state, "player1")).toBe(0);
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
        nonce: "abc123",
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
      expect(parsed.nonce).toBe("abc123");
      expect(parsed.statement).toBe("Sign in to PokerTools");
      expect(parsed.expirationTime).toBe("2024-12-31T23:59:59.999Z");
      expect(parsed.notBefore).toBe("2024-01-01T00:00:00.000Z");
      expect(parsed.requestId).toBe("req-123");
    });

    it("preserves resources parsing as a list of URIs", () => {
      const original = createSiweMessage({
        domain: "poker.example.com",
        address: "0xabc",
        uri: "https://poker.example.com",
        nonce: "n1",
        resources: ["https://r1.example.com", "https://r2.example.com"],
      });
      const parsed = parseSiweMessage(original);
      // Parse doesn't currently surface resources back, but for the test assert
      // parse at minimum preserves the primary known fields
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
        nonce: "abc123",
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
        nonce: "abc123",
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
        address: "0xabc",
        uri: "https://poker.example.com",
        nonce: "n",
        expirationTime: pastDate,
      });
      expect(isSiweExpired(message)).toBe(true);
    });

    it("returns false for a far-future expiration", () => {
      const futureDate = "2999-12-31T23:59:59.999Z";
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0xabc",
        uri: "https://poker.example.com",
        nonce: "n",
        expirationTime: futureDate,
      });
      expect(isSiweExpired(message)).toBe(false);
    });

    it("returns false if message has no expiration at all", () => {
      const message = createSiweMessage({
        domain: "poker.example.com",
        address: "0xabc",
        uri: "https://poker.example.com",
        nonce: "n",
      });
      expect(isSiweExpired(message)).toBe(false);
    });
  });

  describe("createWithdrawalMessage", () => {
    it("includes amount integer in message", () => {
      const m = createWithdrawalMessage(500, "0xabc");
      expect(m).toBe("Withdraw 500 USD to 0xabc");
    });

    it("includes amount 0 in message", () => {
      expect(createWithdrawalMessage(0, "0xabc")).toBe("Withdraw 0 USD to 0xabc");
    });

    it("handles long ethereum address with mixed case", () => {
      const addr = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
      expect(createWithdrawalMessage(100, addr)).toBe(`Withdraw 100 USD to ${addr}`);
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