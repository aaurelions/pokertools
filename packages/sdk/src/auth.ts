/**
 * Authentication helpers for SIWE (Sign-In with Ethereum)
 *
 * These utilities help construct SIWE messages for wallet signing.
 */

import {
  createSiweMessage as formatSiweMessage,
  parseSiweMessage,
  validateSiweMessage,
  type CreateSiweMessageParameters,
} from "viem/siwe";

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
 * Create a withdrawal message for signing
 *
 * Includes nonce and timestamp to prevent replay attacks.
 *
 * @param amount - Amount in USD
 * @param destinationAddress - Destination Ethereum address
 * @param nonce - Unique nonce to prevent replay (recommended: use generateIdempotencyKey())
 * @param timestamp - Unix timestamp in milliseconds (defaults to now)
 *
 * @example
 * ```typescript
 * const nonce = generateIdempotencyKey();
 * const message = createWithdrawalMessage(100, "0x...", nonce);
 * const signature = await signMessage({ message });
 * await client.withdraw({
 *   amount: 100, address: "0x...", blockchainId, tokenId,
 *   message, signature, idempotencyKey: nonce
 * });
 * ```
 */
export function createWithdrawalMessage(
  amount: number,
  destinationAddress: string,
  nonce: string,
  timestamp?: number
): string {
  const ts = timestamp ?? Date.now();
  const baseMsg = `Withdraw ${amount} USD to ${destinationAddress}`;
  return `${baseMsg}\nNonce: ${nonce}\nTimestamp: ${ts}`;
}

/**
 * Generate a random idempotency key
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}
