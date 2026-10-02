import { describe, it, expect, vi } from "vitest";
import {
  createCanonicalDepositRoutes,
  registerDepositRoutes,
  type DepositRouteOptions,
} from "../../src/routes/finance/canonical-deposits.js";
import { RpcQuorumError } from "../../src/services/chain-registry.js";
import type { DepositClaimVerifier } from "../../src/services/canonical-deposits.js";

const CHAIN_ID = 31337;
const TOKEN = "0x1111111111111111111111111111111111111111";
const WALLET = "0x3333333333333333333333333333333333333333";
const ASSET_ID = `eip155:${CHAIN_ID}/erc20:${TOKEN}`;
const TX = `0x${"ab".repeat(32)}`;

type Handler = (request: unknown, reply: unknown) => Promise<unknown>;

interface Registered {
  url: string;
  options: unknown;
  handler: Handler;
}

function makeFastify() {
  const routes: Registered[] = [];
  const fastify: Record<string, unknown> = {
    prisma: {
      asset: {
        findUnique: vi.fn(async () => ({ id: ASSET_ID, chainId: CHAIN_ID, status: "ACTIVE" })),
      },
      depositClaimRecord: { findUnique: vi.fn(async () => null) },
    },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => fastify.log },
    authenticate: vi.fn(async () => undefined),
    post: (url: string, options: unknown, handler: Handler) => {
      routes.push({ url, options, handler });
    },
  };
  return { fastify, routes };
}

function makeReply() {
  const reply = {
    statusCode: 0,
    payload: undefined as unknown,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

function makeRequest(principal: unknown, body: unknown) {
  return { principal, body, log: { error: vi.fn() } };
}

function walletPrincipal() {
  return { id: "principal_1", kind: "WALLET", walletAddress: WALLET };
}

const validBody = { assetId: ASSET_ID, txHash: TX, logIndex: 0 };

describe("canonical deposit route", () => {
  it("exports both registration entry points", () => {
    expect(typeof registerDepositRoutes).toBe("function");
    expect(typeof createCanonicalDepositRoutes).toBe("function");
  });

  it("injects the supplied verifier through the service constructor", async () => {
    const { fastify, routes } = makeFastify();
    const verifier = vi.fn(async () => ({
      verified: false,
      reason: "NOPE",
    })) as unknown as DepositClaimVerifier;

    registerDepositRoutes(fastify as never, { verifier });

    expect(routes).toHaveLength(1);
    expect(routes[0].url).toBe("/deposits/claim");

    const reply = makeReply();
    await routes[0].handler(makeRequest(walletPrincipal(), validBody), reply);

    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      chainId: CHAIN_ID,
      txHash: TX,
      logIndex: 0,
      principalId: "principal_1",
      walletAddress: WALLET,
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({
      error: "DEPOSIT_NOT_VERIFIED",
      message: expect.any(String),
    });
  });

  it("registers the same route via the plugin form", async () => {
    const { fastify, routes } = makeFastify();
    const verifier = vi.fn(async () => ({
      verified: false,
      reason: "NOPE",
    })) as unknown as DepositClaimVerifier;
    const options: DepositRouteOptions = { verifier };

    await createCanonicalDepositRoutes(options)(fastify as never);

    expect(routes).toHaveLength(1);
    expect(routes[0].url).toBe("/deposits/claim");
  });

  it("requires an authenticated WALLET principal before verification", async () => {
    const { fastify, routes } = makeFastify();
    const verifier = vi.fn(async () => ({ verified: false })) as unknown as DepositClaimVerifier;
    registerDepositRoutes(fastify as never, { verifier });

    const reply = makeReply();
    await routes[0].handler(makeRequest(null, validBody), reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({ error: "WALLET_PRINCIPAL_REQUIRED" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical request body before verification", async () => {
    const { fastify, routes } = makeFastify();
    const verifier = vi.fn(async () => ({ verified: false })) as unknown as DepositClaimVerifier;
    registerDepositRoutes(fastify as never, { verifier });

    const reply = makeReply();
    await routes[0].handler(
      makeRequest(walletPrincipal(), { assetId: ASSET_ID, txHash: "not-a-hash", logIndex: -1 }),
      reply
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("maps RPC infrastructure failure to 503 SETTLEMENT_UNAVAILABLE", async () => {
    const { fastify, routes } = makeFastify();
    const verifier = vi.fn(async () => {
      throw new RpcQuorumError("no endpoints", CHAIN_ID, {
        chainId: CHAIN_ID,
        method: "eth_getTransactionReceipt",
        reason: "no_responses",
        endpoints: [],
      });
    }) as unknown as DepositClaimVerifier;
    registerDepositRoutes(fastify as never, { verifier });

    const reply = makeReply();
    await routes[0].handler(makeRequest(walletPrincipal(), validBody), reply);

    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toEqual({ error: "SETTLEMENT_UNAVAILABLE" });
  });
});
