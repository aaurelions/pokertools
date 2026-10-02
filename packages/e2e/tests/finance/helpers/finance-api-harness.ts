/**
 * Real API harness for finance route acceptance.
 *
 * Boots the actual Fastify app against the fresh PostgreSQL/Redis started by
 * the suite's global setup, and authenticates through the REAL public SIWE
 * routes (`POST /auth/nonce`, `POST /auth/login`). Effective finance routes are
 * mounted under `/finance`:
 *   GET  /finance/assets
 *   GET  /finance/balances
 *   POST /finance/deposits/claim
 *   GET  /finance/deposits/:id
 *   POST /finance/withdrawals/intents   body { intent, signature }
 *   GET  /finance/withdrawals/:id
 *   POST /finance/incidents/:id/resolve (operator)
 *   POST /finance/assets/:assetId/freeze (operator)
 *
 * No balance is ever granted here: this module only performs auth and request
 * plumbing.
 */
import type { FastifyInstance } from "fastify";
import { createSiweMessage } from "viem/siwe";
import type { HDAccount } from "viem/accounts";
import type { Hex } from "viem";

export interface FinanceApiEnv {
  databaseUrl: string;
  redisUrl: string;
}

let booted: FastifyInstance | null = null;
let activeEnv: FinanceApiEnv | null = null;

/** The host the injected requests present; must match the signed SIWE domain. */
export const SIWE_HOST = "localhost";

function requireEnv(): FinanceApiEnv {
  const databaseUrl = process.env.PT_FINANCE_DATABASE_URL ?? process.env.DATABASE_URL;
  const redisUrl = process.env.PT_FINANCE_REDIS_URL ?? process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error(
      "Finance API harness requires PT_FINANCE_DATABASE_URL/PT_FINANCE_REDIS_URL (set by global setup)"
    );
  }
  return { databaseUrl, redisUrl };
}

/** Apply the fresh-infra URLs to the process environment for the API config. */
export function configureFinanceApiEnv(env: FinanceApiEnv): void {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = env.databaseUrl;
  process.env.REDIS_URL = env.redisUrl;
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-finance-acceptance";
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET ?? "test-cookie-secret-finance-acceptance";
  process.env.ENABLE_TEST_ROUTES = "false";
  process.env.ALLOWED_SIWE_CHAIN_IDS = "31337,31338,1";
  process.env.LOG_LEVEL = "error";
  delete process.env.WALLET_XPRIV_ENCRYPTION_SECRET;
  delete process.env.MASTER_MNEMONIC;
  activeEnv = env;
}

export async function bootFinanceApi(env: FinanceApiEnv = requireEnv()): Promise<FastifyInstance> {
  if (booted) return booted;
  if (!activeEnv) configureFinanceApiEnv(env);
  const { buildApp } = await import("../../../../api/src/app.js");
  const app = await buildApp();
  await app.ready();
  booted = app;
  return app;
}

export async function closeFinanceApi(): Promise<void> {
  if (booted) {
    await booted.close();
    booted = null;
  }
}

export interface WalletAuth {
  principalId: string;
  address: string;
  token: string;
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  raw: string;
}

export async function apiRequest<T = unknown>(
  app: FastifyInstance,
  input: { method: "GET" | "POST"; url: string; token?: string; payload?: unknown; host?: string }
): Promise<HttpResult<T>> {
  const response = await app.inject({
    method: input.method,
    url: input.url,
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      host: input.host ?? SIWE_HOST,
    },
    payload: input.payload as never,
  });
  let body: unknown;
  try {
    body = response.body ? JSON.parse(response.body) : undefined;
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body: body as T, raw: response.body };
}

/**
 * Authenticate a real wallet via the public SIWE challenge/response routes.
 * Returns the durable principal id and the session bearer token.
 */
export async function siweLogin(
  app: FastifyInstance,
  account: HDAccount,
  chainId = 31337
): Promise<WalletAuth> {
  const nonceResponse = await apiRequest<{ nonce: string }>(app, {
    method: "POST",
    url: "/auth/nonce",
  });
  if (nonceResponse.status >= 300 || !nonceResponse.body?.nonce) {
    throw new Error(`SIWE nonce failed: ${nonceResponse.status} ${nonceResponse.raw}`);
  }

  const message = createSiweMessage({
    address: account.address,
    chainId,
    domain: SIWE_HOST,
    nonce: nonceResponse.body.nonce,
    uri: `http://${SIWE_HOST}`,
    version: "1",
  });
  const signature = (await account.signMessage({ message })) as Hex;

  const login = await apiRequest<{ token: string; user: { id: string; username: string } }>(app, {
    method: "POST",
    url: "/auth/login",
    payload: { message, signature },
  });
  if (login.status >= 300 || !login.body?.token) {
    throw new Error(`SIWE login failed: ${login.status} ${login.raw}`);
  }

  return {
    principalId: login.body.user.id,
    address: account.address.toLowerCase(),
    token: login.body.token,
  };
}

/**
 * Authenticate a real wallet and promote it to operator (ADMIN). The role
 * change is an auth fixture, not a balance credit; the session principal reads
 * the live role on every request.
 */
export async function bootstrapOperator(
  app: FastifyInstance,
  account: HDAccount,
  chainId = 31337
): Promise<WalletAuth> {
  const auth = await siweLogin(app, account, chainId);
  await app.prisma.user.update({ where: { id: auth.principalId }, data: { role: "ADMIN" } });
  return auth;
}

export interface DepositClaimRequest {
  assetId: string;
  txHash: string;
  logIndex: number;
}

export async function claimDeposit(
  app: FastifyInstance,
  auth: WalletAuth,
  claim: DepositClaimRequest
): Promise<HttpResult<{ id: string; depositId?: string; status: string; amountAtomic: string }>> {
  return apiRequest(app, {
    method: "POST",
    url: "/finance/deposits/claim",
    token: auth.token,
    payload: claim,
  });
}

export async function getDeposit(app: FastifyInstance, auth: WalletAuth, depositId: string) {
  return apiRequest(app, {
    method: "GET",
    url: `/finance/deposits/${depositId}`,
    token: auth.token,
  });
}

export async function getBalances(app: FastifyInstance, auth: WalletAuth) {
  return apiRequest(app, { method: "GET", url: "/finance/balances", token: auth.token });
}

export async function getAssets(app: FastifyInstance, auth: WalletAuth) {
  return apiRequest(app, { method: "GET", url: "/finance/assets", token: auth.token });
}

export async function submitWithdrawalIntent(
  app: FastifyInstance,
  auth: WalletAuth,
  submission: { intent: unknown; signature: string }
) {
  return apiRequest(app, {
    method: "POST",
    url: "/finance/withdrawals/intents",
    token: auth.token,
    payload: submission,
  });
}

export async function getWithdrawal(app: FastifyInstance, auth: WalletAuth, intentId: string) {
  return apiRequest(app, {
    method: "GET",
    url: `/finance/withdrawals/${intentId}`,
    token: auth.token,
  });
}

export async function listWithdrawals(app: FastifyInstance, auth: WalletAuth) {
  return apiRequest(app, { method: "GET", url: "/finance/withdrawals", token: auth.token });
}

export async function listIncidents(app: FastifyInstance, auth: WalletAuth) {
  return apiRequest(app, { method: "GET", url: "/finance/incidents", token: auth.token });
}

export async function resolveIncident(
  app: FastifyInstance,
  auth: WalletAuth,
  incidentId: string,
  operatorEvidence: Record<string, unknown>
) {
  return apiRequest(app, {
    method: "POST",
    url: `/finance/incidents/${incidentId}/resolve`,
    token: auth.token,
    payload: { operatorEvidence },
  });
}

export async function freezeAsset(app: FastifyInstance, auth: WalletAuth, assetId: string) {
  return apiRequest(app, {
    method: "POST",
    url: `/finance/assets/${assetId}/freeze`,
    token: auth.token,
  });
}
