import { describe, expect, it } from "vitest";
import {
  computeTournamentPayouts,
  computeTournamentTableDistribution,
  defaultBlindStructure,
  validateBlindStructure,
  MAX_TOURNAMENT_TABLES,
  MAX_RECONCILE_ITERATIONS,
} from "../../src/utils/tournaments.js";

describe("tournament utilities", () => {
  it("computes balanced multi-table distributions", () => {
    expect(computeTournamentTableDistribution(30, 8)).toEqual([8, 8, 7, 7]);
    expect(computeTournamentTableDistribution(10, 4)).toEqual([4, 3, 3]);
    expect(computeTournamentTableDistribution(2, 10)).toEqual([2]);
  });

  it("rejects invalid distribution inputs", () => {
    expect(() => computeTournamentTableDistribution(1, 10)).toThrow(/at least two/);
    expect(() => computeTournamentTableDistribution(10, 1)).toThrow(/between 2 and 10/);
    expect(() => computeTournamentTableDistribution(10, 11)).toThrow(/between 2 and 10/);
  });

  it("rejects distributions that would exceed maximum table count", () => {
    // 101 players with tableMax 10 = 11 tables -> rejected
    expect(() => computeTournamentTableDistribution(101, 10)).toThrow(/would require 11 tables/);
    // 100 players with tableMax 10 = 10 tables -> accepted
    const dist = computeTournamentTableDistribution(100, 10);
    expect(dist).toHaveLength(MAX_TOURNAMENT_TABLES);
    expect(dist).toEqual(Array(10).fill(10));
  });

  it("distributes all prize chips and awards rounding remainders to first place", () => {
    expect(computeTournamentPayouts(0, [100])).toEqual([0]);
    expect(computeTournamentPayouts(1, [50, 50])).toEqual([1, 0]);
    expect(computeTournamentPayouts(3, [50, 50])).toEqual([2, 1]);
    expect(computeTournamentPayouts(1001, [50, 30, 20])).toEqual([501, 300, 200]);
  });

  describe("blind structure validation", () => {
    it("accepts a valid strictly increasing blind structure", () => {
      expect(() =>
        validateBlindStructure([
          { smallBlind: 25, bigBlind: 50, ante: 0 },
          { smallBlind: 50, bigBlind: 100, ante: 25 },
          { smallBlind: 100, bigBlind: 200, ante: 50 },
        ])
      ).not.toThrow();
    });

    it("accepts empty and single-level structures", () => {
      expect(() => validateBlindStructure([])).not.toThrow();
      expect(() =>
        validateBlindStructure([{ smallBlind: 10, bigBlind: 20, ante: 0 }])
      ).not.toThrow();
    });

    it("rejects non-increasing blind structures", () => {
      expect(() =>
        validateBlindStructure([
          { smallBlind: 50, bigBlind: 100, ante: 0 },
          { smallBlind: 25, bigBlind: 50, ante: 0 }, // decreased
        ])
      ).toThrow(/blinds must strictly increase/);

      // SB increases but BB stays the same between levels
      expect(() =>
        validateBlindStructure([
          { smallBlind: 25, bigBlind: 100, ante: 0 },
          { smallBlind: 50, bigBlind: 100, ante: 0 },
        ])
      ).toThrow(/blinds must strictly increase/);
    });

    it("rejects levels where big blind is not greater than small blind", () => {
      expect(() => validateBlindStructure([{ smallBlind: 100, bigBlind: 50, ante: 0 }])).toThrow(
        /big blind.*must be greater than small blind/
      );
    });

    it("rejects equal consecutive levels", () => {
      expect(() =>
        validateBlindStructure([
          { smallBlind: 50, bigBlind: 100, ante: 0 },
          { smallBlind: 50, bigBlind: 100, ante: 0 },
        ])
      ).toThrow(/blinds must strictly increase/);
    });
  });

  it("generates a 20-level geometric blind structure that passes validation", () => {
    const levels = defaultBlindStructure(25, 50);
    expect(levels).toHaveLength(20);

    // Verify strictly-increasing small blinds across all 20 levels.
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].smallBlind).toBeGreaterThan(levels[i - 1].smallBlind);
    }

    // Structure must satisfy the shared validateBlindStructure guard.
    expect(() => validateBlindStructure(levels)).not.toThrow();

    // Antes should be zero for the first three levels and then strictly positive.
    for (let i = 0; i < 3; i++) {
      expect(levels[i].ante).toBe(0);
    }
    for (let i = 3; i < levels.length; i++) {
      expect(levels[i].ante).toBeGreaterThan(0);
    }
  });

  it("exports reasonable reconciliation constants", () => {
    expect(MAX_TOURNAMENT_TABLES).toBe(10);
    expect(MAX_RECONCILE_ITERATIONS).toBeGreaterThanOrEqual(3);
    expect(MAX_RECONCILE_ITERATIONS).toBeLessThanOrEqual(10);
  });
});
