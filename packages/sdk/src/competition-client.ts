/**
 * CompetitionClient - HTTP client for the generic competition surface.
 *
 * A competition is a server-authoritative single-table tournament with a
 * pre-provisioned 2-10 entrant roster. The class is deliberately separate from
 * `PokerClient`: orchestration authority (`competition:orchestrate`) is not a
 * gameplay credential, and identity is read with `PokerClient.getPrincipal()`
 * when needed.
 *
 * Contracts live in `@pokertools/types` (`canonical/competition.ts`): every
 * request body is validated before it is sent and every response is parsed
 * against the same strict canonical schema, so an internal projection drift
 * fails closed instead of reaching the caller.
 *
 * Retry safety: every mutation body carries a stable `idempotencyKey`. The
 * shared transport replays the identical serialized bytes, so a lost response
 * can never create a second entry, charge, start or prize.
 *
 * @example
 * ```typescript
 * const competitions = new CompetitionClient({
 *   baseUrl: "https://api.poker.example.com",
 *   token: orchestratorServiceToken, // competition:orchestrate
 * });
 *
 * const created = await competitions.createCompetition({
 *   name: "Asset table",
 *   mode: "ASSET",
 *   entrants: [
 *     { principalId: walletPrincipalId, kind: "WALLET" },
 *     { principalId: agentPrincipalId, kind: "SERVICE" },
 *   ],
 *   terms,
 *   idempotencyKey: crypto.randomUUID(),
 * });
 * ```
 */

import type {
  Competition,
  CreateCompetitionRequest,
  CreateCompetitionResponse,
  OptInCompetitionRequest,
  OptInCompetitionResponse,
  StartCompetitionRequest,
  StartCompetitionResponse,
  SettleCompetitionRequest,
  SettleCompetitionResponse,
  IssueAgentCredentialRequest,
  IssuedAgentCredential,
} from "@pokertools/types";
import {
  CreateCompetitionRequestSchema,
  CreateCompetitionResponseSchema,
  GetCompetitionResponseSchema,
  OptInCompetitionRequestSchema,
  OptInCompetitionResponseSchema,
  StartCompetitionRequestSchema,
  StartCompetitionResponseSchema,
  SettleCompetitionRequestSchema,
  SettleCompetitionResponseSchema,
  IssueAgentCredentialRequestSchema,
  IssuedAgentCredentialSchema,
} from "@pokertools/types";

import type { PokerSDKConfig } from "./types";
import { PokerHttpTransport } from "./transport";

/** Root path of the competition surface; ids are encoded per segment. */
const COMPETITIONS_PATH = "/competitions";

export class CompetitionClient {
  private readonly transport: PokerHttpTransport;

  constructor(config: PokerSDKConfig) {
    this.transport = new PokerHttpTransport(config);
  }

  /**
   * Set the orchestration token (`competition:orchestrate` SERVICE credential
   * or an ADMIN wallet session).
   */
  setToken(token: string | null): void {
    this.transport.setToken(token);
  }

  getToken(): string | null {
    return this.transport.getToken();
  }

  isAuthenticated(): boolean {
    return this.transport.getToken() !== null;
  }

  /**
   * Create a competition and its pre-provisioned roster
   * (`POST /competitions`, `competition:orchestrate` or ADMIN wallet).
   *
   * Idempotent on `idempotencyKey`; `replayed` is true when the original
   * creation is returned. Server-assigned seats are authoritative and are
   * never client-supplied.
   */
  async createCompetition(request: CreateCompetitionRequest): Promise<CreateCompetitionResponse> {
    const parsed = CreateCompetitionRequestSchema.parse(request);
    const response = await this.transport.request<unknown>("POST", COMPETITIONS_PATH, parsed);
    return CreateCompetitionResponseSchema.parse(response);
  }

  /**
   * Read the privacy-preserving competition projection
   * (`GET /competitions/:id`, any authenticated principal).
   */
  async getCompetition(competitionId: string): Promise<Competition> {
    const response = await this.transport.request<unknown>(
      "GET",
      `${COMPETITIONS_PATH}/${encodeURIComponent(competitionId)}`
    );
    return GetCompetitionResponseSchema.parse(response).competition;
  }

  /**
   * Opt in as the authenticated configured WALLET entry payer
   * (`POST /competitions/:id/opt-in`), charging the explicit entry atomically.
   *
   * The payer is resolved from authentication; the body carries only the
   * idempotency identity. Replays return the original journal conversion.
   */
  async optIn(
    competitionId: string,
    request: OptInCompetitionRequest
  ): Promise<OptInCompetitionResponse> {
    const parsed = OptInCompetitionRequestSchema.parse(request);
    const response = await this.transport.request<unknown>(
      "POST",
      `${COMPETITIONS_PATH}/${encodeURIComponent(competitionId)}/opt-in`,
      parsed
    );
    return OptInCompetitionResponseSchema.parse(response);
  }

  /**
   * Start a fully paid competition (`POST /competitions/:id/start`,
   * orchestration only). Returns the authoritative table and seat assignments.
   */
  async startCompetition(
    competitionId: string,
    request: StartCompetitionRequest
  ): Promise<StartCompetitionResponse> {
    const parsed = StartCompetitionRequestSchema.parse(request);
    const response = await this.transport.request<unknown>(
      "POST",
      `${COMPETITIONS_PATH}/${encodeURIComponent(competitionId)}/start`,
      parsed
    );
    return StartCompetitionResponseSchema.parse(response);
  }

  /**
   * Settle a finished competition (`POST /competitions/:id/settle`,
   * orchestration only, idempotent). For `ASSET` competitions the reserved
   * prize is paid exactly once or released back to the sponsor.
   */
  async settleCompetition(
    competitionId: string,
    request: SettleCompetitionRequest
  ): Promise<SettleCompetitionResponse> {
    const parsed = SettleCompetitionRequestSchema.parse(request);
    const response = await this.transport.request<unknown>(
      "POST",
      `${COMPETITIONS_PATH}/${encodeURIComponent(competitionId)}/settle`,
      parsed
    );
    return SettleCompetitionResponseSchema.parse(response);
  }

  /**
   * Issue or rotate a table-scoped agent credential for a delegated SERVICE
   * entrant (`POST /competitions/:id/agent-credentials`, orchestration only).
   *
   * Omit `credentialId` to mint a fresh credential; pass it to rotate the
   * existing secret in place. The returned plaintext `token` is one-time and is
   * never persisted by the SDK or written to logs.
   */
  async issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest
  ): Promise<IssuedAgentCredential> {
    const parsed = IssueAgentCredentialRequestSchema.parse(request);
    const response = await this.transport.request<unknown>(
      "POST",
      `${COMPETITIONS_PATH}/${encodeURIComponent(competitionId)}/agent-credentials`,
      parsed
    );
    return IssuedAgentCredentialSchema.parse(response);
  }
}
