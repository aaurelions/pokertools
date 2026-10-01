/** Startup policy, evaluated before opening DB/RPC/queue connections. */
export function assertPublicProcessSafety(env: NodeJS.ProcessEnv): void {
  const forbiddenSecrets = [
    "WALLET_XPRIV_ENCRYPTION_SECRET",
    "WALLET_XPRIV_ENCRYPTION_SECRET_FILE",
    "MASTER_MNEMONIC",
    "MASTER_MNEMONIC_FILE",
    "TREASURY_PRIVATE_KEY",
    "TREASURY_PRIVATE_KEY_FILE",
    "TREASURY_MNEMONIC",
    "TREASURY_XPRIV",
  ];
  if (forbiddenSecrets.some((name) => Boolean(env[name]?.trim()))) {
    throw new Error("CUSTODY_SECRET_IN_PUBLIC_PROCESS");
  }
  // Deliberately no override: production is blocked until mandatory acceptance
  // demonstrates DB authority, asset accounting and exactly-once custody.
  if (env.NODE_ENV === "production") {
    throw new Error("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  }
}
