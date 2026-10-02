/**
 * Canonical runtime/wire contracts for @pokertools/types.
 *
 * This barrel is the single import surface for the next-major contracts:
 * principals and scoped service credentials, turn/observation/legal-action
 * decisions, canonical action submission, append-only events/chat/replay,
 * per-asset finance (amounts, balances, deposits, EIP-712 withdrawals) and
 * operational incidents/readiness.
 *
 * Schemas are transport contracts. They deliberately do not depend on any
 * environment, database, API or SDK package.
 */

export * from "./primitives";
export * from "./principal";
export * from "./masked-state";
export * from "./table";
export * from "./streams";
export * from "./finance";
export * from "./operations";
export * from "./tournament";
export * from "./competition";
export * from "./rest";
