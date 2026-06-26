import { PlayerStatus, SitInOption, Street, type GameState, type Player } from "@pokertools/types";
import { determineWinners } from "../../src/rules/showdown";
import { createPublicView } from "../../src/utils/view-masking";

function makePlayer(seat: number, hand: readonly string[], stack = 0): Player {
  return {
    id: `p${seat}`,
    name: `Player ${seat}`,
    seat,
    stack,
    hand,
    shownCards: null,
    status: PlayerStatus.ACTIVE,
    betThisStreet: 0,
    totalInvestedThisHand: 100,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: null,
  };
}

function makeShowdownState(): GameState {
  const players: Array<Player | null> = Array(2).fill(null);
  players[0] = makePlayer(0, ["Ts", "2c"]);
  players[1] = makePlayer(1, ["Ah", "Ad"]);

  return {
    config: { smallBlind: 5, bigBlind: 10, validateIntegrity: false },
    players,
    maxPlayers: 2,
    handNumber: 1,
    buttonSeat: 0,
    deck: [],
    board: ["As", "Kd", "Qc", "Jd", "9h"],
    street: Street.SHOWDOWN,
    pots: [{ amount: 200, eligibleSeats: [0, 1], type: "MAIN", capPerPlayer: 100 }],
    currentBets: new Map([
      [0, 0],
      [1, 0],
    ]),
    minRaise: 10,
    lastRaiseAmount: 10,
    actionTo: null,
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
    handId: "regression-hand",
  };
}

describe("Core engine regressions", () => {
  test("winner.hand records the best five-card hand, not only hole cards", () => {
    const result = determineWinners(makeShowdownState());

    expect(result.winners).toHaveLength(1);
    expect(result.winners![0].seat).toBe(0);
    expect(result.winners![0].hand).toHaveLength(5);
    expect(result.winners![0].hand).toEqual(expect.arrayContaining(["Ts", "As", "Kd", "Qc", "Jd"]));
    expect(result.winners![0].hand).not.toContain("2c");
    expect(result.winners![0].hand).not.toContain("9h");
  });

  test("public view currentBets remains a Map-compatible value", () => {
    const state = makeShowdownState();
    const publicView = createPublicView(state, "p0");

    expect(publicView.currentBets).toBeInstanceOf(Map);
    expect(publicView.currentBets.get(0)).toBe(0);
    expect([...publicView.currentBets.entries()]).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(JSON.parse(JSON.stringify(publicView)).currentBets).toEqual({ "0": 0, "1": 0 });
  });
});
