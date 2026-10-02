import { describe, it, expect } from "vitest";
import {
  PlayerStatus,
  SitInOption,
  Street,
  PublicWireStateSchema,
  SeatObservationSchema,
} from "@pokertools/types";
import type { PublicWirePlayer, PublicWireState } from "@pokertools/types";
import {
  formatChips,
  parseChips,
  getActivePlayer,
  getPlayerById,
  getPlayerSeat,
  isPlayerTurn,
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
import type { ViewPlayer } from "../src/utils";

// A canonical wire player from a server observation
const createWirePlayer = (
  seat: number,
  overrides: Partial<PublicWirePlayer> = {}
): PublicWirePlayer => ({
  id: `player${seat + 1}`,
  name: `Player ${seat + 1}`,
  seat,
  stack: 1000,
  hand: null,
  shownCards: null,
  status: PlayerStatus.ACTIVE,
  betThisStreet: 0,
  totalInvestedThisHand: 0,
  isSittingOut: false,
  timeBank: 30,
  pendingAddOn: 0,
  sitInOption: SitInOption.IMMEDIATE,
  reservationExpiry: null,
  pendingStand: false,
  ...overrides,
});

// A minimal structural player, the shape the view helpers consume
const createPlayer = (overrides: Partial<ViewPlayer> = {}): ViewPlayer => ({
  id: "player1",
  name: "Test Player",
  seat: 0,
  stack: 1000,
  status: PlayerStatus.ACTIVE,
  ...overrides,
});

// A validated canonical `PublicWireState` (what `SeatObservation.state` carries)
const createWireState = (overrides: Partial<PublicWireState> = {}): PublicWireState =>
  PublicWireStateSchema.parse({
    config: { smallBlind: 5, bigBlind: 10 },
    players: [createWirePlayer(0), createWirePlayer(1)],
    maxPlayers: 2,
    handNumber: 1,
    buttonSeat: 0,
    bigBlindSeat: 1,
    deck: [],
    board: [],
    street: Street.PREFLOP,
    pots: [],
    currentBets: {},
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
    timeBanks: {},
    timeBankActiveSeat: null,
    actionHistory: [],
    timestamp: 1_700_000_000_000,
    handId: "hand-1",
    viewingPlayerId: null,
    version: 1,
    ...overrides,
  });

// A structural view over the canonical state
const createState = (overrides: Partial<PublicWireState> = {}) => {
  const wire = createWireState(overrides);
  return { players: wire.players, actionTo: wire.actionTo };
};

describe("Chip Formatting", () => {
  describe("formatChips", () => {
    it("formats integer game units with grouping and no currency", () => {
      expect(formatChips(100)).toBe("100");
      expect(formatChips(1050)).toBe("1,050");
      expect(formatChips(10000)).toBe("10,000");
      expect(formatChips(1)).toBe("1");
      expect(formatChips(0)).toBe("0");
    });

    it("formats large amounts with thousands separators", () => {
      expect(formatChips(1_000_000)).toBe("1,000,000");
      expect(formatChips(1_000_000_000)).toBe("1,000,000,000");
    });

    it("rejects fractional and unsafe chip amounts", () => {
      expect(() => formatChips(1.5)).toThrow();
      expect(() => formatChips(Number.MAX_SAFE_INTEGER + 1)).toThrow();
      expect(() => formatChips(Number.NaN)).toThrow();
    });

    it("rejects negative chip amounts", () => {
      expect(() => formatChips(-1)).toThrow();
      expect(() => formatChips(-100)).toThrow();
    });
  });

  describe("parseChips", () => {
    it("parses plain integer chip text", () => {
      expect(parseChips("1000")).toBe(1000);
      expect(parseChips("100")).toBe(100);
      expect(parseChips("0")).toBe(0);
    });

    it("parses optional comma grouping", () => {
      expect(parseChips("1,000")).toBe(1000);
      expect(parseChips("1,000,000")).toBe(1_000_000);
      expect(parseChips(" 1,000 ")).toBe(1000);
    });

    it("round-trips formatChips output", () => {
      expect(parseChips(formatChips(1_000_000))).toBe(1_000_000);
    });

    it("rejects currency symbols, fractions, exponents and junk", () => {
      expect(() => parseChips("$10.50")).toThrow();
      expect(() => parseChips("10.50")).toThrow();
      expect(() => parseChips("1.5")).toThrow();
      expect(() => parseChips("1e3")).toThrow();
      expect(() => parseChips("1000abc")).toThrow();
      expect(() => parseChips("-100")).toThrow();
      expect(() => parseChips("1,00")).toThrow();
      expect(() => parseChips("invalid")).toThrow();
      expect(() => parseChips("")).toThrow();
    });

    it("rejects unsafe integers", () => {
      expect(() => parseChips("9007199254740993")).toThrow();
      expect(() => parseChips(String(Number.MAX_SAFE_INTEGER))).not.toThrow();
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

describe("Pot Utilities", () => {
  describe("getTotalPot", () => {
    it("returns pot when no side pots", () => {
      const state = { pots: [{ amount: 100 }] };
      expect(getTotalPot(state)).toBe(100);
    });

    it("includes side pots", () => {
      const state = { pots: [{ amount: 100 }, { amount: 50 }] };
      expect(getTotalPot(state)).toBe(150);
    });
  });
});

describe("Player Filters", () => {
  describe("getActivePlayers", () => {
    it("filters out folded and empty stack players", () => {
      const state = {
        players: [
          createPlayer({ id: "p1", status: PlayerStatus.ACTIVE, stack: 100 }),
          createPlayer({ id: "p2", status: PlayerStatus.FOLDED, stack: 100 }),
          createPlayer({ id: "p3", status: PlayerStatus.ACTIVE, stack: 0 }),
          null,
        ] as Array<ViewPlayer | null>,
        actionTo: 0,
      };
      const active = getActivePlayers(state);
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("p1");
    });
  });

  describe("getPlayersInHand", () => {
    it("filters out folded players only", () => {
      const state = {
        players: [
          createPlayer({ id: "p1", status: PlayerStatus.ACTIVE }),
          createPlayer({ id: "p2", status: PlayerStatus.FOLDED }),
          createPlayer({ id: "p3", status: PlayerStatus.ACTIVE }),
          null,
        ] as Array<ViewPlayer | null>,
        actionTo: 0,
      };
      const inHand = getPlayersInHand(state);
      expect(inHand.length).toBe(2);
    });
  });
});

describe("Canonical server observation view", () => {
  it("runs view helpers on a validated SeatObservation state", () => {
    const observation = SeatObservationSchema.parse({
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-1",
      version: 1,
      eventSeq: 1,
      state: createWireState({
        actionTo: 1,
        pots: [
          { amount: 30, eligibleSeats: [0, 1], type: "MAIN", capPerPlayer: 0 },
        ] as PublicWireState["pots"],
      }),
      legalActions: [{ actionId: "action-1", family: "FOLD" }],
    });

    expect(getActivePlayer(observation.state)?.id).toBe("player2");
    expect(getPlayerById(observation.state, "player1")?.stack).toBe(1000);
    expect(getPlayerSeat(observation.state, "player2")).toBe(1);
    expect(isPlayerTurn(observation.state, "player2")).toBe(true);
    expect(getTotalPot(observation.state)).toBe(30);
    expect(getActivePlayers(observation.state).length).toBe(2);
    expect(getPlayersInHand(observation.state).length).toBe(2);
    expect(isShowdown(observation.state)).toBe(false);
    expect(isHandComplete(observation.state)).toBe(false);
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
      expect(isShowdown({ street: Street.SHOWDOWN })).toBe(true);
      expect(isShowdown({ street: Street.RIVER })).toBe(false);
    });
  });

  describe("isHandComplete", () => {
    it("detects completed hand", () => {
      expect(isHandComplete({ winners: null })).toBe(false);
      expect(
        isHandComplete({ winners: [{ seat: 0, amount: 100, hand: null, handRank: null }] })
      ).toBe(true);
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
