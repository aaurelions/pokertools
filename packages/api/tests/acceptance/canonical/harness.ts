/**
 * Canonical acceptance harness: real loopback Fastify app on PostgreSQL + Redis,
 * wallet (SIWE) and SERVICE principal fixtures, and a canonical HTTP client.
 *
 * Everything the suite asserts is reached through the public HTTP API. Direct
 * database access is used ONLY to declare an initial funding/auth fixture (a
 * MAIN balance and an operator role); it never mutates engine action state.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { LegalAction, SeatObservation } from "@pokertools/types";
import { CanonicalActionReceiptSchema } from "@pokertools/types";
import { SaferSeatObservationSchema } from "./schemas.js";
import type { AcceptanceEnv } from "./infra.js";
import { readAcceptanceEnv } from "./infra.js";

export interface AcceptanceApp {
  app: FastifyInstance;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface WalletPrincipal {
  kind: "WALLET";
  id: string;
  token: string;
  address: string;
  account: PrivateKeyAccount;
}

export interface ServicePrincipal {
  kind: "SERVICE";
  id: string;
  token: string;
  credentialId: string;
  scopes: string[];
  tableId: string | null;
  seat: number | null;
}

export type AnyPrincipal = WalletPrincipal | ServicePrincipal;

export interface PrincipalSpec {
  name: string;
  scopes: Array<"table:observe" | "table:act" | "table:chat">;
  tableId?: string | null;
  seat?: number | null;
  expiresAt?: string;
}

/**
 * Boot the real app on the provisioned PostgreSQL/Redis. The PostgreSQL-provider
 * Prisma client is injected by the Vitest alias in the acceptance config.
 */
export async function bootApp(): Promise<AcceptanceApp> {
  const { buildApp } = await import("../../../src/app.js");
  const app = await buildApp();
  await app.ready();
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    baseUrl,
    close: async () => {
      await app.close();
    },
  };
}

export function acceptanceEnv(): AcceptanceEnv {
  return readAcceptanceEnv();
}

/** Minimal typed HTTP call. Non-2xx is returned, never thrown. */
export async function apiRequest<T = unknown>(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let serialized: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    serialized = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: serialized,
  });
  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body: body as T };
}

/** Perform a real SIWE login for a fresh wallet identity. */
export async function loginWallet(baseUrl: string): Promise<WalletPrincipal> {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonceResponse = await apiRequest<{ nonce: string }>(baseUrl, "POST", "/auth/nonce");
  if (nonceResponse.status !== 200) {
    throw new Error(`nonce failed: ${nonceResponse.status}`);
  }
  const message = createSiweMessage({
    address: account.address,
    chainId: 31337,
    domain: new URL(baseUrl).hostname,
    uri: baseUrl,
    nonce: nonceResponse.body.nonce,
    version: "1",
    issuedAt: new Date(),
  });
  const login = await apiRequest<{ token: string; user: { id: string } }>(
    baseUrl,
    "POST",
    "/auth/login",
    { body: { message, signature: await account.signMessage({ message }) } }
  );
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return {
    kind: "WALLET",
    id: login.body.user.id,
    token: login.body.token,
    address: account.address.toLowerCase(),
    account,
  };
}

/**
 * Fixture: promote a wallet to operator. This is the ONLY privileged fixture:
 * it establishes the initial authorization needed to mint scoped SERVICE
 * credentials through the public operator route. No financial proof is implied.
 */
export async function promoteToOperator(app: FastifyInstance, userId: string): Promise<void> {
  await app.prisma.user.update({ where: { id: userId }, data: { role: "ADMIN" } });
}

/**
 * Fixture: grant AVAILABLE play chips so a principal can buy in. This is a
 * declared gameplay funding fixture (the only funding path), NOT financial
 * acceptance. It uses the same service the operator route uses; it does not
 * touch engine seats, stacks or eliminations.
 */
export async function grantChips(
  app: FastifyInstance,
  principalId: string,
  amount: number,
  operatorId = "acceptance-fixture"
): Promise<void> {
  await app.financialManager.grantChips(principalId, BigInt(amount), {
    reason: "canonical acceptance funding fixture",
    operatorId,
    idempotencyKey: `fixture-${principalId}-${crypto.randomUUID()}`,
  });
}

/** Mint a scoped SERVICE credential via the public operator route. */
export async function createServicePrincipal(
  baseUrl: string,
  operatorToken: string,
  spec: PrincipalSpec
): Promise<ServicePrincipal> {
  const body: Record<string, unknown> = { name: spec.name, scopes: spec.scopes };
  if (spec.tableId !== undefined && spec.tableId !== null) body.tableId = spec.tableId;
  if (spec.seat !== undefined && spec.seat !== null) body.seat = spec.seat;
  if (spec.expiresAt !== undefined) body.expiresAt = spec.expiresAt;
  const response = await apiRequest<{
    id: string;
    userId: string;
    token: string;
    scopes: string[];
    tableId: string | null;
    seat: number | null;
  }>(baseUrl, "POST", "/auth/service-credentials", { token: operatorToken, body });
  if (response.status !== 201) {
    throw new Error(
      `service credential failed: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
  return {
    kind: "SERVICE",
    id: response.body.userId,
    token: response.body.token,
    credentialId: response.body.id,
    scopes: response.body.scopes,
    tableId: response.body.tableId,
    seat: response.body.seat,
  };
}

/** Create a table through the public API. */
export async function createTable(
  baseUrl: string,
  token: string,
  config: {
    name: string;
    smallBlind: number;
    bigBlind: number;
    maxPlayers: number;
    minBuyIn?: number;
    maxBuyIn?: number;
  }
): Promise<string> {
  const response = await apiRequest<{ tableId: string }>(baseUrl, "POST", "/tables", {
    token,
    body: { mode: "CASH", rakePercent: 0, ...config },
  });
  if (response.status !== 200) {
    throw new Error(`createTable failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.tableId;
}

/** Seat a principal through the public buy-in route (requires a funding fixture). */
export async function seatPrincipal(
  baseUrl: string,
  principal: AnyPrincipal,
  tableId: string,
  seat: number,
  amount: number
): Promise<void> {
  const response = await apiRequest(baseUrl, "POST", `/tables/${tableId}/buy-in`, {
    token: principal.token,
    body: { amount, seat, idempotencyKey: crypto.randomUUID() },
  });
  if (response.status !== 200) {
    throw new Error(
      `buy-in failed for ${principal.kind} seat ${seat}: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
}

export interface ActionSubmission {
  requestId: string;
  turnId: string;
  expectedVersion: number;
  actionId: string;
  amount?: number;
}

/**
 * Canonical client. The observation endpoint returns a `SeatObservation` and
 * the action endpoint returns the authoritative observation at the accepted
 * version (the response is deliberately NOT parsed as a signed receipt here,
 * because the HTTP contract and the SDK receipt schema are under separate
 * ownership; see README interface dependencies).
 */
export class CanonicalClient {
  constructor(
    private readonly baseUrl: string,
    private readonly principal: AnyPrincipal
  ) {}

  async observations(tableId: string): Promise<ApiResponse<unknown>> {
    return apiRequest(this.baseUrl, "GET", `/tables/${tableId}/observation`, {
      token: this.principal.token,
    });
  }

  async observation(tableId: string): Promise<SeatObservation> {
    const response = await this.observations(tableId);
    if (response.status !== 200) {
      throw new CanonicalError(
        `observation failed: ${response.status}`,
        response.status,
        response.body
      );
    }
    const parsed = SaferSeatObservationSchema.safeParse(unwrapObservation(response.body));
    if (!parsed.success) {
      throw new CanonicalError(
        "observation failed canonical schema",
        response.status,
        parsed.error.issues
      );
    }
    return parsed.data as SeatObservation;
  }

  async act(tableId: string, submission: ActionSubmission): Promise<ApiResponse<unknown>> {
    return apiRequest(this.baseUrl, "POST", `/tables/${tableId}/action`, {
      token: this.principal.token,
      body: submission,
    });
  }

  /** Submit and require acceptance, returning the observation at the new version. */
  async actOrThrow(tableId: string, submission: ActionSubmission): Promise<SeatObservation> {
    const response = await this.act(tableId, submission);
    if (response.status !== 200) {
      throw new CanonicalError(
        `action ${submission.actionId} rejected: ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`,
        response.status,
        response.body
      );
    }
    const parsed = SaferSeatObservationSchema.safeParse(unwrapObservation(response.body));
    if (!parsed.success) {
      throw new CanonicalError(
        `action response failed canonical schema: ${JSON.stringify(response.body).slice(0, 600)}`,
        response.status,
        parsed.error.issues
      );
    }
    const observation = parsed.data as SeatObservation;

    // The canonical result is `{ receipt, observation }`: the receipt must
    // identify the exact accepted request/action and agree with the returned
    // observation on every table-global counter. A missing/mismatched receipt is
    // a hard protocol failure (no fallback, nothing swallowed).
    if (!response.body || typeof response.body !== "object" || !("receipt" in response.body)) {
      throw new CanonicalError(
        `action ${submission.actionId} response is missing the canonical receipt`,
        response.status,
        response.body
      );
    }
    const receiptParsed = CanonicalActionReceiptSchema.safeParse(
      (response.body as { receipt: unknown }).receipt
    );
    if (!receiptParsed.success) {
      throw new CanonicalError(
        `action ${submission.actionId} receipt failed canonical schema`,
        response.status,
        receiptParsed.error.issues
      );
    }
    const receipt = receiptParsed.data;
    // The receipt identifies the accepted submitted turn/action; the observation
    // is the resulting snapshot for the same principal. The receipt's `turnId`
    // must therefore equal the *submitted* turn (the observation may already be
    // the next turn/hand), while the table-global counters must agree exactly.
    if (receipt.requestId !== submission.requestId || receipt.actionId !== submission.actionId) {
      throw new CanonicalError(
        `action receipt does not identify the submitted request/action`,
        response.status,
        { receipt, submission }
      );
    }
    if (receipt.tableId !== tableId || receipt.turnId !== submission.turnId) {
      throw new CanonicalError(
        `action receipt does not identify the submitted table/turn`,
        response.status,
        { receipt, submission }
      );
    }
    if (
      receipt.version !== observation.version ||
      receipt.eventSeq !== observation.eventSeq ||
      receipt.version <= submission.expectedVersion
    ) {
      throw new CanonicalError(
        `action receipt and observation counters disagree`,
        response.status,
        { receipt, observation, expectedVersion: submission.expectedVersion }
      );
    }
    return observation;
  }
}

/**
 * The action route returns `{ receipt, observation }`; some builds return the
 * observation directly. Unwrap both without weakening the observation schema.
 */
export function unwrapObservation(body: unknown): unknown {
  if (body && typeof body === "object" && "observation" in body) {
    return (body as { observation: unknown }).observation;
  }
  return body;
}

export class CanonicalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** Pick a preferred legal action for the current turn, if offered. */
export function chooseAction(
  observation: SeatObservation,
  preferred: string[]
): LegalAction | undefined {
  for (const family of preferred) {
    const action = observation.legalActions.find((candidate) => candidate.family === family);
    if (action) return action;
  }
  return observation.legalActions[0];
}

/**
 * Play one canonical turn for whichever principal currently owns it. Returns
 * the resulting observation, or undefined when the action could not be applied.
 * The preferred policy folds whenever possible so hands terminate quickly.
 */
export async function playOneTurn(
  baseUrl: string,
  tableId: string,
  principals: AnyPrincipal[],
  preferred: string[] = ["FOLD", "CHECK", "CALL"]
): Promise<{ observation: SeatObservation; actor: AnyPrincipal } | undefined> {
  for (const principal of principals) {
    const client = new CanonicalClient(baseUrl, principal);
    const observation = await client.observation(tableId);
    if (observation.turnId === null || observation.legalActions.length === 0) continue;
    const action = chooseAction(observation, preferred);
    if (!action) continue;
    const takesAmount = action.family === "BET" || action.family === "RAISE";
    const amount = action.amount ?? action.minAmount ?? action.maxAmount;
    const next = await client.actOrThrow(tableId, {
      requestId: crypto.randomUUID(),
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: action.actionId,
      ...(takesAmount && amount !== undefined ? { amount } : {}),
    });
    return { observation: next, actor: principal };
  }
  return undefined;
}

/**
 * Start a canonical hand. The hand authority offers a DEAL legal action to a
 * seated principal when no decision is pending. Throws with an explicit
 * interface-dependency message when no DEAL is offered (e.g. because the
 * authority returns a null `turnId` at hand boundaries).
 */
export async function startHand(
  baseUrl: string,
  tableId: string,
  principals: AnyPrincipal[]
): Promise<{ observation: SeatObservation; actor: AnyPrincipal }> {
  const observed: Array<{ actor: AnyPrincipal; observation: SeatObservation }> = [];
  for (const principal of principals) {
    const client = new CanonicalClient(baseUrl, principal);
    const observation = await client.observation(tableId);
    observed.push({ actor: principal, observation });
    const deal = observation.legalActions.find((action) => action.family === "DEAL");
    if (deal && observation.turnId !== null) {
      const next = await client.actOrThrow(tableId, {
        requestId: crypto.randomUUID(),
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: deal.actionId,
      });
      return { observation: next, actor: principal };
    }
  }
  const summary = observed
    .map(
      ({ actor, observation }) =>
        `${actor.kind}:${actor.id} turnId=${observation.turnId} actions=${observation.legalActions
          .map((action) => action.family)
          .join(",")}`
    )
    .join(" | ");
  throw new Error(
    `No canonical DEAL was offered to any seated principal (interface dependency: hand-boundary observation needs a non-null turnId and a DEAL legal action). Observed: ${summary}`
  );
}

/**
 * Play a hand to settlement using only server-issued legal actions. Folds when
 * possible so hands terminate deterministically; returns the settled
 * observation (winners populated).
 */
export async function playHand(
  baseUrl: string,
  tableId: string,
  principals: AnyPrincipal[],
  maxActions = 200
): Promise<SeatObservation> {
  let last: SeatObservation | undefined;
  for (let step = 0; step < maxActions; step++) {
    const turn = await playOneTurn(baseUrl, tableId, principals, ["FOLD", "CHECK", "CALL"]);
    if (!turn) {
      // No pending betting turn: either settled or waiting for a DEAL.
      const dealer = await startHand(baseUrl, tableId, principals);
      last = dealer.observation;
      continue;
    }
    last = turn.observation;
    if (last.state.winners && last.state.winners.length > 0) return last;
  }
  throw new Error(
    `Hand did not settle within ${maxActions} actions; last winners=${JSON.stringify(last?.state.winners)}`
  );
}

/** Clean up all principals and tables created by a suite. */
export async function cleanupFixtures(
  app: FastifyInstance,
  fixtures: { userIds?: string[]; tableIds?: string[] }
): Promise<void> {
  for (const tableId of fixtures.tableIds ?? []) {
    await app.prisma.gameEvent.deleteMany({ where: { tableId } }).catch(() => undefined);
    await app.prisma.gameActionRequest.deleteMany({ where: { tableId } }).catch(() => undefined);
    await app.prisma.gameOutbox.deleteMany({ where: { tableId } }).catch(() => undefined);
    await app.prisma.handHistory.deleteMany({ where: { tableId } }).catch(() => undefined);
    await app.prisma.table.deleteMany({ where: { id: tableId } }).catch(() => undefined);
    await app.redis.del(`table:${tableId}`).catch(() => undefined);
  }
  for (const userId of fixtures.userIds ?? []) {
    await app.prisma.serviceCredential.deleteMany({ where: { userId } }).catch(() => undefined);
    await app.prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
    // Canonical chip journal/accounts are keyed by principal with no FK to User.
    await app.prisma.chipLedgerEntry
      .deleteMany({ where: { account: { principalId: userId } } })
      .catch(() => undefined);
    await app.prisma.chipGrant
      .deleteMany({ where: { principalId: userId } })
      .catch(() => undefined);
    await app.prisma.chipAccount
      .deleteMany({ where: { principalId: userId } })
      .catch(() => undefined);
    await app.prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
}
