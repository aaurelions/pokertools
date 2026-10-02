/**
 * Authentication helpers for SIWE (Sign-In with Ethereum) and canonical
 * EIP-712 withdrawal intents.
 *
 * SIWE formatting/parsing delegates to maintained `viem/siwe` helpers.
 * Withdrawals are signed as canonical EIP-712 typed data; the SDK never
 * hand-builds a withdrawal message and never fabricates a wallet or service
 * credential.
 */

import {
  createSiweMessage as formatSiweMessage,
  parseSiweMessage,
  validateSiweMessage,
  type CreateSiweMessageParameters,
} from "viem/siwe";
import type {
  Eip712Domain,
  Eip712TypedData,
  WithdrawalIntent,
  WithdrawalSubmission,
} from "@pokertools/types";
import { withdrawalIntentTypedData } from "@pokertools/types";

export { parseSiweMessage } from "viem/siwe";

const DEFAULT_CHAIN_ID = 1;

/**
 * SIWE message parameters
 */
export interface SiweMessageParams extends Omit<
  CreateSiweMessageParameters,
  "chainId" | "version" | "issuedAt" | "expirationTime" | "notBefore"
> {
  /** Domain making the request (e.g., "poker.example.com") */
  domain: string;
  /** Ethereum address (checksummed) */
  address: `0x${string}`;
  /** Human-readable statement (optional) */
  statement?: string;
  /** URI of the signing resource */
  uri: string;
  /** Current version of the message (always "1") */
  version?: "1";
  /** Chain ID */
  chainId?: number;
  /** Nonce from server */
  nonce: string;
  /** Issued at timestamp (ISO 8601) */
  issuedAt?: string | Date;
  /** Expiration time (ISO 8601) */
  expirationTime?: string | Date;
  /** Not before time (ISO 8601) */
  notBefore?: string | Date;
  /** Request ID */
  requestId?: string;
  /** Resources (URIs) */
  resources?: string[];
}

/**
 * Create a SIWE message string for signing
 *
 * @example
 * ```typescript
 * import { createSiweMessage } from "@pokertools/sdk";
 *
 * // Get nonce from server
 * const nonce = await client.getNonce();
 *
 * // Create message
 * const message = createSiweMessage({
 *   domain: "poker.example.com",
 *   address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
 *   uri: "https://poker.example.com",
 *   nonce,
 *   statement: "Sign in to PokerTools",
 * });
 *
 * // Sign with wallet (e.g., wagmi, ethers, viem)
 * const signature = await signMessage({ message });
 *
 * // Login
 * const { token, user } = await client.login({ message, signature });
 * ```
 */
export function createSiweMessage(params: SiweMessageParams): string {
  return formatSiweMessage({
    ...params,
    version: params.version ?? "1",
    chainId: params.chainId ?? DEFAULT_CHAIN_ID,
    issuedAt: params.issuedAt === undefined ? new Date() : new Date(params.issuedAt),
    expirationTime:
      params.expirationTime === undefined ? undefined : new Date(params.expirationTime),
    notBefore: params.notBefore === undefined ? undefined : new Date(params.notBefore),
  });
}

/**
 * Check if a SIWE message is expired
 */
export function isSiweExpired(message: string): boolean {
  const parsed = parseSiweMessage(message);
  // Display convenience only, never authentication authority. Malformed and
  // not-yet-valid messages fail closed rather than appearing usable.
  return (
    !parsed.uri ||
    !parsed.nonce ||
    parsed.version !== "1" ||
    !parsed.issuedAt ||
    !Number.isFinite(parsed.issuedAt.getTime()) ||
    !validateSiweMessage({ message: parsed })
  );
}

/**
 * Signer shape structurally compatible with a viem wallet/account client
 * bound to the authenticating principal. Callers supply their own signer so
 * the SDK never creates or holds a wallet.
 */
export interface WithdrawalTypedDataSigner {
  signTypedData(args: {
    domain: Eip712TypedData["domain"];
    types: Eip712TypedData["types"];
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Build the canonical EIP-712 typed data for a withdrawal intent.
 *
 * Uses the shared `@pokertools/types` helper so the signed payload is the
 * exact contract the API and custody boundary validate. The domain name and
 * version are fixed by the shared contract.
 */
export function createWithdrawalTypedData(
  intent: WithdrawalIntent,
  domain: Eip712Domain
): Eip712TypedData {
  return withdrawalIntentTypedData(intent, domain);
}

/**
 * Sign a canonical withdrawal intent as EIP-712 typed data.
 *
 * The API rebuilds the signature input from the intent, so the submission
 * carries only the intent and signature.
 *
 * @param signer - Principal-bound viem-compatible signer (never supplied by SDK).
 * @param intent - Canonical withdrawal intent including `intentId` and `nonce`.
 * @param domain - Fixed EIP-712 domain for the custody contract.
 * @returns The signed submission to POST to `/finance/withdrawals/intents`.
 */
export async function signWithdrawalIntent(
  signer: WithdrawalTypedDataSigner,
  intent: WithdrawalIntent,
  domain: Eip712Domain
): Promise<WithdrawalSubmission> {
  const typedData = createWithdrawalTypedData(intent, domain);
  const signature = await signer.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  return { intent, signature };
}

/**
 * Generate a random idempotency key
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}
