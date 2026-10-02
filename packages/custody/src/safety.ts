/**
 * Custody startup policy.
 *
 * Production requires safe custody configuration. The worker signs with per-chain treasury keys from
 * `TREASURY_SIGNING_KEYS_JSON`; no mnemonic/xpriv material is read or required.
 */
/**
 * Full production admission check; run after dotenv has loaded the environment.
 */
export function assertCustodyProcessSafety(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") return;

  const databaseUrl = env.DATABASE_URL ?? "";
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    throw new Error("CUSTODY_PRODUCTION_REQUIRES_POSTGRESQL");
  }

  const signingKeys = env.TREASURY_SIGNING_KEYS_JSON?.trim() ?? "";
  if (!signingKeys) {
    throw new Error("CUSTODY_PRODUCTION_REQUIRES_SIGNING_KEYS");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(signingKeys);
  } catch {
    throw new Error("CUSTODY_SIGNING_KEYS_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CUSTODY_SIGNING_KEYS_INVALID");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("CUSTODY_PRODUCTION_REQUIRES_SIGNING_KEYS");
  }
  for (const [chainId, key] of entries) {
    if (!/^[1-9][0-9]*$/.test(chainId)) throw new Error("CUSTODY_SIGNING_KEYS_INVALID");
    if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error("CUSTODY_SIGNING_KEYS_INVALID");
    }
  }
}
