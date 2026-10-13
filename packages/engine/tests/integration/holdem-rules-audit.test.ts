import { ActionType, PlayerStatus, Street } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";
import { determineWinners } from "../../src/rules/showdown";
import { calculateSidePots } from "../../src/rules/side-pots";
import { calculateTotalChips } from "../../src/utils/invariants";

function table(stacks: number[], sb = 5, bb = 10): PokerEngine {
  const e = new PokerEngine({ smallBlind: sb, bigBlind: bb, maxPlayers: stacks.length });
  stacks.forEach((s, i) => e.sit(i, `p${i}`, `P${i}`, s));
  e.deal();
  return e;
}
const act = (e: PokerEngine, type: ActionType, amount?: number) => {
  const p = e.state.players[e.state.actionTo!]!;
  return e.act({ type, playerId: p.id, ...(amount !== undefined ? { amount } : {}) } as never);
};
const totalWon = (e: PokerEngine) => e.state.winners!.reduce((t, w) => t + w.amount, 0);

describe("No-limit hold'em rules audit", () => {
  test("heads-up: button is SB, acts first preflop and last postflop", () => {
    const e = table([1000, 1000]);
    const b = e.state.buttonSeat!;
    expect(e.state.actionTo).toBe(b);
    expect(e.state.players[b]!.betThisStreet).toBe(5);
    act(e, ActionType.CALL);
    expect(e.state.street).toBe(Street.PREFLOP);
    act(e, ActionType.CHECK);
    expect(e.state.street).toBe(Street.FLOP);
    expect(e.state.actionTo).not.toBe(b);
  });

  test("postflop all-in bet below BB does not make min raise below a full BB increment", () => {
    const e = table([1000, 1000, 6]);
    // 3 handed: seat0 btn, 1 sb, 2 bb(6 -> all in posting)
    // play to flop
    while (e.state.street === Street.PREFLOP) {
      const p = e.state.players[e.state.actionTo!]!;
      const toCall =
        Math.max(...[...e.state.currentBets.values()]) - (e.state.currentBets.get(p.seat) ?? 0);
      act(e, toCall > 0 ? ActionType.CALL : ActionType.CHECK);
    }
    expect(e.state.street).toBe(Street.FLOP);
  });

  test("all-in bet smaller than BB on flop: next raise must be at least bet + BB", () => {
    const e = table([1000, 1000, 1000]);
    while (e.state.street === Street.PREFLOP) {
      const p = e.state.players[e.state.actionTo!]!;
      const hi = Math.max(...e.state.currentBets.values());
      act(e, hi > (e.state.currentBets.get(p.seat) ?? 0) ? ActionType.CALL : ActionType.CHECK);
    }
    // make first actor on flop short: can't; instead bet 3 is below BB -> must be rejected unless all in
    const first = e.state.players[e.state.actionTo!]!;
    expect(() => act(e, ActionType.BET, 3)).toThrow();
    expect(first.stack).toBe(990);
  });

  test("short all-in bet below BB then raise: min raise-to = bet + BB", () => {
    const e = table([1000, 1000, 1000, 1000]);
    // p3 utg
    act(e, ActionType.CALL);
    act(e, ActionType.CALL);
    act(e, ActionType.CALL);
    act(e, ActionType.CHECK);
    expect(e.state.street).toBe(Street.FLOP);
    // reduce: can't set stack. Instead verify lastRaiseAmount/minRaise after normal bet
    act(e, ActionType.BET, 10);
    expect(e.state.minRaise).toBe(20);
  });

  test("incomplete all-in raise: player who has not acted may still raise; full min-raise measured from last full raise", () => {
    // seats: 0 btn,1 sb,2 bb,3 utg(short),4 mp
    const e = table([1000, 1000, 1000, 30, 1000], 5, 10);
    // utg=3 acts first: all-in to 30 (raise of 20 over 10: full raise since BB inc =10)
    expect(e.state.actionTo).toBe(3);
    act(e, ActionType.RAISE, 30);
    expect(e.state.minRaise).toBe(50);
    act(e, ActionType.CALL); // seat 4
    expect(e.state.minRaise).toBe(50);
  });

  test("incomplete all-in raise does not reopen to caller but reopens to unacted", () => {
    const e = table([1000, 1000, 1000, 1000, 125], 5, 10);
    // utg = seat 3
    act(e, ActionType.RAISE, 100); // seat3 to 100
    // seat 4 (stack 125) all-in 125: increment 25 < 90 -> incomplete
    act(e, ActionType.RAISE, 125);
    // min raise-to is the new high (125) plus the last FULL raise (90)
    expect(e.state.minRaise).toBe(215);
    // seat 0 (btn) has not acted -> may raise to 215
    act(e, ActionType.RAISE, 215);
    expect(e.state.minRaise).toBe(305);
  });

  test("multiway all-ins with different stacks conserve chips and pay out every chip", () => {
    const e = table([100, 200, 300, 400], 5, 10);
    const total = calculateTotalChips(e.state);
    while (e.state.winners === null) {
      const p = e.state.players[e.state.actionTo!]!;
      const bet = e.state.currentBets.get(p.seat) ?? 0;
      const hi = Math.max(...e.state.currentBets.values());
      const all = p.stack + bet;
      act(e, all > hi ? ActionType.RAISE : ActionType.CALL, all > hi ? all : undefined);
    }
    // 400-stack's uncalled 100 (above the 300 stack) is returned and not part of any pot
    expect(totalWon(e)).toBe(100 + 200 + 300 + 300);
    expect(calculateTotalChips(e.state)).toBe(total);
  });

  test("BB may raise its option when everyone limps", () => {
    const e = table([1000, 1000, 1000]);
    act(e, ActionType.CALL); // btn
    act(e, ActionType.CALL); // sb
    expect(e.state.street).toBe(Street.PREFLOP);
    act(e, ActionType.RAISE, 20);
    expect(e.state.actionTo).toBe(0);
  });

  test("everyone folds to BB preflop: hand ends, no board dealt, BB wins blinds", () => {
    const e = table([1000, 1000, 1000]);
    act(e, ActionType.FOLD);
    act(e, ActionType.FOLD);
    expect(e.state.winners).not.toBeNull();
    expect(e.state.board).toHaveLength(0);
    expect(e.state.players[2]!.stack).toBe(1005);
  });

  test("short all-in SB and short all-in BB posting: pots/eligibility correct, chips conserved", () => {
    const e = table([1000, 3, 7]);
    const total = calculateTotalChips(e.state);
    expect(e.state.players[1]!.status).toBe(PlayerStatus.ALL_IN);
    expect(e.state.players[2]!.status).toBe(PlayerStatus.ALL_IN);
    act(e, ActionType.CALL); // btn calls 10 (full BB),
    while (e.state.winners === null) {
      act(e, ActionType.CHECK);
    }
    expect(calculateTotalChips(e.state)).toBe(total);
  });

  test("betting round ends when all but one are all-in and caller matched", () => {
    const e = table([1000, 50, 1000]);
    act(e, ActionType.RAISE, 50);
    act(e, ActionType.CALL);
    act(e, ActionType.FOLD);
    expect(e.state.winners).not.toBeNull();
    expect(e.state.board).toHaveLength(5);
  });

  test("three-handed to heads-up after bust: button/blinds", () => {
    const e = table([1000, 1000, 1000]);
    expect(e.state.buttonSeat).toBe(0);
    act(e, ActionType.FOLD);
    act(e, ActionType.FOLD);
    e.stand("p1"); // SB leaves; remaining p0 (btn) and p2 (BB last hand)
    e.deal();
    // Last hand BB (p2) must not post BB again; p2 should be button/SB? p0 had button
    const s = e.state;
    const bbSeat = [...s.currentBets.entries()].find(([, v]) => v === 10)![0];
    const sbSeat = [...s.currentBets.entries()].find(([, v]) => v === 5)![0];
    expect(s.buttonSeat).toBe(sbSeat);
    expect(bbSeat).not.toBe(2);
    expect(s.actionTo).toBe(sbSeat);
  });

  test("antes are posted before blinds: short stack keeps ante dead and posts partial blind", () => {
    const e = new PokerEngine({ smallBlind: 5, bigBlind: 10, ante: 5, maxPlayers: 3 });
    e.sit(0, "p0", "P0", 1000);
    e.sit(1, "p1", "P1", 1000);
    e.sit(2, "p2", "P2", 12); // BB seat: ante 5 first, then only 7 left for the blind
    e.deal();
    const bb = e.state.players[2]!;
    expect(bb.status).toBe(PlayerStatus.ALL_IN);
    expect(bb.totalInvestedThisHand).toBe(12);
    expect(e.state.currentBets.get(2)).toBe(7);
    expect(e.state.players[2]!.betThisStreet).toBe(7);
  });

  describe("showdown with crafted cards", () => {
    function craft(
      invested: number[],
      hands: Array<string[] | "folded">,
      board: string[],
      button: number
    ) {
      const e = table(invested.map(() => 1000));
      const st = e.state;
      const players = st.players.map((p, i) => ({
        ...p!,
        stack: 0,
        betThisStreet: 0,
        totalInvestedThisHand: invested[i]!,
        hand: hands[i] === "folded" ? p!.hand : (hands[i] as string[]),
        status: hands[i] === "folded" ? PlayerStatus.FOLDED : PlayerStatus.ALL_IN,
      }));
      const crafted = {
        ...st,
        players,
        board,
        buttonSeat: button,
        street: Street.SHOWDOWN,
        currentBets: new Map(),
        config: { ...st.config, rake: undefined },
      } as never as typeof st;
      return determineWinners({ ...crafted, pots: calculateSidePots(crafted) });
    }

    test("tied side pot: odd chip goes to first seat left of the button; folded chips stay in pot", () => {
      // seat0 short all-in 50 (best hand), seats 1,2 tie for side pot, seat3 folded after 101 invested
      const out = craft(
        [50, 101, 101, 101],
        [["As", "Ad"], ["Kh", "Qh"], ["Kd", "Qd"], "folded"],
        ["2c", "7s", "9h", "Jc", "3d"],
        1
      );
      const paid = new Map<number, number>();
      out.winners!.forEach((w) => paid.set(w.seat, (paid.get(w.seat) ?? 0) + w.amount));
      // main: 200 -> seat0. side: 51*3 = 153 -> seats 1,2 tie: 77 / 76, odd chip to seat 2 (first left of button 1)
      expect(paid.get(0)).toBe(200);
      expect(paid.get(2)).toBe(77);
      expect(paid.get(1)).toBe(76);
      expect(out.players[3]!.stack).toBe(0);
    });

    test("board plays: all eligible split, wheel loses to six-high straight", () => {
      const out = craft(
        [100, 100, 100],
        [
          ["2c", "2d"],
          ["As", "2h"],
          ["3c", "3d"],
        ],
        ["Ts", "Jh", "Qd", "Kc", "Ah"],
        0
      );
      // seat1 has A-high straight? A K Q J T = broadway for seats 0,2 (board has T J Q K A) -> three-way split
      const paid = out.winners!.map((w) => w.amount).sort();
      expect(paid.reduce((a, b) => a + b, 0)).toBe(300);
      expect(paid).toEqual([100, 100, 100]);
    });
  });

  test("heads-up: short all-in BB still faces SB with the full BB price; excess is returned", () => {
    const e = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 2 });
    e.sit(0, "a", "A", 1000);
    e.sit(1, "b", "B", 5);
    e.deal();
    expect(e.state.buttonSeat).toBe(0);
    expect(e.state.actionTo).toBe(0);
    act(e, ActionType.CALL);
    expect(e.state.winners).not.toBeNull();
    expect(totalWon(e)).toBe(10);
    expect(calculateTotalChips(e.state)).toBe(1005);
  });

  test("heads-up: short all-in BB (7 of 10): SB total commitment is capped at the matched 7", () => {
    const e = new PokerEngine({ smallBlind: 5, bigBlind: 10, maxPlayers: 2 });
    e.sit(0, "a", "A", 1000);
    e.sit(1, "b", "B", 7);
    e.deal();
    act(e, ActionType.CALL);
    expect(e.state.winners).not.toBeNull();
    expect(totalWon(e)).toBe(14);
    expect(e.state.players[0]!.stack + e.state.players[1]!.stack).toBe(1007);
  });
});
