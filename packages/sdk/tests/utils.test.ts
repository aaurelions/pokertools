import { describe, it, expect } from "vitest";
import type { PublicState, PublicPlayer } from "@pokertools/types";
import {
  formatChips,
  parseChips,
  getActivePlayer,
  getPlayerById,
  getPlayerSeat,
  isPlayerTurn,
  getCallAmount,
  canCheck,
  canBet,
  getTotalPot,
  getActivePlayers,
  getPlayersInHand,
  suitToEmoji,
  formatCard,
  formatCards,
  getStreetName,
  isShowdown,
  isHandComplete,
  abbreviateNumber,
} from "../src/utils";

// Mock player
// @ts-ignore - Partial mock
const createPlayer = (overrides: Partial<PublicPlayer> = {}): PublicPlayer => ({
  id: "player1",
  name: "Test Player",
  stack: 1000,
  betThisStreet: 0,
  status: "ACTIVE",
  hand: null,
  sittingOut: false,
  timeBank: 30,
  seat: 0,
  ...overrides,
});

// Mock state
// @ts-ignore - Partial mock
const createState = (overrides: Partial<PublicState> = {}): PublicState => ({
  street: "PREFLOP",
  pots: [],
  board: [],
  deck: [],
  players: [createPlayer({ id: "player1", seat: 0 }), createPlayer({ id: "player2", seat: 1 })],
  actionTo: 0,
  handNumber: 1,
  config: {
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 6,
  },
  minRaise: 10,
  viewingPlayerId: null,
  version: 1,
  ...overrides,
});

describe("Chip Formatting", () => {
  describe("formatChips", () => {
    it("formats chips to dollars", () => {
      expect(formatChips(100)).toBe("$1.00");
      expect(formatChips(1050)).toBe("$10.50");
      expect(formatChips(10000)).toBe("$100.00");
      expect(formatChips(1)).toBe("$0.01");
    });

    it("uses custom currency symbol", () => {
      expect(formatChips(100, "€")).toBe("€1.00");
      expect(formatChips(100, "£")).toBe("£1.00");
    });
  });

  describe("parseChips", () => {
    it("parses dollar amounts", () => {
      expect(parseChips("$10.50")).toBe(1050);
      expect(parseChips("$1.00")).toBe(100);
      expect(parseChips("10.50")).toBe(1050);
    });

    it("parses integer amounts as cents", () => {
      expect(parseChips("1000")).toBe(1000);
    });

    it("throws on invalid input", () => {
      expect(() => parseChips("invalid")).toThrow();
    });
  });
});

describe("Player Utilities", () => {
  describe("getActivePlayer", () => {
    it("returns the active player", () => {
      const state = createState({ actionTo: 0 });
      const player = getActivePlayer(state);
      expect(player?.id).toBe("player1");
    });

    it("returns null when no action", () => {
      const state = createState({ actionTo: null });
      expect(getActivePlayer(state)).toBeNull();
    });
  });

  describe("getPlayerById", () => {
    it("finds player by ID", () => {
      const state = createState();
      const player = getPlayerById(state, "player2");
      expect(player?.id).toBe("player2");
    });

    it("returns null for unknown ID", () => {
      const state = createState();
      expect(getPlayerById(state, "unknown")).toBeNull();
    });
  });

  describe("getPlayerSeat", () => {
    it("returns seat index", () => {
      const state = createState();
      expect(getPlayerSeat(state, "player1")).toBe(0);
      expect(getPlayerSeat(state, "player2")).toBe(1);
    });

    it("returns null for unknown player", () => {
      const state = createState();
      expect(getPlayerSeat(state, "unknown")).toBeNull();
    });
  });

  describe("isPlayerTurn", () => {
    it("returns true when player's turn", () => {
      const state = createState({ actionTo: 0 });
      expect(isPlayerTurn(state, "player1")).toBe(true);
      expect(isPlayerTurn(state, "player2")).toBe(false);
    });

    it("returns false when no action", () => {
      const state = createState({ actionTo: null });
      expect(isPlayerTurn(state, "player1")).toBe(false);
    });
  });
});

describe("Betting Utilities", () => {
  describe("getCallAmount", () => {
    it("calculates amount to call", () => {
      const state = createState({
        players: [
          createPlayer({ id: "player1", betThisStreet: 0 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(getCallAmount(state, "player1")).toBe(100);
    });

    it("returns 0 when already matched", () => {
      const state = createState({
        players: [
          createPlayer({ id: "player1", betThisStreet: 100 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(getCallAmount(state, "player1")).toBe(0);
    });

    it("caps at player stack", () => {
      const state = createState({
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 50 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(getCallAmount(state, "player1")).toBe(50);
    });
  });

  describe("canCheck", () => {
    it("returns true when no bet to match", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0 }),
          createPlayer({ id: "player2", betThisStreet: 0 }),
        ],
      });
      expect(canCheck(state, "player1")).toBe(true);
    });

    it("returns false when bet exists", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(canCheck(state, "player1")).toBe(false);
    });

    it("returns false when not player's turn", () => {
      const state = createState({
        actionTo: 1,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0 }),
          createPlayer({ id: "player2", betThisStreet: 0 }),
        ],
      });
      expect(canCheck(state, "player1")).toBe(false);
    });
  });

  describe("canBet", () => {
    it("returns true when no bets and has chips", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0, stack: 100 }),
          createPlayer({ id: "player2", betThisStreet: 0 }),
        ],
      });
      expect(canBet(state, "player1")).toBe(true);
    });

    it("returns false when bet exists", () => {
      const state = createState({
        actionTo: 0,
        players: [
          createPlayer({ id: "player1", betThisStreet: 0 }),
          createPlayer({ id: "player2", betThisStreet: 100 }),
        ],
      });
      expect(canBet(state, "player1")).toBe(false);
    });
  });
});

describe("Pot Utilities", () => {
  describe("getTotalPot", () => {
    it("returns pot when no side pots", () => {
      // @ts-ignore
      const state = createState({ pots: [{ amount: 100, type: "MAIN" }] });
      expect(getTotalPot(state)).toBe(100);
    });

    it("includes side pots", () => {
      const state = createState({
        // @ts-ignore
        pots: [
          { amount: 100, type: "MAIN" },
          { amount: 50, type: "SIDE" },
        ],
      });
      expect(getTotalPot(state)).toBe(150);
    });
  });
});

describe("Player Filters", () => {
  describe("getActivePlayers", () => {
    it("filters out folded and empty stack players", () => {
      const state = createState({
        players: [
          createPlayer({ id: "p1", status: "ACTIVE", stack: 100 }),
          createPlayer({ id: "p2", status: "FOLDED", stack: 100 }),
          createPlayer({ id: "p3", status: "ACTIVE", stack: 0 }),
          null,
        ] as Array<PublicPlayer | null>,
      });
      const active = getActivePlayers(state);
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("p1");
    });
  });

  describe("getPlayersInHand", () => {
    it("filters out folded players only", () => {
      const state = createState({
        players: [
          createPlayer({ id: "p1", status: "ACTIVE" }),
          createPlayer({ id: "p2", status: "FOLDED" }),
          createPlayer({ id: "p3", status: "ACTIVE" }),
          null,
        ] as Array<PublicPlayer | null>,
      });
      const inHand = getPlayersInHand(state);
      expect(inHand.length).toBe(2);
    });
  });
});

describe("Card Formatting", () => {
  describe("suitToEmoji", () => {
    it("converts suit letters to emojis", () => {
      expect(suitToEmoji("s")).toBe("♠");
      expect(suitToEmoji("h")).toBe("♥");
      expect(suitToEmoji("d")).toBe("♦");
      expect(suitToEmoji("c")).toBe("♣");
    });

    it("returns unknown suits as-is", () => {
      expect(suitToEmoji("x")).toBe("x");
    });
  });

  describe("formatCard", () => {
    it("formats card for display", () => {
      expect(formatCard("As")).toBe("A♠");
      expect(formatCard("Kh")).toBe("K♥");
      expect(formatCard("Td")).toBe("T♦");
      expect(formatCard("2c")).toBe("2♣");
    });
  });

  describe("formatCards", () => {
    it("formats array of cards", () => {
      expect(formatCards(["As", "Kh"])).toBe("A♠ K♥");
    });

    it("shows hidden cards", () => {
      expect(formatCards(null)).toBe("🂠🂠");
      expect(formatCards([null, "Kh"])).toBe("🂠 K♥");
    });
  });
});

describe("Street Names", () => {
  describe("getStreetName", () => {
    it("returns display names", () => {
      expect(getStreetName("PREFLOP")).toBe("Pre-Flop");
      expect(getStreetName("FLOP")).toBe("Flop");
      expect(getStreetName("TURN")).toBe("Turn");
      expect(getStreetName("RIVER")).toBe("River");
      expect(getStreetName("SHOWDOWN")).toBe("Showdown");
    });

    it("returns unknown streets as-is", () => {
      expect(getStreetName("UNKNOWN")).toBe("UNKNOWN");
    });
  });
});

describe("State Checks", () => {
  describe("isShowdown", () => {
    it("detects showdown", () => {
      expect(isShowdown(createState({ street: "SHOWDOWN" }))).toBe(true);
      expect(isShowdown(createState({ street: "RIVER" }))).toBe(false);
    });
  });

  describe("isHandComplete", () => {
    it("detects completed hand", () => {
      expect(isHandComplete(createState({ winners: undefined }))).toBe(false);
      // @ts-ignore
      expect(isHandComplete(createState({ winners: [{ seat: 0, amount: 100 }] }))).toBe(true);
    });
  });
});

describe("Number Formatting", () => {
  describe("abbreviateNumber", () => {
    it("abbreviates thousands", () => {
      expect(abbreviateNumber(1000)).toBe("1.0K");
      expect(abbreviateNumber(10500)).toBe("10.5K");
    });

    it("abbreviates millions", () => {
      expect(abbreviateNumber(1000000)).toBe("1.0M");
      expect(abbreviateNumber(2500000)).toBe("2.5M");
    });

    it("returns small numbers as-is", () => {
      expect(abbreviateNumber(999)).toBe("999");
      expect(abbreviateNumber(1)).toBe("1");
    });
  });
});
