/**
 * PokerClient - HTTP client for PokerTools REST API
 *
 * Provides type-safe methods for all API endpoints with automatic
 * retry, authentication, and error handling.
 *
 * Gameplay uses the canonical turn/observation/action protocol: the server
 * issues the legal actions for the acting seat and the client echoes an opaque
 * `actionId` back with a stable `requestId`. The SDK never derives legality
 * from client engine assumptions.
 */

import type {
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  LoginRequest,
  LoginResponse,
  TableListItem,
  TournamentDetails,
  TournamentListItem,
  CreateTournamentRequest,
  RegisterTournamentRequest,
  StartTournamentResponse,
  ReconcileTournamentResponse,
  SettleTournamentResponse,
  HealthResponse,
  ReadinessResponse,
  UserProfile,
  HandHistoryEntry,
  PlayerNote,
  // Canonical wire contracts
  SeatObservation,
  LegalAction,
  LegalActionFamily,
  CanonicalActionRequest,
  CanonicalActionResult,
  PublicWireState,
  Principal,
  ChatMessage,
  ChatPage,
  ReplayFrame,
  CredentialId,
  CreateServiceCredentialRequest,
  CreatedServiceCredential,
  ServiceCredentialSummary,
  Asset,
  Balance as AssetBalance,
  DepositClaim,
  DepositClaimRequest,
  WithdrawalSubmission,
  WithdrawalRecord,
} from "@pokertools/types";
import {
  HealthResponseSchema,
  ReadinessResponseSchema,
  PrincipalSchema,
  ChatMessageSchema,
  ChatPageSchema,
  ReplayFrameSchema,
  CreateServiceCredentialRequestSchema,
  CreatedServiceCredentialSchema,
  ListServiceCredentialsResponseSchema,
  RevokeServiceCredentialResponseSchema,
  GetTablesResponseSchema,
  GetTableStateResponseSchema,
  SeatObservationSchema,
  CanonicalActionRequestSchema,
  CanonicalActionResultSchema,
  AssetSchema,
  BalanceSchema,
  DepositClaimSchema,
  DepositClaimRequestSchema,
  WithdrawalSubmissionSchema,
  WithdrawalRecordSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  NonceResponseSchema,
  UserProfileSchema,
  HandHistoryResponseSchema,
  GetNotesResponseSchema,
  GetNoteResponseSchema,
  SavePlayerNoteResponseSchema,
} from "@pokertools/types";

import { PokerSDKConfig, PokerSDKError } from "./types";

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
 * A body is safe to replay automatically only when it carries a stable
 * server-recognized identity field. Replays reuse the identical serialized
 * bytes, so a lost response never produces a second logical mutation.
 */
function hasStableOperationId(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;

  if (typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0) {
    return true;
  }
  // Canonical action submission: requestId is the idempotency identity.
  if (typeof record.requestId === "string" && record.requestId.length > 0) {
    return true;
  }
  // EIP-712 withdrawal submission: the signed intent identity is canonical.
  const intent = record.intent;
  if (typeof intent === "object" && intent !== null) {
    const i = intent as Record<string, unknown>;
    if (
      typeof i.intentId === "string" &&
      i.intentId.length > 0 &&
      typeof i.nonce === "number" &&
      Number.isInteger(i.nonce)
    ) {
      return true;
    }
  }
  // Exact deposit log identity (assetId, txHash, logIndex).
  if (
    typeof record.txHash === "string" &&
    typeof record.logIndex === "number" &&
    Number.isInteger(record.logIndex)
  ) {
    return true;
  }
  return false;
}

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
 * // Read the authoritative decision boundary
 * const observation = await client.getObservation(tableId);
 *
 * // Choose a server-issued legal action
 * const fold = observation.legalActions.find((a) => a.family === "FOLD");
 * await client.action(tableId, {
 *   requestId: crypto.randomUUID(),
 *   turnId: observation.turnId,
 *   expectedVersion: observation.version,
 *   actionId: fold.actionId,
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
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
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
   * Set the authentication token.
   *
   * Wallet sessions and scoped SERVICE credentials are both opaque bearer
   * tokens; the transport does not distinguish them.
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
    const response = await this.request<unknown>("POST", "/auth/nonce");
    return NonceResponseSchema.parse(response).nonce;
  }

  /**
   * Login with SIWE signature
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.parse(request);
    const response = await this.request<unknown>("POST", "/auth/login", parsed);
    const result = LoginResponseSchema.parse(response);
    this.token = result.token;
    return result;
  }

  /**
   * Logout and revoke session
   */
  async logout(): Promise<void> {
    await this.request("POST", "/auth/logout");
    this.token = null;
  }

  /**
   * Get the authenticated principal identity (`GET /auth/me`).
   *
   * Returns exactly the canonical public principal: `{ id, kind, walletAddress }`.
   * Wallet sessions and SERVICE credentials both resolve; the wire shape never
   * carries roles, scopes or credential material. SERVICE principals may call
   * this endpoint even though every other `/auth` route is operator-only.
   */
  async getPrincipal(): Promise<Principal> {
    return PrincipalSchema.parse(await this.request<unknown>("GET", "/auth/me"));
  }

  // ============================================================================
  // Service credentials (operator-only, ADMIN wallet)
  //
  // Machine credentials are table-scoped (table:observe/table:act/table:chat)
  // and can never hold operator or finance authority. Only an ADMIN wallet
  // principal may mint or revoke them; other callers receive a typed
  // PokerSDKError (401/403) from the API.
  // ============================================================================

  /**
   * Mint a scoped SERVICE credential. The returned plaintext `token` is
   * available exactly once; only its digest is persisted server-side.
   */
  async createServiceCredential(
    request: CreateServiceCredentialRequest
  ): Promise<CreatedServiceCredential> {
    const parsed = CreateServiceCredentialRequestSchema.parse(request);
    const response = await this.request<unknown>("POST", "/auth/service-credentials", parsed);
    return CreatedServiceCredentialSchema.parse(response);
  }

  /**
   * List every service credential minted by the operator. Summaries never
   * carry the plaintext token.
   */
  async listServiceCredentials(): Promise<ServiceCredentialSummary[]> {
    const response = await this.request<unknown>("GET", "/auth/service-credentials");
    return ListServiceCredentialsResponseSchema.parse(response).credentials;
  }

  /**
   * Revoke a service credential by id. Revocation takes effect immediately for
   * both REST and WebSocket use of the credential.
   */
  async revokeServiceCredential(credentialId: CredentialId): Promise<void> {
    const response = await this.request<unknown>(
      "POST",
      `/auth/service-credentials/${credentialId}/revoke`
    );
    RevokeServiceCredentialResponseSchema.parse(response);
  }

  // ============================================================================
  // Tables
  // ============================================================================

  /**
   * Get list of active tables
   */
  async getTables(): Promise<TableListItem[]> {
    const response = await this.request<unknown>("GET", "/tables");
    return GetTablesResponseSchema.parse(response).tables;
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
   *
   * Conditional masked view using the same wire state as observations.
   * Use {@link getObservation} for server-issued turns and legal actions.
   *
   * @param tableId - Table ID
   * @param since - Optional version for conditional fetch (returns null if unchanged)
   */
  async getTableState(tableId: string, since?: number): Promise<PublicWireState | null> {
    const query = since !== undefined ? `?since=${since}` : "";
    try {
      const response = await this.request<unknown>("GET", `/tables/${tableId}${query}`);
      return GetTableStateResponseSchema.parse(response).state;
    } catch (error) {
      if (error instanceof PokerSDKError && error.statusCode === 304) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch the authoritative per-seat observation for the acting turn.
   *
   * The returned `legalActions` are the only actions the client may submit;
   * the SDK does not compute legality itself.
   */
  async getObservation(tableId: string): Promise<SeatObservation> {
    const response = await this.request<unknown>("GET", `/tables/${tableId}/observation`);
    return SeatObservationSchema.parse(response);
  }

  /**
   * Submit a canonical action.
   *
   * The request is strict: it carries only opaque ids and an optional chip
   * amount. Actor identity is derived from authentication, never the body.
   * The response is the stored deterministic result: the receipt plus the
   * resulting observation for the same principal.
   */
  async action(tableId: string, request: CanonicalActionRequest): Promise<CanonicalActionResult> {
    const parsed = CanonicalActionRequestSchema.parse(request);
    const response = await this.request<unknown>("POST", `/tables/${tableId}/action`, parsed);
    return CanonicalActionResultSchema.parse(response);
  }

  /**
   * Buy in to a table
   */
  async buyIn(tableId: string, request: BuyInRequest): Promise<void> {
    await this.request("POST", `/tables/${tableId}/buy-in`, request);
  }

  /**
   * Add chips to stack (rebuy/top-up)
   */
  async addChips(tableId: string, request: AddChipsRequest): Promise<void> {
    await this.request("POST", `/tables/${tableId}/add-chips`, request);
  }

  /**
   * Read a bounded page of the append-only table chat stream
   * (`GET /tables/:id/chat`).
   *
   * Pages are oldest-first; `nextBeforeSeq` is the cursor for the next older
   * page (null when the caller has reached the start). The server clamps
   * `limit` to its bounded page size.
   */
  async getChat(
    tableId: string,
    options: { limit?: number; beforeSeq?: number } = {}
  ): Promise<ChatPage> {
    const params: string[] = [];
    if (options.limit !== undefined) params.push(`limit=${options.limit}`);
    if (options.beforeSeq !== undefined) params.push(`beforeSeq=${options.beforeSeq}`);
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    const response = await this.request<unknown>("GET", `/tables/${tableId}/chat${query}`);
    return ChatPageSchema.parse(response);
  }

  /**
   * Append one chat message (`POST /tables/:id/chat`).
   *
   * The server escapes the body before persisting it and binds the message to
   * the authoritative hand. Chat never advances the table state version, so it
   * is not part of the canonical action protocol.
   */
  async sendChat(tableId: string, body: string): Promise<ChatMessage> {
    const response = await this.request<unknown>("POST", `/tables/${tableId}/chat`, { body });
    return ChatMessageSchema.parse(response);
  }

  /**
   * Read an ordered, hash-chained replay slice of the append-only event log
   * (`GET /tables/:id/replay`).
   *
   * `fromEventSeq` is the inclusive lower bound (must be >= 1) and
   * `toEventSeq` is the optional inclusive upper bound. The returned frame
   * carries the events, their hash-chain provenance and `chainValid`.
   */
  async getReplay(
    tableId: string,
    options: { fromEventSeq: number; toEventSeq?: number }
  ): Promise<ReplayFrame> {
    const { fromEventSeq, toEventSeq } = options;
    if (!Number.isSafeInteger(fromEventSeq) || fromEventSeq < 1) {
      throw new PokerSDKError(
        "fromEventSeq must be a positive integer",
        "INVALID_REPLAY_RANGE",
        undefined,
        { fromEventSeq }
      );
    }
    if (
      toEventSeq !== undefined &&
      (!Number.isSafeInteger(toEventSeq) || toEventSeq < fromEventSeq)
    ) {
      throw new PokerSDKError(
        "toEventSeq must not precede fromEventSeq",
        "INVALID_REPLAY_RANGE",
        undefined,
        { fromEventSeq, toEventSeq }
      );
    }

    const params = [`fromEventSeq=${fromEventSeq}`];
    if (toEventSeq !== undefined) params.push(`toEventSeq=${toEventSeq}`);
    const response = await this.request<unknown>(
      "GET",
      `/tables/${tableId}/replay?${params.join("&")}`
    );
    return ReplayFrameSchema.parse(response);
  }

  // ============================================================================
  // Convenience Action Methods
  //
  // Each method fetches a fresh observation and submits the matching
  // server-issued legal action. A stable requestId is generated once per call
  // and reused by the transport across retries.
  // ============================================================================

  /**
   * Fold hand
   */
  async fold(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "FOLD")).observation.state;
  }

  /**
   * Check (pass action)
   */
  async check(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "CHECK")).observation.state;
  }

  /**
   * Call current bet
   */
  async call(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "CALL")).observation.state;
  }

  /**
   * Place a bet. If no amount is supplied the server's precomputed legal
   * amount is used when available.
   */
  async bet(tableId: string, amount?: number): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "BET", { amount })).observation.state;
  }

  /**
   * Raise the current bet. If no amount is supplied the server's precomputed
   * legal amount is used when available.
   */
  async raise(tableId: string, amount?: number): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "RAISE", { amount })).observation.state;
  }

  /**
   * Deal new hand
   */
  async deal(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "DEAL")).observation.state;
  }

  /**
   * Show cards at showdown
   */
  async show(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "SHOW")).observation.state;
  }

  /**
   * Muck cards at showdown
   */
  async muck(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "MUCK")).observation.state;
  }

  /**
   * Use time bank
   */
  async timeBank(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "TIME_BANK")).observation.state;
  }

  /**
   * Stand from table (leave and cash out)
   */
  async stand(tableId: string): Promise<PublicWireState> {
    return (await this.submitFamily(tableId, "STAND")).observation.state;
  }

  // ============================================================================
  // Tournaments
  // ============================================================================

  /**
   * Get active and registering tournaments.
   */
  async getTournaments(): Promise<TournamentListItem[]> {
    const response = await this.request<{ tournaments: TournamentListItem[] }>(
      "GET",
      "/tournaments"
    );
    return response.tournaments;
  }

  /**
   * Create a tournament lobby and backing tournament table.
   */
  async createTournament(request: CreateTournamentRequest): Promise<{
    tournamentId: string;
    tableId: string;
  }> {
    return this.request("POST", "/tournaments", request);
  }

  /**
   * Get tournament lobby details, entries, prize pool, and table reference.
   */
  async getTournament(tournamentId: string): Promise<TournamentDetails> {
    const response = await this.request<{ tournament: TournamentDetails }>(
      "GET",
      `/tournaments/${tournamentId}`
    );
    return response.tournament;
  }

  /**
   * Register for a tournament. Debits buy-in and fee from MAIN balance.
   */
  async registerTournament(
    tournamentId: string,
    request: RegisterTournamentRequest
  ): Promise<{ success: boolean }> {
    return this.request("POST", `/tournaments/${tournamentId}/register`, request);
  }

  /**
   * Start a tournament once at least two players are registered.
   */
  async startTournament(tournamentId: string): Promise<StartTournamentResponse> {
    return this.request("POST", `/tournaments/${tournamentId}/start`);
  }

  /**
   * Reconcile a running multi-table tournament after completed hands.
   */
  async reconcileTournament(tournamentId: string): Promise<ReconcileTournamentResponse> {
    return this.request("POST", `/tournaments/${tournamentId}/reconcile`);
  }

  /**
   * Manually advance tournament blind level.
   */
  async advanceTournamentBlinds(tournamentId: string): Promise<{
    results: Record<string, { blindLevel?: number; error?: string }>;
  }> {
    return this.request("POST", `/tournaments/${tournamentId}/advance-blinds`);
  }

  /**
   * Settle a completed tournament and pay the configured prize distribution.
   */
  async settleTournament(tournamentId: string): Promise<SettleTournamentResponse> {
    return this.request("POST", `/tournaments/${tournamentId}/settle`);
  }

  // ============================================================================
  // User
  // ============================================================================

  /**
   * Get current user profile and balances
   */
  async getProfile(): Promise<UserProfile> {
    return UserProfileSchema.parse(await this.request<unknown>("GET", "/user/me"));
  }

  /**
   * Get hand history
   */
  async getHandHistory(): Promise<HandHistoryEntry[]> {
    const response = await this.request<unknown>("GET", "/user/history");
    return HandHistoryResponseSchema.parse(response).history;
  }

  // ============================================================================
  // Finance (canonical asset/atomic contract)
  // ============================================================================

  /**
   * List supported assets. Amounts are only ever canonical atomic decimal
   * strings.
   */
  async getAssets(): Promise<Asset[]> {
    const response = await this.request<{ assets: Asset[] }>("GET", "/finance/assets");
    return response.assets.map((asset) => AssetSchema.parse(asset));
  }

  /**
   * List the authenticated principal's per-asset balances.
   */
  async getBalances(): Promise<AssetBalance[]> {
    const response = await this.request<{ balances: AssetBalance[] }>("GET", "/finance/balances");
    return response.balances.map((balance) => BalanceSchema.parse(balance));
  }

  /**
   * Claim a direct treasury deposit by exact log identity.
   */
  async claimDeposit(claim: DepositClaimRequest): Promise<DepositClaim> {
    const parsed = DepositClaimRequestSchema.parse(claim);
    const response = await this.request<unknown>("POST", "/finance/deposits/claim", parsed);
    return DepositClaimSchema.parse(response);
  }

  /**
   * Get a deposit by id.
   */
  async getDeposit(depositId: string): Promise<DepositClaim> {
    const response = await this.request<unknown>("GET", `/finance/deposits/${depositId}`);
    return DepositClaimSchema.parse(response);
  }

  /**
   * Submit a signed EIP-712 withdrawal intent.
   */
  async submitWithdrawal(submission: WithdrawalSubmission): Promise<WithdrawalRecord> {
    const parsed = WithdrawalSubmissionSchema.parse(submission);
    const response = await this.request<unknown>("POST", "/finance/withdrawals/intents", parsed);
    return WithdrawalRecordSchema.parse(response);
  }

  /**
   * Get a withdrawal by intent id.
   */
  async getWithdrawal(intentId: string): Promise<WithdrawalRecord> {
    const response = await this.request<unknown>("GET", `/finance/withdrawals/${intentId}`);
    return WithdrawalRecordSchema.parse(response);
  }

  // ============================================================================
  // Notes
  // ============================================================================

  /**
   * Get all notes by current user
   */
  async getNotes(): Promise<PlayerNote[]> {
    const response = await this.request<unknown>("GET", "/notes");
    return GetNotesResponseSchema.parse(response).notes;
  }

  /**
   * Get note for specific player
   */
  async getNote(targetId: string): Promise<PlayerNote | null> {
    const response = await this.request<unknown>("GET", `/notes/${targetId}`);
    return GetNoteResponseSchema.parse(response).note;
  }

  /**
   * Save or update note
   */
  async saveNote(targetId: string, content: string, label?: string): Promise<PlayerNote> {
    const response = await this.request<unknown>("POST", "/notes", {
      targetId,
      content,
      label,
    });
    return SavePlayerNoteResponseSchema.parse(response).note;
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
  async health(): Promise<HealthResponse> {
    return HealthResponseSchema.parse(await this.request("GET", "/health"));
  }

  /**
   * Evaluate platform readiness (`GET /ready`).
   *
   * Not-ready is a valid, typed answer: the API returns the same canonical
   * readiness body with HTTP 503. This method resolves for both 200 (`ready`)
   * and 503 (`not_ready`) so callers inspect `status`/`financial.state`
   * instead of catching transport errors. Any other non-2xx status still
   * throws a `PokerSDKError`.
   */
  async getReadiness(): Promise<ReadinessResponse> {
    const response = await this.request<unknown>("GET", "/ready", undefined, {
      allowStatus: [503],
    });
    return ReadinessResponseSchema.parse(response);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Fetch the current observation and submit the requested legal action
   * family. Throws when the server does not currently offer that family.
   */
  private async submitFamily(
    tableId: string,
    family: LegalActionFamily,
    options: { amount?: number } = {}
  ): Promise<CanonicalActionResult> {
    const observation = await this.getObservation(tableId);
    const legal = observation.legalActions.find((action) => action.family === family);
    if (!legal) {
      throw new PokerSDKError(
        `Server did not offer a legal ${family} action`,
        "ILLEGAL_ACTION",
        undefined,
        { tableId, offered: observation.legalActions.map((action) => action.family) }
      );
    }

    const amount = this.resolveLegalAmount(legal, options.amount);
    const request: CanonicalActionRequest = {
      requestId: this.generateRequestId(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: legal.actionId,
      // A zero call is a check; the canonical request amount must be positive.
      ...(amount === undefined || amount === 0 ? {} : { amount }),
    };

    return this.action(tableId, request);
  }

  /**
   * Resolve the chip amount for a legal action without inventing legality.
   */
  private resolveLegalAmount(legal: LegalAction, requested?: number): number | undefined {
    const bounded = legal.minAmount !== undefined || legal.maxAmount !== undefined;

    if (!bounded) {
      if (requested !== undefined) {
        throw new PokerSDKError("This action takes no chip amount", "INVALID_AMOUNT", undefined, {
          family: legal.family,
        });
      }
      return legal.amount;
    }

    const amount = requested ?? legal.amount ?? legal.minAmount;
    if (amount === undefined) {
      // minAmount is present for bounded families, so this is defensive only.
      throw new PokerSDKError("A chip amount is required", "AMOUNT_REQUIRED", undefined, {
        family: legal.family,
      });
    }
    if (legal.minAmount !== undefined && amount < legal.minAmount) {
      throw new PokerSDKError(
        `Amount ${amount} is below minimum ${legal.minAmount}`,
        "AMOUNT_BELOW_MIN",
        undefined,
        { family: legal.family, minAmount: legal.minAmount, amount }
      );
    }
    if (legal.maxAmount !== undefined && amount > legal.maxAmount) {
      throw new PokerSDKError(
        `Amount ${amount} is above maximum ${legal.maxAmount}`,
        "AMOUNT_ABOVE_MAX",
        undefined,
        { family: legal.family, maxAmount: legal.maxAmount, amount }
      );
    }
    return amount;
  }

  /**
   * Generate a stable idempotent request id.
   */
  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  /**
   * Make HTTP request with retry logic
   *
   * `options.allowStatus` lists non-2xx status codes whose bodies are still
   * typed responses (e.g. `/ready` returns 503 with the canonical readiness
   * payload). Those statuses resolve instead of throwing and are never retried.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { allowStatus?: readonly number[] }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined) headers["Content-Type"] = "application/json";

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    // Reads are bounded by config. Mutations retry only when the body carries
    // a stable requestId / idempotency identity, and the exact serialized bytes
    // are replayed so a lost response cannot create a second mutation.
    const canRetry = method === "GET" || hasStableOperationId(body);
    const retryCount = canRetry ? this.retry.count : 0;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        if (this.debug) {
          console.log(`[PokerSDK] ${method} ${path}`);
        }

        const response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
          signal: controller.signal,
        });

        // Handle 304 Not Modified
        if (response.status === 304) {
          throw new PokerSDKError("Not Modified", "NOT_MODIFIED", 304);
        }

        // Handle non-2xx responses
        if (!response.ok && !options?.allowStatus?.includes(response.status)) {
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

        if (response.status === 204 || response.status === 205) return undefined as T;
        const data = (await response.json()) as T;

        if (this.debug) {
          console.log(`[PokerSDK] Response: ${response.status}`);
        }

        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error as Error;
        if (error instanceof PokerSDKError && error.statusCode === 304) throw error;

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
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new PokerSDKError("Request timeout", "TIMEOUT", undefined, {
            timeout: this.timeout,
          });
        }

        // Retry with backoff
        if (attempt < retryCount) {
          const delay = this.retry.delay * Math.pow(this.retry.backoff, attempt);
          if (this.debug) {
            console.log(`[PokerSDK] Retry ${attempt + 1}/${this.retry.count} in ${delay}ms`);
          }
          await this.sleep(delay);
        }
      } finally {
        clearTimeout(timeoutId);
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
