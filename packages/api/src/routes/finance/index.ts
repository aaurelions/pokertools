import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  AssetSchema,
  BalanceSchema,
  FinancialIncidentSchema,
  WithdrawalRecordSchema,
  WithdrawalSubmissionSchema,
  type FinancialIncident as FinancialIncidentWire,
} from "@pokertools/types";
import type { FinancialIncident, WithdrawalIntentRecord } from "../../../generated/prisma/index.js";
import { AtomicLedger } from "../../services/atomic-ledger.js";
import { FinancialIntentService } from "../../services/financial-intents.js";
import {
  FinancialIncidentService,
  type IncidentReadinessCheck,
} from "../../services/financial-incidents.js";
import { registerDepositRoutes, toDepositClaimWire } from "./canonical-deposits.js";
import { AuthorizationError, NotFoundError } from "../../utils/errors.js";

function walletPrincipal(request: FastifyRequest): { id: string; walletAddress: string } {
  const principal = request.principal;
  if (!principal || principal.kind !== "WALLET" || !principal.walletAddress) {
    throw new AuthorizationError("WALLET_PRINCIPAL_REQUIRED");
  }
  return { id: principal.id, walletAddress: principal.walletAddress };
}

function operatorId(request: FastifyRequest): string {
  const principal = request.principal;
  if (!principal || !principal.isOperator) {
    throw new AuthorizationError("OPERATOR_REQUIRED");
  }
  return principal.id;
}

/**
 * Public withdrawal projection: exactly the strict shared `WithdrawalRecord`
 * contract (the signed intent fields plus lifecycle status). The reserved
 * journal id, the reservation idempotency flag, the signature and any signed
 * raw bytes/RPC URLs are internal and are never returned.
 */
function toWithdrawalRecordWire(record: WithdrawalIntentRecord) {
  return WithdrawalRecordSchema.parse({
    intentId: record.id,
    principalId: record.principalId,
    assetId: record.assetId,
    destination: record.destination,
    amountAtomic: record.amountAtomic,
    nonce: Number(record.nonce),
    deadline: Number(record.deadline),
    chainId: record.chainId,
    status: record.state,
    txHash: record.txHash,
    submittedAt: record.createdAt.getTime(),
    updatedAt: record.updatedAt.getTime(),
  });
}

/** Operator/public incident projection: exactly the shared incident contract. */
function toIncidentWire(incident: FinancialIncident): FinancialIncidentWire {
  return FinancialIncidentSchema.parse({
    id: incident.id,
    kind: incident.kind,
    severity: incident.severity,
    status: incident.status,
    assetId: incident.assetId,
    chainId: incident.chainId,
    affectedId: incident.affectedId,
    evidence: incident.evidence,
    createdAt: incident.createdAt.getTime(),
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.getTime() : null,
    operatorId: incident.operatorId,
    operatorEvidence: incident.operatorEvidence,
  });
}

export const financeRoutes: FastifyPluginAsync = async (fastify) => {
  const ledger = new AtomicLedger(fastify.prisma);
  const intents = new FinancialIntentService(fastify.prisma, ledger);
  const incidents = new FinancialIncidentService(fastify.prisma, ledger);

  // -------------------------------------------------------------------------
  // Canonical multi-asset registry (public: asset metadata is chain registry).
  // -------------------------------------------------------------------------
  fastify.get("/assets", async () => {
    const assets = await fastify.prisma.asset.findMany({ orderBy: { id: "asc" } });
    return {
      assets: assets.map((asset) =>
        AssetSchema.parse({
          assetId: asset.id,
          chainId: asset.chainId,
          tokenAddress: asset.tokenAddress,
          decimals: asset.decimals,
          symbol: asset.symbol,
          status: asset.status,
          confirmations: asset.confirmations,
          deepFinality: asset.deepFinality,
        })
      ),
    };
  });

  // -------------------------------------------------------------------------
  // Canonical per-asset balances (canonical decimal strings, never chips).
  // -------------------------------------------------------------------------
  fastify.get("/balances", { onRequest: [fastify.authenticate] }, async (request) => {
    const principal = walletPrincipal(request);
    const accounts = await ledger.listBalancesForOwner(fastify.prisma, principal.id);

    const byAsset = new Map<string, Record<string, string>>();
    for (const account of accounts) {
      const bucket = byAsset.get(account.assetId) ?? {};
      bucket[account.class] = account.balanceAtomic;
      byAsset.set(account.assetId, bucket);
    }

    return {
      principalId: principal.id,
      balances: [...byAsset.entries()].map(([assetId, bucket]) =>
        BalanceSchema.parse({
          principalId: principal.id,
          assetId,
          availableAtomic: bucket.USER_AVAILABLE ?? "0",
          inPlayAtomic: bucket.IN_PLAY_RESERVE ?? "0",
          pendingWithdrawalAtomic: bucket.PENDING_WITHDRAWAL ?? "0",
          // Actual class balances; an existing reserve/obligation account is
          // reported rather than hidden behind the schema default.
          tournamentReserveAtomic: bucket.TOURNAMENT_RESERVE ?? "0",
          incidentObligationAtomic: bucket.INCIDENT_OBLIGATION ?? "0",
        })
      ),
    };
  });

  // -------------------------------------------------------------------------
  // Withdrawals: EIP-712-bound intents, reserved atomically via the ledger.
  // The API never holds signing secrets; custody consumes the persisted record.
  // -------------------------------------------------------------------------
  fastify.post(
    "/withdrawals/intents",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const principal = walletPrincipal(request);
      const parsed = WithdrawalSubmissionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
      }

      const result = await intents.reserveWithdrawal({
        principal: { id: principal.id, kind: "WALLET", walletAddress: principal.walletAddress },
        intent: parsed.data.intent,
        signature: parsed.data.signature,
      });

      // PUBLIC projection only: strict shared WithdrawalRecord fields.
      return toWithdrawalRecordWire(result.record);
    }
  );

  fastify.get("/withdrawals", { onRequest: [fastify.authenticate] }, async (request) => {
    const principal = walletPrincipal(request);
    const records = await intents.listWithdrawalIntents(principal.id);
    return {
      withdrawals: records.map((record) => toWithdrawalRecordWire(record)),
    };
  });

  fastify.get("/withdrawals/:id", { onRequest: [fastify.authenticate] }, async (request) => {
    const principal = walletPrincipal(request);
    const { id } = request.params as { id: string };
    const record = await intents.getWithdrawalIntent(id);
    if (!record || record.principalId !== principal.id) {
      throw new NotFoundError("Withdrawal intent");
    }
    return toWithdrawalRecordWire(record);
  });

  // -------------------------------------------------------------------------
  // Canonical deposits: exact log identity; credit only after verification.
  // Verification is injected by the chain agent (see canonical-deposits.ts).
  // -------------------------------------------------------------------------
  fastify.get("/deposits/:id", { onRequest: [fastify.authenticate] }, async (request) => {
    const principal = walletPrincipal(request);
    const { id } = request.params as { id: string };
    const claim = await fastify.prisma.depositClaimRecord.findUnique({ where: { id } });
    if (!claim || claim.principalId !== principal.id) {
      throw new NotFoundError("Deposit claim");
    }
    // Same projection as the POST claim response so the strict shared schema
    // matches on either path.
    return toDepositClaimWire({
      id: claim.id,
      assetId: claim.assetId,
      txHash: claim.txHash,
      logIndex: claim.logIndex,
      principalId: claim.principalId,
      amountAtomic: claim.amountAtomic,
      status: claim.status,
      provenance: claim.provenance,
      blockNumber: claim.blockNumber,
      blockHash: claim.blockHash,
      confirmations: claim.confirmations,
    });
  });

  // -------------------------------------------------------------------------
  // Incidents: durable, operator-resolved, fail-closed readiness re-check.
  // Both `authenticate` and `requireOperator` are mandatory: `requireOperator`
  // reads `request.principal`, which only `authenticate` attaches.
  // -------------------------------------------------------------------------
  fastify.get(
    "/incidents",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request) => {
      operatorId(request);
      const query = request.query as { status?: string; assetId?: string };
      const records = await incidents.list({
        status:
          query.status === "OPEN" || query.status === "INVESTIGATING" || query.status === "RESOLVED"
            ? query.status
            : undefined,
        assetId: query.assetId,
      });
      return { incidents: records.map((incident) => toIncidentWire(incident)) };
    }
  );

  fastify.post(
    "/incidents/:id/resolve",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const operator = operatorId(request);
      const { id } = request.params as { id: string };
      const body = request.body as { operatorEvidence?: unknown } | undefined;
      if (!body || typeof body.operatorEvidence !== "object" || body.operatorEvidence === null) {
        return reply.code(400).send({ error: "OPERATOR_EVIDENCE_REQUIRED" });
      }

      const readinessCheck =
        (
          fastify as unknown as {
            financialIncidentReadinessCheck?: IncidentReadinessCheck;
            financialReadinessCheck?: IncidentReadinessCheck;
          }
        ).financialIncidentReadinessCheck ??
        (fastify as unknown as { financialReadinessCheck?: IncidentReadinessCheck })
          .financialReadinessCheck;
      // There is no default-success path. Without a real quorum/gas/reconciliation
      // check the route fails closed rather than unfreezing on ledger health alone.
      if (typeof readinessCheck !== "function") {
        return reply.code(503).send({ error: "READINESS_CHECK_UNAVAILABLE" });
      }

      const resolved = await incidents.resolve({
        incidentId: id,
        operatorId: operator,
        operatorEvidence: body.operatorEvidence as Record<string, unknown>,
        readinessCheck,
      });

      return toIncidentWire(resolved);
    }
  );

  fastify.post(
    "/assets/:assetId/freeze",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request) => {
      const operator = operatorId(request);
      const { assetId } = request.params as { assetId: string };
      const asset = await fastify.prisma.asset.findUnique({ where: { id: assetId } });
      if (!asset) {
        throw new NotFoundError("Asset");
      }
      const body = (request.body ?? {}) as {
        reason?: unknown;
        chainWide?: unknown;
        evidence?: unknown;
      };
      const reason =
        typeof body.reason === "string" && body.reason.length > 0
          ? body.reason
          : "operator_route_freeze";
      const extraEvidence =
        typeof body.evidence === "object" && body.evidence !== null
          ? (body.evidence as Record<string, unknown>)
          : {};

      // Incident + route freeze commit atomically; all target assets are locked
      // in sorted order so no new risk can slip through the gap.
      const result = await incidents.openCriticalIncidentAndFreeze({
        kind: "CUSTODY_FAILURE",
        severity: "CRITICAL",
        assetId,
        chainId: asset.chainId,
        evidence: { reason, operatorId: operator, routeFreeze: true, ...extraEvidence },
        freezeChainWide: body.chainWide === true,
      });

      return {
        assetId,
        status: "FROZEN",
        incidentId: result.incident.id,
        frozenAssetIds: result.frozenAssetIds,
      };
    }
  );

  // Chain agent integration point: POST /finance/deposits/claim.
  registerDepositRoutes(fastify);
};
