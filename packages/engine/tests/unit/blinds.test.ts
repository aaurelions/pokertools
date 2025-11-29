import { getBlindPositions } from "../../src/rules/blinds";
import { GameState, Street, Player, PlayerStatus } from "@pokertools/types";

// Helper to create minimal game state for testing
function createTestState(players: Array<Player | null>, buttonSeat: number): GameState {
  return {
    config: { smallBlind: 10, bigBlind: 20 },
    players,
    maxPlayers: players.length,
    handNumber: 1,
    buttonSeat,
    deck: [],
    board: [],
    street: Street.PREFLOP,
    pots: [],
    currentBets: new Map(),
    minRaise: 20,
    lastRaiseAmount: 0,
    actionTo: null,
    lastAggressorSeat: null,
    activePlayers: [],
    rakeThisHand: 0,
    winners: null,
    smallBlind: 10,
    bigBlind: 20,
    ante: 0,
    blindLevel: 0,
    timeBanks: new Map(),
    actionHistory: [],
    previousStates: [],
    timestamp: Date.now(),
    handId: "test",
  } as GameState;
}

function createPlayer(seat: number, id: string): Player {
  return {
    id,
    name: `Player${seat}`,
    seat,
    stack: 1000,
    hand: null,
    shownCards: null,
    status: PlayerStatus.ACTIVE,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
  };
}

describe("Blind Positions", () => {
  test("3 players: SB and BB are left of button", () => {
    const players = [createPlayer(0, "p0"), createPlayer(1, "p1"), createPlayer(2, "p2")];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 1,
      bigBlindSeat: 2,
    });
  });

  test("6 players: SB and BB wrap around", () => {
    const players = [
      createPlayer(0, "p0"),
      createPlayer(1, "p1"),
      createPlayer(2, "p2"),
      createPlayer(3, "p3"),
      createPlayer(4, "p4"),
      createPlayer(5, "p5"),
    ];

    const state = createTestState(players, 5);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 0,
      bigBlindSeat: 1,
    });
  });

  test("heads-up: button is SB", () => {
    const players = [createPlayer(0, "p0"), createPlayer(1, "p1")];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 0, // Button IS SB in heads-up
      bigBlindSeat: 1,
    });
  });

  test("handles empty seats (Dead Button Rule)", () => {
    // Under Dead Button rules:
    // 1. SB is ALWAYS immediate left of Button (even if empty)
    // 2. BB is the next OCCUPIED seat after SB position

    const players = [
      createPlayer(0, "p0"), // Button
      null, // Empty (Dead Small Blind)
      createPlayer(2, "p2"), // Should be BB
      null,
      createPlayer(4, "p4"),
      null,
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 1, // Dead SB (Seat 1 is empty, but that's the position)
      bigBlindSeat: 2, // BB is next player
    });
  });
});
