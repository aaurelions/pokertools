/**
 * Compiled convergence evidence (shared by API and custody).
 *
 * Readiness/admission must never be enabled by a runtime configuration flag.
 * This module is the single machine-readable record that the mandatory
 * architecture and acceptance matrix has actually passed. It is updated only as
 * part of the reviewed final convergence commit; while `status` is `PENDING`
 * every readiness evaluation stays fail-closed.
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

/**
 * Verified acceptance record. `commit` is the implementation commit whose tree
 * was exercised by the acceptance matrix below; the evidence commit itself is
 * the reviewed release change on top of it.
 */
export const CONVERGENCE_EVIDENCE: ConvergenceEvidence = {
  status: "PASS",
  commit: "b00de49337d58a741fb37d0daff7b0a9cd4a23f0",
  verifiedAt: "2026-10-02T01:30:00.000Z",
  results: {
    workspaceInstall: true,
    workspaceBuild: true,
    workspaceTypecheck: true,
    workspaceLint: true,
    workspaceTests: true,
    postgresMigrations: true,
    loopbackWallet: true,
    solidityContracts: true,
    serviceGameplay: true,
    mixedWalletServiceGameplay: true,
    tenSeatMasking: true,
    redisLossRecovery: true,
    outboxCrashRecovery: true,
    timeoutActionRace: true,
    apiOnlyMultiTableTournament: true,
    twoChainMultiAssetAnvil: true,
    depositClaimReorg: true,
    custodyPersistBeforeBroadcast: true,
    ambiguousBroadcastRecovery: true,
    rpcQuorumDisagreement: true,
    treasuryReconciliation: true,
    gasStarvation: true,
    browserSdk: true,
    dockerE2E: true,
    runtimeDependencyAbsence: true,
    secretScanClean: true,
  },
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
