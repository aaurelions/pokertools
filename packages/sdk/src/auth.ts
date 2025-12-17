/**
 * Authentication helpers for SIWE (Sign-In with Ethereum)
 *
 * These utilities help construct SIWE messages for wallet signing.
 */

/**
 * SIWE message parameters
 */
export interface SiweMessageParams {
  /** Domain making the request (e.g., "poker.example.com") */
  domain: string;
  /** Ethereum address (checksummed) */
  address: string;
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
  issuedAt?: string;
  /** Expiration time (ISO 8601) */
  expirationTime?: string;
  /** Not before time (ISO 8601) */
  notBefore?: string;
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
  const {
    domain,
    address,
    statement,
    uri,
    version = "1",
    chainId = 1,
    nonce,
    issuedAt = new Date().toISOString(),
    expirationTime,
    notBefore,
    requestId,
    resources,
  } = params;

  // Build message following EIP-4361 spec
  const lines: string[] = [];

  // Header
  lines.push(`${domain} wants you to sign in with your Ethereum account:`);
  lines.push(address);

  // Statement (optional)
  if (statement) {
    lines.push("");
    lines.push(statement);
  }

  // Required fields
  lines.push("");
  lines.push(`URI: ${uri}`);
  lines.push(`Version: ${version}`);
  lines.push(`Chain ID: ${chainId}`);
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Issued At: ${issuedAt}`);

  // Optional fields
  if (expirationTime) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  if (notBefore) {
    lines.push(`Not Before: ${notBefore}`);
  }
  if (requestId) {
    lines.push(`Request ID: ${requestId}`);
  }
  if (resources && resources.length > 0) {
    lines.push(`Resources:`);
    for (const resource of resources) {
      lines.push(`- ${resource}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse a SIWE message string back into params
 */
export function parseSiweMessage(message: string): Partial<SiweMessageParams> {
  const lines = message.split("\n");
  const result: Partial<SiweMessageParams> = {};

  // First line: domain
  const domainMatch = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0]);
  if (domainMatch) {
    result.domain = domainMatch[1];
  }

  // Second line: address
  if (lines[1]) {
    result.address = lines[1];
  }

  // Parse key-value pairs
  for (const line of lines) {
    if (line.startsWith("URI: ")) {
      result.uri = line.slice(5);
    } else if (line.startsWith("Version: ")) {
      result.version = line.slice(9) as "1";
    } else if (line.startsWith("Chain ID: ")) {
      result.chainId = parseInt(line.slice(10), 10);
    } else if (line.startsWith("Nonce: ")) {
      result.nonce = line.slice(7);
    } else if (line.startsWith("Issued At: ")) {
      result.issuedAt = line.slice(11);
    } else if (line.startsWith("Expiration Time: ")) {
      result.expirationTime = line.slice(17);
    } else if (line.startsWith("Not Before: ")) {
      result.notBefore = line.slice(12);
    } else if (line.startsWith("Request ID: ")) {
      result.requestId = line.slice(12);
    }
  }

  // Parse statement (lines between address and URI)
  const uriIndex = lines.findIndex((l) => l.startsWith("URI: "));
  if (uriIndex > 3) {
    const statementLines = lines.slice(3, uriIndex - 1).filter((l) => l.trim());
    if (statementLines.length > 0) {
      result.statement = statementLines.join("\n");
    }
  }

  return result;
}

/**
 * Check if a SIWE message is expired
 */
export function isSiweExpired(message: string): boolean {
  const parsed = parseSiweMessage(message);
  if (!parsed.expirationTime) {
    return false;
  }
  return new Date(parsed.expirationTime) < new Date();
}

/**
 * Create a withdrawal message for signing
 *
 * @example
 * ```typescript
 * const message = createWithdrawalMessage(100, "0x...");
 * const signature = await signMessage({ message });
 * await client.withdraw({ amount: 100, address: "0x...", message, signature, ... });
 * ```
 */
export function createWithdrawalMessage(amount: number, destinationAddress: string): string {
  return `Withdraw ${amount} USD to ${destinationAddress}`;
}

/**
 * Generate a random idempotency key
 * Uses crypto.randomUUID if available, otherwise falls back to timestamp + random
 */
export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${Math.random().toString(36).substr(2, 9)}`;
}

