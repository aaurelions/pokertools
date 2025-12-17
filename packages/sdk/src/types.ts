/**
 * SDK-specific types and configuration
 */

/**
 * SDK configuration options
 */
export interface PokerSDKConfig {
  /** Base URL of the PokerTools API (e.g., "https://api.poker.example.com") */
  baseUrl: string;

  /** WebSocket URL (defaults to baseUrl with ws:// protocol) */
  wsUrl?: string;

  /** JWT token for authentication */
  token?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Retry configuration */
  retry?: {
    /** Number of retries for failed requests (default: 3) */
    count?: number;
    /** Delay between retries in ms (default: 1000) */
    delay?: number;
    /** Exponential backoff multiplier (default: 2) */
    backoff?: number;
  };

  /** Custom fetch implementation (for React Native or custom environments) */
  fetch?: typeof fetch;

  /** Custom WebSocket implementation (for React Native or Node.js) */
  WebSocket?: typeof WebSocket;

  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Authentication state
 */
export interface AuthState {
  token: string | null;
  user: {
    id: string;
    username: string;
    address: string;
  } | null;
  isAuthenticated: boolean;
}

/**
 * User balance information
 */
export interface UserBalances {
  main: number;
  inPlay: number;
}

/**
 * User profile with balances
 */
export interface UserProfile {
  id: string;
  username: string;
  address: string;
  role: "PLAYER" | "ADMIN" | "BOT";
  createdAt: string;
  balances: UserBalances;
}

/**
 * Blockchain configuration
 */
export interface BlockchainInfo {
  id: string;
  name: string;
  chainId: number;
  tokens: TokenInfo[];
}

/**
 * Token configuration
 */
export interface TokenInfo {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  minDeposit: string;
}

/**
 * Deposit session info
 */
export interface DepositSession {
  address: string;
  expiresAt: string;
  message: string;
}

/**
 * Deposit record
 */
export interface DepositRecord {
  id: string;
  txHash: string | null;
  chain: string;
  token: string;
  amountRaw: string;
  amountCredit: number;
  status: "PENDING" | "PROCESSING" | "CONFIRMED" | "FAILED";
  createdAt: string;
  confirmedAt: string | null;
  explorerUrl: string;
}

/**
 * Withdrawal request
 */
export interface WithdrawalRequest {
  amount: number;
  blockchainId: string;
  tokenId: string;
  address: string;
  message: string;
  signature: `0x${string}`;
}

/**
 * Withdrawal record
 */
export interface WithdrawalRecord {
  id: string;
  txHash: string | null;
  chain: string;
  token: string;
  address: string;
  amountRaw: string;
  amountUSD: number;
  status: "PENDING" | "PROCESSING" | "CONFIRMED" | "FAILED" | "REJECTED" | "CANCELLED";
  createdAt: string;
  confirmedAt: string | null;
  explorerUrl: string | null;
}

/**
 * Hand history entry (simplified)
 */
export interface HandHistoryEntry {
  id: string;
  amount: number;
  type: "HAND_WIN" | "HAND_LOSS";
  referenceId: string | null;
  createdAt: string;
}

/**
 * Player note
 */
export interface PlayerNote {
  id: string;
  targetId: string;
  content: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  target?: {
    id: string;
    username: string;
  };
}

/**
 * SDK error class
 */
export class PokerSDKError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PokerSDKError";
  }
}

/**
 * WebSocket connection state
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Event emitter types
 */
export interface PokerSocketEvents {
  connect: () => void;
  disconnect: (reason?: string) => void;
  reconnect: (attempt: number) => void;
  error: (error: Error) => void;
  stateUpdate: (tableId: string, state: import("@pokertools/types").PublicState) => void;
  snapshot: (tableId: string, state: import("@pokertools/types").PublicState) => void;
  action: (tableId: string, playerId: string, actionType: string, amount?: number) => void;
}

/**
 * Type-safe event listener
 */
export type EventListener<T extends keyof PokerSocketEvents> = PokerSocketEvents[T];
