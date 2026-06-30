import { describe, expect, it } from "vitest";
import {
  computeTournamentPayouts,
  computeTournamentTableDistribution,
} from "../../src/utils/tournaments.js";

describe("tournament utilities", () => {
  it("computes balanced multi-table distributions", () => {
    expect(computeTournamentTableDistribution(30, 8)).toEqual([8, 8, 7, 7]);
    expect(computeTournamentTableDistribution(10, 4)).toEqual([4, 3, 3]);
    expect(computeTournamentTableDistribution(2, 10)).toEqual([2]);
  });

  it("rejects invalid distribution inputs", () => {
    expect(() => computeTournamentTableDistribution(1, 10)).toThrow(/at least two/);
    expect(() => computeTournamentTableDistribution(10, 1)).toThrow(/at least two/);
  });

  it("distributes all prize chips and awards rounding remainders to first place", () => {
    expect(computeTournamentPayouts(0, [100])).toEqual([0]);
    expect(computeTournamentPayouts(1, [50, 50])).toEqual([1, 0]);
    expect(computeTournamentPayouts(3, [50, 50])).toEqual([2, 1]);
    expect(computeTournamentPayouts(1001, [50, 30, 20])).toEqual([501, 300, 200]);
  });
});
