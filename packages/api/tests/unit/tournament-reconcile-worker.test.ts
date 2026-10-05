import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Durable tournament-reconcile intent execution contract.
 *
 * The worker must acknowledge the outbox row only when the director pass
 * converged; an iteration-cap deferral is retryable, a vanished tournament is a
 * terminal no-op, and the actor is the real public caller when present or a
 * namespaced system actor for background completions (never a forged caller).
 */

const reconcileTournament = vi.fn();

vi.mock("../../src/services/tournament-director.js", () => ({
  reconcileTournament: (...args: unknown[]) => reconcileTournament(...args),
}));

const { executeTournamentReconcileIntent, SYSTEM_TOURNAMENT_DIRECTOR_ACTOR } =
  await import("../../src/workers/tournament-reconcile-handler.js");
const { AppError } = await import("../../src/utils/errors.js");

const context = { marker: "context" } as never;
const payload = {
  tournamentId: "tournament-1",
  tableId: "table-1",
  handId: "table-1_hand-1",
  actorId: null,
};

describe("executeTournamentReconcileIntent", () => {
  beforeEach(() => {
    reconcileTournament.mockReset();
  });

  it("forwards the real public actor when the completion had a caller", async () => {
    reconcileTournament.mockResolvedValue({ converged: true });
    await executeTournamentReconcileIntent(context, { ...payload, actorId: "principal-1" });
    expect(reconcileTournament).toHaveBeenCalledWith(context, "tournament-1", "principal-1");
  });

  it("substitutes a namespaced system actor for background completions", async () => {
    reconcileTournament.mockResolvedValue({ converged: true });
    await executeTournamentReconcileIntent(context, payload);
    expect(reconcileTournament).toHaveBeenCalledWith(
      context,
      "tournament-1",
      SYSTEM_TOURNAMENT_DIRECTOR_ACTOR
    );
    expect(SYSTEM_TOURNAMENT_DIRECTOR_ACTOR).toContain("system:");
  });

  it("throws when the director deferred at the iteration cap so the row stays retryable", async () => {
    reconcileTournament.mockResolvedValue({ converged: false });
    await expect(executeTournamentReconcileIntent(context, payload)).rejects.toThrow(
      "iteration cap"
    );
  });

  it("treats a vanished tournament as a terminal no-op", async () => {
    reconcileTournament.mockRejectedValue(
      new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND")
    );
    await expect(executeTournamentReconcileIntent(context, payload)).resolves.toBeUndefined();
  });

  it("propagates other director failures for bounded retry", async () => {
    reconcileTournament.mockRejectedValue(new Error("transient database failure"));
    await expect(executeTournamentReconcileIntent(context, payload)).rejects.toThrow(
      "transient database failure"
    );
  });

  it("rejects a malformed durable identity before touching the director", async () => {
    await expect(
      executeTournamentReconcileIntent(context, { ...payload, handId: "" })
    ).rejects.toThrow("durable tournament/table/hand identity");
    expect(reconcileTournament).not.toHaveBeenCalled();
  });
});
