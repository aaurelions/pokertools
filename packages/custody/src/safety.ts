/** Do not load signing material while production acceptance is incomplete. */
export function assertCustodyProcessSafety(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error("ARCHITECTURE_CONVERGENCE_INCOMPLETE");
  }
}
