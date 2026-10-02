/**
 * API startup policy, evaluated before opening DB/RPC/queue connections.
 *
 * - The public API process may never load custody/private-key material.
 * - Production admission requires compiled convergence evidence (the reviewed
 *   acceptance result) AND safe configuration. This is not a runtime flag: the
 *   evidence lives in `@pokertools/types` and is updated only by the final
 *   convergence commit, so an unverified build stays blocked.
 */
import {
  CONVERGENCE_EVIDENCE,
  isConvergenceVerified,
  type ConvergenceEvidence,
} from "@pokertools/types";

const FORBIDDEN_SECRETS = [
  "WALLET_XPRIV_ENCRYPTION_SECRET",
  "WALLET_XPRIV_ENCRYPTION_SECRET_FILE",
  "MASTER_MNEMONIC",
  "MASTER_MNEMONIC_FILE",
  "TREASURY_PRIVATE_KEY",
  "TREASURY_PRIVATE_KEY_FILE",
  "TREASURY_MNEMONIC",
  "TREASURY_XPRIV",
  "TREASURY_SIGNING_KEYS_JSON",
  "TREASURY_SIGNING_KEYS_JSON_FILE",
];

function assertProductionConfiguration(env: NodeJS.ProcessEnv): void {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    throw new Error("PRODUCTION_REQUIRES_POSTGRESQL");
  }
  if (!env.REDIS_URL?.trim()) {
    throw new Error("PRODUCTION_REQUIRES_REDIS_URL");
  }
  for (const name of ["JWT_SECRET", "COOKIE_SECRET"]) {
    const value = env[name]?.trim() ?? "";
    if (value.length < 32) {
      throw new Error(`PRODUCTION_REQUIRES_STRONG_${name}`);
    }
  }
  if (!env.CORS_ORIGIN?.trim()) {
    throw new Error("PRODUCTION_REQUIRES_CORS_ORIGIN");
  }
}

export function assertPublicProcessSafety(
  env: NodeJS.ProcessEnv,
  evidence: ConvergenceEvidence = CONVERGENCE_EVIDENCE
): void {
  if (FORBIDDEN_SECRETS.some((name) => Boolean(env[name]?.trim()))) {
    throw new Error("CUSTODY_SECRET_IN_PUBLIC_PROCESS");
  }
  if (env.NODE_ENV !== "production") return;
  if (!isConvergenceVerified(evidence)) {
    throw new Error("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  }
  assertProductionConfiguration(env);
}
