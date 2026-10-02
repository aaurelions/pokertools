/**
 * Compiled convergence evidence (shared by API and custody).
 *
 * Readiness/admission must never be enabled by a runtime configuration flag.
 * This module is the single machine-readable record that the mandatory
 * architecture and acceptance matrix has actually passed. It is updated only as
 * part of the reviewed final convergence commit; while `status` is `PENDING`
 * (the shipped pre-acceptance state) every readiness evaluation stays
 * fail-closed.
 */

export interface ConvergenceEvidence {
  status: "PASS" | "FAIL" | "PENDING";
  /** Commit SHA accepted by the final verification run. */
  commit: string;
  /** ISO-8601 time of the accepted verification run. */
  verifiedAt: string;
  /** Mandatory acceptance results; all must be true when status is PASS. */
  results: Readonly<Record<string, boolean>>;
}

/** Pre-acceptance evidence. Updated exactly once, at final convergence. */
export const CONVERGENCE_EVIDENCE: ConvergenceEvidence = {
  status: "PENDING",
  commit: "",
  verifiedAt: "",
  results: {},
};

/**
 * True only when the compiled evidence is a complete PASS. A malformed or
 * partial record is treated as not verified.
 */
export function isConvergenceVerified(
  evidence: ConvergenceEvidence = CONVERGENCE_EVIDENCE
): boolean {
  if (evidence.status !== "PASS") return false;
  if (typeof evidence.commit !== "string" || evidence.commit.length === 0) return false;
  if (typeof evidence.verifiedAt !== "string" || evidence.verifiedAt.length === 0) return false;
  const entries = Object.entries(evidence.results);
  return entries.length > 0 && entries.every(([, passed]) => passed === true);
}
