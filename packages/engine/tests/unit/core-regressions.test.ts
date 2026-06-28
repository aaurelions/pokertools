import {
  ActionType,
  PlayerStatus,
  SitInOption,
  Street,
  type GameState,
  type Player,
} from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";
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

  test("new hand resets stale lastAggressorSeat", () => {
    const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 3 });

    engine.sit(0, "p0", "Player 0", 1000);
    engine.sit(1, "p1", "Player 1", 1000);
    engine.sit(2, "p2", "Player 2", 1000);
    engine.deal();

    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 30 });
    engine.act({ type: ActionType.FOLD, playerId: "p1" });
    engine.act({ type: ActionType.FOLD, playerId: "p2" });

    expect(engine.state.lastAggressorSeat).toBe(0);

    engine.deal();

    expect(engine.state.lastAggressorSeat).toBeNull();
  });

  test("fold-out after prior street conserves chips and returns only uncalled bets", () => {
    const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 3 });

    engine.sit(0, "p0", "Button", 1000);
    engine.sit(1, "p1", "Small Blind", 1000);
    engine.sit(2, "p2", "Big Blind", 1000);
    engine.deal();

    engine.act({ type: ActionType.CALL, playerId: "p0" });
    engine.act({ type: ActionType.CALL, playerId: "p1" });
    engine.act({ type: ActionType.CHECK, playerId: "p2" });

    engine.act({ type: ActionType.BET, playerId: "p1", amount: 100 });
    engine.act({ type: ActionType.CALL, playerId: "p2" });
    engine.act({ type: ActionType.FOLD, playerId: "p0" });

    engine.act({ type: ActionType.BET, playerId: "p1", amount: 200 });
    engine.act({ type: ActionType.FOLD, playerId: "p2" });

    expect(engine.state.players[1]!.stack).toBe(1120);
    expect(engine.state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0)).toBe(3000);
  });

  test("winner shownCards covers the actual hand length", () => {
    const state = makeShowdownState();
    state.players[0] = makePlayer(0, ["As", "Ks", "Qs"]);
    state.players[1] = { ...makePlayer(1, ["2c", "3d"]), status: PlayerStatus.FOLDED };
    state.pots = [{ amount: 200, eligibleSeats: [0], type: "MAIN", capPerPlayer: 100 }];

    const result = determineWinners(state);

    expect(result.players[0]!.shownCards).toEqual([0, 1, 2]);
  });
});
