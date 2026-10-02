/**
 * Canonical direct-treasury deposit claim route.
 *
 * The effective route is `POST /finance/deposits/claim` (registered from the
 * finance plugin with the `/finance` prefix).
 *
 * The request body is the strict shared `DepositClaimRequestSchema`
 * (`{ assetId, txHash, logIndex }`); the client never supplies an actor, amount
 * or recipient. The authenticated WALLET principal is bound inside the
 * chain-backed verifier.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { DepositClaimRequestSchema, DepositClaimSchema } from "@pokertools/types";
import {
  CanonicalDepositService,
  DepositClaimRejected,
  type ClaimResult,
  type DepositClaimVerifier,
} from "../../services/canonical-deposits.js";
import { createAssetBackedDepositVerifier } from "../../services/canonical-deposit-verifier.js";
import {
  ChainFrozenError,
  RpcEndpointError,
  RpcQuorumError,
} from "../../services/chain-registry.js";

export interface DepositRouteOptions {
  /**
   * Pre-built service. When supplied, its own verifier is authoritative and no
   * additional verifier is created. Preferred by supervisors that wire the
   * verifier explicitly.
   */
  deposits?: CanonicalDepositService;
  /**
   * Explicit verifier injected into the service this route constructs. The
   * verifier is passed through the `CanonicalDepositService` constructor; the
   * route never mutates the process-wide fallback verifier.
   */
  verifier?: DepositClaimVerifier;
}

interface RequestPrincipal {
  id: string;
  kind?: string;
  walletAddress?: string | null;
}

/**
 * The single canonical projection of a resolved deposit claim. Both the POST
 * `/deposits/claim` handler and the GET `/deposits/:id` handler use this so the
 * strict shared `DepositClaimSchema` matches on either path. Internal fields
 * (`id`, `chainId`, `creditedJournalId`, `idempotent`) are never returned.
 */
export function toDepositClaimWire(claim: {
  id: string;
  assetId: string;
  txHash: string;
  logIndex: number;
  principalId: string;
  amountAtomic: string;
  status: string;
  provenance: string;
  blockNumber: string | number | null;
  blockHash: string | null;
  confirmations: number;
}) {
  return DepositClaimSchema.parse({
    id: claim.id,
    assetId: claim.assetId,
    txHash: claim.txHash,
    logIndex: claim.logIndex,
    principalId: claim.principalId,
    amountAtomic: claim.amountAtomic,
    status: claim.status,
    provenance: claim.provenance,
    ...(claim.blockNumber !== null && claim.blockNumber !== undefined
      ? {
          blockNumber:
            typeof claim.blockNumber === "number" ? claim.blockNumber : Number(claim.blockNumber),
        }
      : {}),
    ...(claim.blockHash !== null && claim.blockHash !== undefined
      ? { blockHash: claim.blockHash }
      : {}),
    confirmations: claim.confirmations,
  });
}

function walletPrincipal(request: FastifyRequest): RequestPrincipal | null {
  const principal = (request as unknown as { principal?: RequestPrincipal }).principal;
  if (!principal || principal.kind !== "WALLET" || !principal.walletAddress) return null;
  return principal;
}

function handleError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof DepositClaimRejected) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  if (
    error instanceof ChainFrozenError ||
    error instanceof RpcQuorumError ||
    error instanceof RpcEndpointError
  ) {
    return reply.code(503).send({ error: "SETTLEMENT_UNAVAILABLE" });
  }
  request.log.error({ error }, "Unexpected error handling deposit claim");
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

/**
 * Build the asset-backed chain verifier used when the supervisor did not inject
 * one. Registry construction is lazy, so this is cheap to call at startup.
 */
export function createDefaultDepositVerifier(fastify: FastifyInstance): DepositClaimVerifier {
  return createAssetBackedDepositVerifier({ prisma: fastify.prisma, logger: fastify.log });
}

/**
 * Resolve the service this route should use. A supervisor-supplied service wins;
 * otherwise the verifier is injected through the `CanonicalDepositService`
 * constructor instead of a mutable process global.
 */
function resolveDeposits(
  fastify: FastifyInstance,
  options: DepositRouteOptions
): CanonicalDepositService {
  if (options.deposits) return options.deposits;
  const verifier = options.verifier ?? createDefaultDepositVerifier(fastify);
  return new CanonicalDepositService(fastify.prisma, { verifier });
}

function buildHandler(deposits: CanonicalDepositService) {
  return async function claimHandler(request: FastifyRequest, reply: FastifyReply) {
    const principal = walletPrincipal(request);
    if (!principal) {
      return reply.code(403).send({ error: "WALLET_PRINCIPAL_REQUIRED" });
    }

    const parsed = DepositClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
    }

    try {
      const result: ClaimResult = await deposits.claimDirectTreasury({
        principalId: principal.id,
        walletAddress: principal.walletAddress!,
        assetId: parsed.data.assetId,
        txHash: parsed.data.txHash,
        logIndex: parsed.data.logIndex,
      });
      return reply.code(result.idempotent ? 200 : 201).send(toDepositClaimWire(result));
    } catch (error) {
      return handleError(request, reply, error);
    }
  };
}

/**
 * Plugin form used by the finance route core:
 * `await fastify.register(createCanonicalDepositRoutes({ verifier }))`.
 */
export function createCanonicalDepositRoutes(options: DepositRouteOptions): FastifyPluginAsync {
  return async (fastify) => {
    const deposits = resolveDeposits(fastify, options);
    fastify.post("/deposits/claim", { onRequest: [fastify.authenticate] }, buildHandler(deposits));
  };
}

/**
 * Spec entry point: `registerDepositRoutes(fastify)` adds
 * `POST /finance/deposits/claim` when called on the root instance, or
 * `/deposits/claim` when called inside the `/finance` plugin. The verifier is
 * resolved once and injected through the service constructor.
 */
export function registerDepositRoutes(
  fastify: FastifyInstance,
  options: DepositRouteOptions = {}
): void {
  const deposits = resolveDeposits(fastify, options);
  fastify.post("/deposits/claim", { onRequest: [fastify.authenticate] }, buildHandler(deposits));
}
