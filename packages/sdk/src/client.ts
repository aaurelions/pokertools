/**
 * PokerClient - HTTP client for PokerTools REST API
 *
 * Provides type-safe methods for all API endpoints with automatic
 * retry, authentication, and error handling.
 */

import type {
  PublicState,
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  GameActionRequest,
  LoginRequest,
  LoginResponse,
  NonceResponse,
  TableListItem,
} from "@pokertools/types";

import {
  PokerSDKConfig,
  PokerSDKError,
  UserProfile,
  BlockchainInfo,
  DepositSession,
  DepositRecord,
  WithdrawalRequest,
  WithdrawalRecord,
  HandHistoryEntry,
  PlayerNote,
} from "./types";

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  timeout: 30000,
  retry: {
    count: 3,
    delay: 1000,
    backoff: 2,
  },
};

/**
 * PokerClient - Main HTTP client for PokerTools API
 *
 * @example
 * ```typescript
 * const client = new PokerClient({
 *   baseUrl: "https://api.poker.example.com",
 *   token: "jwt-token",
 * });
 *
 * // Get tables
 * const tables = await client.getTables();
 *
 * // Create a table
 * const tableId = await client.createTable({
 *   name: "My Table",
 *   mode: "CASH",
 *   smallBlind: 5,
 *   bigBlind: 10,
 *   maxPlayers: 6,
 * });
 *
 * // Buy in
 * await client.buyIn(tableId, {
 *   amount: 500,
 *   seat: 3,
 *   idempotencyKey: crypto.randomUUID(),
 * });
 * ```
 */
export class PokerClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retry: Required<NonNullable<PokerSDKConfig["retry"]>>;
  private readonly fetchFn: typeof fetch;
  private readonly debug: boolean;

  private token: string | null;

  constructor(config: PokerSDKConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = config.timeout ?? DEFAULT_CONFIG.timeout;
    this.retry = {
      count: config.retry?.count ?? DEFAULT_CONFIG.retry.count,
      delay: config.retry?.delay ?? DEFAULT_CONFIG.retry.delay,
      backoff: config.retry?.backoff ?? DEFAULT_CONFIG.retry.backoff,
    };
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.debug = config.debug ?? false;
    this.token = config.token ?? null;
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Set the authentication token
   */
  setToken(token: string | null): void {
    this.token = token;
  }

  /**
   * Get current token
   */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Check if client is authenticated
   */
  isAuthenticated(): boolean {
    return this.token !== null;
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  /**
   * Get a nonce for SIWE authentication
   */
  async getNonce(): Promise<string> {
    const response = await this.request<NonceResponse>("POST", "/auth/nonce");
    return response.nonce;
  }

  /**
   * Login with SIWE signature
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>("POST", "/auth/login", request);
    this.token = response.token;
    return response;
  }

  /**
   * Logout and revoke session
   */
  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout");
    this.token = null;
  }

  // ============================================================================
  // Tables
  // ============================================================================

  /**
   * Get list of active tables
   */
  async getTables(): Promise<TableListItem[]> {
    const response = await this.request<{ tables: TableListItem[] }>("GET", "/tables");
    return response.tables;
  }

  /**
   * Create a new table
   */
  async createTable(config: CreateTableRequest): Promise<string> {
    const response = await this.request<{ tableId: string }>("POST", "/tables", config);
    return response.tableId;
  }

  /**
   * Get table state
   * @param tableId - Table ID
   * @param since - Optional version for conditional fetch (returns null if unchanged)
   */
  async getTableState(tableId: string, since?: number): Promise<PublicState | null> {
    const query = since !== undefined ? `?since=${since}` : "";
    try {
      const response = await this.request<{ state: PublicState }>(
        "GET",
        `/tables/${tableId}${query}`
      );
      return response.state;
    } catch (error) {
      if (error instanceof PokerSDKError && error.statusCode === 304) {
        return null; // Not modified
      }
      throw error;
    }
  }

  /**
   * Buy in to a table
   */
  async buyIn(tableId: string, request: BuyInRequest): Promise<void> {
    await this.request("POST", `/tables/${tableId}/buy-in`, request);
  }

  /**
   * Execute a game action
   */
  async action(tableId: string, request: GameActionRequest): Promise<PublicState> {
    const response = await this.request<{ state: PublicState }>(
      "POST",
      `/tables/${tableId}/action`,
      request
    );
    return response.state;
  }

  /**
   * Add chips to stack (rebuy/top-up)
   */
  async addChips(tableId: string, request: AddChipsRequest): Promise<void> {
    await this.request("POST", `/tables/${tableId}/add-chips`, request);
  }

  /**
   * Stand from table (leave and cash out)
   */
  async stand(tableId: string): Promise<void> {
    await this.request("POST", `/tables/${tableId}/stand`);
  }

  // ============================================================================
  // Convenience Action Methods
  // ============================================================================

  /**
   * Fold hand
   */
  async fold(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "FOLD" });
  }

  /**
   * Check (pass action)
   */
  async check(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "CHECK" });
  }

  /**
   * Call current bet
   */
  async call(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "CALL" });
  }

  /**
   * Place a bet
   */
  async bet(tableId: string, amount: number): Promise<PublicState> {
    return this.action(tableId, { type: "BET", amount });
  }

  /**
   * Raise the current bet
   */
  async raise(tableId: string, amount: number): Promise<PublicState> {
    return this.action(tableId, { type: "RAISE", amount });
  }

  /**
   * Deal new hand
   */
  async deal(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "DEAL" });
  }

  /**
   * Show cards at showdown
   */
  async show(tableId: string, cardIndices?: number[]): Promise<PublicState> {
    return this.action(tableId, { type: "SHOW", cardIndices });
  }

  /**
   * Muck cards at showdown
   */
  async muck(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "MUCK" });
  }

  /**
   * Use time bank
   */
  async timeBank(tableId: string): Promise<PublicState> {
    return this.action(tableId, { type: "TIME_BANK" });
  }

  // ============================================================================
  // User
  // ============================================================================

  /**
   * Get current user profile and balances
   */
  async getProfile(): Promise<UserProfile> {
    return this.request<UserProfile>("GET", "/user/me");
  }

  /**
   * Get hand history
   */
  async getHandHistory(): Promise<HandHistoryEntry[]> {
    const response = await this.request<{ history: HandHistoryEntry[] }>("GET", "/user/history");
    return response.history;
  }

  /**
   * Request a withdrawal
   */
  async withdraw(request: WithdrawalRequest): Promise<{
    id: string;
    status: string;
    amount: number;
    destination: string;
    blockchain: string;
    token: string;
  }> {
    return this.request("POST", "/user/withdraw", request);
  }

  /**
   * Get withdrawal history
   */
  async getWithdrawals(): Promise<WithdrawalRecord[]> {
    const response = await this.request<{ withdrawals: WithdrawalRecord[] }>(
      "GET",
      "/user/withdrawals"
    );
    return response.withdrawals;
  }

  // ============================================================================
  // Finance
  // ============================================================================

  /**
   * Get supported blockchains and tokens
   */
  async getChains(): Promise<BlockchainInfo[]> {
    return this.request<BlockchainInfo[]>("GET", "/finance/chains");
  }

  /**
   * Start deposit monitoring session
   */
  async startDeposit(): Promise<DepositSession> {
    return this.request<DepositSession>("POST", "/finance/deposit/start");
  }

  /**
   * Get deposit address
   */
  async getDepositAddress(): Promise<string> {
    const response = await this.request<{ address: string }>("GET", "/finance/deposit/address");
    return response.address;
  }

  /**
   * Get deposit history
   */
  async getDeposits(): Promise<DepositRecord[]> {
    const response = await this.request<{ deposits: DepositRecord[] }>("GET", "/finance/deposits");
    return response.deposits;
  }

  // ============================================================================
  // Notes
  // ============================================================================

  /**
   * Get all notes by current user
   */
  async getNotes(): Promise<PlayerNote[]> {
    const response = await this.request<{ notes: PlayerNote[] }>("GET", "/notes");
    return response.notes;
  }

  /**
   * Get note for specific player
   */
  async getNote(targetId: string): Promise<PlayerNote | null> {
    const response = await this.request<{ note: PlayerNote | null }>("GET", `/notes/${targetId}`);
    return response.note;
  }

  /**
   * Save or update note
   */
  async saveNote(targetId: string, content: string, label?: string): Promise<PlayerNote> {
    const response = await this.request<{ note: PlayerNote }>("POST", "/notes", {
      targetId,
      content,
      label,
    });
    return response.note;
  }

  /**
   * Delete note
   */
  async deleteNote(targetId: string): Promise<void> {
    await this.request("DELETE", `/notes/${targetId}`);
  }

  // ============================================================================
  // Health
  // ============================================================================

  /**
   * Health check
   */
  async health(): Promise<{ status: string; timestamp: number }> {
    return this.request("GET", "/health");
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Make HTTP request with retry logic
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retry.count; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        if (this.debug) {
          console.log(`[PokerSDK] ${method} ${path}`, body);
        }

        const response = await this.fetchFn(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle 304 Not Modified
        if (response.status === 304) {
          throw new PokerSDKError("Not Modified", "NOT_MODIFIED", 304);
        }

        // Handle non-2xx responses
        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
            code?: string;
          };

          throw new PokerSDKError(
            errorData.message ?? errorData.error ?? `HTTP ${response.status}`,
            errorData.code ?? errorData.error ?? "HTTP_ERROR",
            response.status,
            errorData
          );
        }

        const data = (await response.json()) as T;

        if (this.debug) {
          console.log(`[PokerSDK] Response:`, data);
        }

        return data;
      } catch (error) {
        lastError = error as Error;

        // Don't retry client errors (4xx) except rate limiting
        if (error instanceof PokerSDKError) {
          if (
            error.statusCode &&
            error.statusCode >= 400 &&
            error.statusCode < 500 &&
            error.statusCode !== 429
          ) {
            throw error;
          }
        }

        // Don't retry on abort
        if (error instanceof Error && error.name === "AbortError") {
          throw new PokerSDKError("Request timeout", "TIMEOUT", undefined, {
            timeout: this.timeout,
          });
        }

        // Retry with backoff
        if (attempt < this.retry.count) {
          const delay = this.retry.delay * Math.pow(this.retry.backoff, attempt);
          if (this.debug) {
            console.log(`[PokerSDK] Retry ${attempt + 1}/${this.retry.count} in ${delay}ms`);
          }
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new PokerSDKError("Request failed", "REQUEST_FAILED");
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
