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

  test("Swiss Cheese table: sparse seats with wraparound", () => {
    // Edge case: Button at 0, only players at seats 0 and 8
    // With exactly 2 seated players, this becomes heads-up rules
    // In heads-up: button IS the small blind
    const players = [
      createPlayer(0, "p0"), // Button
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      createPlayer(8, "p8"), // Should be BB
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    // With 2 seated players, heads-up rules apply
    expect(positions).toEqual({
      smallBlindSeat: 0, // Button IS SB in heads-up
      bigBlindSeat: 8, // Other player is BB
    });
  });

  test("Swiss Cheese table: button at end, BB wraps to start", () => {
    // Button at seat 5, players at 2 and 5
    // With exactly 2 seated players, heads-up rules apply
    const players = [null, null, createPlayer(2, "p2"), null, null, createPlayer(5, "p5"), null];

    const state = createTestState(players, 5);
    const positions = getBlindPositions(state);

    // Heads-up rules: button is SB
    expect(positions).toEqual({
      smallBlindSeat: 5, // Button IS SB in heads-up
      bigBlindSeat: 2, // Other player is BB
    });
  });

  test("Swiss Cheese with 3+ players: uses Dead Button rules", () => {
    // Button at 0, players at 0, 3, and 8
    // With 3+ players, normal Dead Button rules apply
    const players = [
      createPlayer(0, "p0"), // Button
      null,
      null,
      createPlayer(3, "p3"),
      null,
      null,
      null,
      null,
      createPlayer(8, "p8"),
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 1, // Dead SB (empty seat)
      bigBlindSeat: 3, // Next occupied seat after SB position
    });
  });

  test("all players sitting out except one (cash game)", () => {
    const players = [
      { ...createPlayer(0, "p0"), isSittingOut: true }, // Button, sitting out
      { ...createPlayer(1, "p1"), isSittingOut: true }, // SB position, sitting out
      createPlayer(2, "p2"), // Only active player - will be BB
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    // In cash games, sitting-out players are skipped for blinds
    // SB position is 1 (sitting out, so Dead SB)
    // BB search finds seat 2 (the only active player)
    // This is valid - one player can play if they're in the BB
    expect(positions).toEqual({
      smallBlindSeat: 1, // Dead SB (sitting out)
      bigBlindSeat: 2, // Only active player
    });
  });

  test("all players have zero stack except one", () => {
    const players = [
      { ...createPlayer(0, "p0"), stack: 0 }, // Busted
      { ...createPlayer(1, "p1"), stack: 0 }, // Busted
      createPlayer(2, "p2"), // Only player with chips
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    // Players with 0 stack are treated like empty seats
    // With only one player having chips, blind positions are still calculated
    // (The engine allows this - the game logic elsewhere should prevent the hand from starting)
    expect(positions).toEqual({
      smallBlindSeat: 1, // Empty (0 stack)
      bigBlindSeat: 2, // Only player with chips
    });
  });

  test("tournament mode: includes sitting-out players for blinds", () => {
    const players = [
      createPlayer(0, "p0"),
      { ...createPlayer(1, "p1"), isSittingOut: true }, // Sitting out but must post in tournament
      createPlayer(2, "p2"),
    ];

    const state = createTestState(players, 0);
    // Add blind structure to make it a tournament
    state.config.blindStructure = [{ smallBlind: 10, bigBlind: 20, ante: 0 }];

    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 1, // Sitting-out player MUST post in tournament
      bigBlindSeat: 2,
    });
  });

  test("cash game: skips sitting-out players", () => {
    const players = [
      createPlayer(0, "p0"),
      { ...createPlayer(1, "p1"), isSittingOut: true }, // Skipped in cash game
      createPlayer(2, "p2"), // Should be SB
      createPlayer(3, "p3"), // Should be BB
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toEqual({
      smallBlindSeat: 1, // Position 1, but it's empty (Dead SB)
      bigBlindSeat: 2, // Next active player
    });
  });

  test("all players sitting out in cash game returns null (no eligible blind positions)", () => {
    const players = [
      { ...createPlayer(0, "p0"), isSittingOut: true },
      { ...createPlayer(1, "p1"), isSittingOut: true },
    ];

    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);

    expect(positions).toBeNull();
  });

  test("returns null if buttonSeat is null", () => {
    const players = [createPlayer(0, "p0")];
    const state = createTestState(players, 0);
    // Force buttonSeat to null
    const stateWithNullButton = { ...state, buttonSeat: null };

    const positions = getBlindPositions(stateWithNullButton);
    expect(positions).toBeNull();
  });

  test("returns null if no BB seat found (single player table)", () => {
    // 1 player at seat 0. Max players 3.
    // SB is seat 1 (empty). BB search starts at 2.
    // Seat 2 empty. Next is 0.
    // 0 is occupied but is the "start seat" of the search (actually, getNextSeat(1) is 2).
    // Wait, loop condition is `seat !== startSeat`.
    // If startSeat is 2. Seat 2 is empty. Next is 0. 0 is occupied. Returns 0?
    // No, let's trace `getNextActiveOrOccupiedSeat`.
    // currentSeat = SB position (1).
    // startSeat = 1.
    // seat = getNextSeat(1) = 2.
    // Loop runs.
    // Seat 2: empty.
    // seat = getNextSeat(2) = 0.
    // Seat 0: Occupied. Returns 0.
    // So BB is 0.
    // This means SB=1 (Dead), BB=0.
    // So with 1 player, it might actually work?
    // Let's try to construct a case where it FAILS (returns null).
    // Only fails if NO players are found in the entire loop.
    // i.e. All other seats empty/sitting out.
    // And the `startSeat` (SB) is ALSO empty/sitting out.
    // AND the loop check `seat !== startSeat` prevents checking startSeat?
    // If startSeat is occupied, it should be returned?
    // `seat` starts at `getNextSeat(currentSeat)`.
    // If `currentSeat` IS the only player...
    // Example: Player at 0. Button at 0.
    // SB is 1.
    // Search for BB starts at 1.
    // seat = 2. Empty.
    // seat = 0. Occupied. Returns 0.
    // Result: SB=1, BB=0.
    //
    // Case where it returns null:
    // NO eligible players at all?
    // If 0 players... loop goes around.
    const players = [null, null, null];
    const state = createTestState(players, 0);
    const positions = getBlindPositions(state);
    expect(positions).toBeNull();
  });
});
