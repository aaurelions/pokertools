import type {
  FinancialIncident,
  IncidentKind,
  IncidentSeverity,
  Prisma,
  PrismaClient,
  TreasuryReconciliation,
} from "../../generated/prisma/index.js";
import {
  AtomicLedger,
  ConcurrentLedgerModificationError,
  runTransactionWithRetry,
} from "./atomic-ledger.js";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.js";

/**
 * Injected readiness re-check. Runs inside the SAME database transaction as the
 * incident resolution so RPC/gas/reconciliation state cannot race the write.
 * Throwing aborts the transaction and leaves the incident open.
 *
 * This check is MANDATORY for resolution: there is no default success. The
 * service additionally re-verifies all other blocking incidents and a fresh
 * treasury reconciliation in the same locked transaction.
 */
export type IncidentReadinessCheck = (
  tx: Prisma.TransactionClient,
  incident: FinancialIncident
) => Promise<void>;

/** Latest treasury reconciliation older than this blocks incident resolution. */
export const DEFAULT_RECONCILIATION_MAX_AGE_MS = 30 * 60_000;

export interface OpenIncidentInput {
  kind: IncidentKind;
  severity?: IncidentSeverity;
  assetId?: string | null;
  chainId?: number | null;
  affectedId?: string | null;
  evidence: Record<string, unknown>;
}

export interface OpenCriticalIncidentInput {
  kind: IncidentKind;
  severity?: IncidentSeverity;
  assetId?: string | null;
  chainId?: number | null;
  affectedId?: string | null;
  evidence: Record<string, unknown>;
  /**
   * Freeze every asset on `chainId` (route-wide freeze). Defaults to false, in
   * which case only `assetId` (if any) is frozen.
   */
  freezeChainWide?: boolean;
}

export interface OpenCriticalIncidentResult {
  incident: FinancialIncident;
  frozenAssetIds: string[];
}

export interface ResolveIncidentInput {
  incidentId: string;
  operatorId: string;
  operatorEvidence: Record<string, unknown>;
  /** Fail-closed readiness check (RPC quorum, native gas, ...). Required. */
  readinessCheck: IncidentReadinessCheck;
}

export interface RecordReconciliationInput {
  assetId: string;
  chainId: number;
  observedAtomic: string;
  ledgerAtomic: string;
  blockNumber?: string | null;
  incidentId?: string | null;
  evidence: Record<string, unknown>;
}

/**
 * FinancialIncidentService — durable incidents and treasury reconciliation.
 *
 * Incidents never silently reverse credits. They record a discrepancy, can
 * freeze an asset, and require explicit operator resolution with evidence.
 */
export class FinancialIncidentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: AtomicLedger
  ) {}

  async open(input: OpenIncidentInput): Promise<FinancialIncident> {
    return this.prisma.financialIncident.create({
      data: {
        kind: input.kind,
        severity: input.severity ?? "WARNING",
        assetId: input.assetId ?? null,
        chainId: input.chainId ?? null,
        affectedId: input.affectedId ?? null,
        evidence: input.evidence as Prisma.InputJsonValue,
      },
    });
  }

  async get(incidentId: string): Promise<FinancialIncident | null> {
    return this.prisma.financialIncident.findUnique({ where: { id: incidentId } });
  }

  async list(params?: {
    status?: "OPEN" | "INVESTIGATING" | "RESOLVED";
    assetId?: string;
    take?: number;
  }): Promise<FinancialIncident[]> {
    return this.prisma.financialIncident.findMany({
      where: {
        ...(params?.status ? { status: params.status } : {}),
        ...(params?.assetId ? { assetId: params.assetId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params?.take ?? 100,
    });
  }

  /** Operator-only durable freeze of an asset while an incident is open. */
  async freezeAsset(assetId: string): Promise<void> {
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { status: "FROZEN" },
    });
  }

  /**
   * Atomically open a critical incident and freeze the affected route in one
   * transaction. All target assets are locked (sorted, identical order to the
   * ledger) before the incident is created, so there is no window in which new
   * financial risk can be admitted between opening the incident and freezing.
   *
   * `freezeChainWide` freezes every asset on `chainId`. The incident and the
   * frozen set commit or roll back together.
   */
  async openCriticalIncidentAndFreeze(
    input: OpenCriticalIncidentInput
  ): Promise<OpenCriticalIncidentResult> {
    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const targetIds = await this.resolveFreezeTargets(tx, input);
      for (const id of targetIds) {
        await this.ledger.lockAsset(tx, id);
      }

      const incident = await tx.financialIncident.create({
        data: {
          kind: input.kind,
          severity: input.severity ?? "CRITICAL",
          assetId: input.assetId ?? null,
          chainId: input.chainId ?? null,
          affectedId: input.affectedId ?? null,
          evidence: input.evidence as Prisma.InputJsonValue,
        },
      });

      const frozenAssetIds: string[] = [];
      for (const id of targetIds) {
        const asset = await tx.asset.findUnique({
          where: { id },
          select: { id: true, status: true },
        });
        if (!asset) continue;
        if (asset.status !== "FROZEN") {
          await tx.asset.update({ where: { id: asset.id }, data: { status: "FROZEN" } });
        }
        frozenAssetIds.push(asset.id);
      }

      return { incident, frozenAssetIds };
    });
  }

  /** Resolve the deterministic, sorted set of assets a freeze applies to. */
  private async resolveFreezeTargets(
    tx: Prisma.TransactionClient,
    input: OpenCriticalIncidentInput
  ): Promise<string[]> {
    const chainWide = input.freezeChainWide === true || input.assetId == null;
    if (chainWide && input.chainId != null) {
      const assets = await tx.asset.findMany({
        where: { chainId: input.chainId },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      return assets.map((asset) => asset.id);
    }
    return input.assetId ? [input.assetId] : [];
  }

  /**
   * Explicit operator resolution. In one transaction:
   *  1. re-read the incident and reject already-resolved/racing resolutions,
   *  2. take the durable per-asset lock,
   *  3. verify no other blocking incident remains open,
   *  4. run the MANDATORY injected quorum/gas readiness re-check,
   *  5. verify a fresh, matched treasury reconciliation,
   *  6. always re-verify the affected asset's journal invariant,
   *  7. record operator evidence, unfreeze the route and close the incident.
   *
   * History is never mutated: resolution is purely additive metadata. There is
   * no default-success path: a missing readiness check aborts.
   */
  async resolve(input: ResolveIncidentInput, maxAttempts = 3): Promise<FinancialIncident> {
    if (!input.operatorId) {
      throw new AuthorizationError("Operator identity is required to resolve an incident");
    }
    if (typeof input.readinessCheck !== "function") {
      throw new ValidationError("Incident resolution requires a fail-closed readiness check");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const incident = await tx.financialIncident.findUnique({
            where: { id: input.incidentId },
          });
          if (!incident) {
            throw new NotFoundError("Incident");
          }
          if (incident.status === "RESOLVED") {
            throw new ConflictError("Incident is already resolved");
          }

          // Take the durable per-asset lock first so the readiness rechecks and
          // the route ACTIVE commit cannot race a concurrent ledger writer.
          if (incident.assetId) {
            await this.ledger.lockAsset(tx, incident.assetId);
          }

          // Fail closed while any other blocking incident is still open.
          await this.assertNoOtherBlockingIncidents(tx, incident);

          // Mandatory injected quorum/gas re-check (throws -> abort).
          await input.readinessCheck(tx, incident);

          // Fresh treasury reconciliation inside the same locked transaction.
          await this.assertFreshReconciliation(tx, incident);

          if (incident.assetId) {
            await this.ledger.assertAssetBalanced(tx, incident.assetId);
          }

          // Route ACTIVE commit: only reachable after every health recheck above
          // passed in the same transaction. Asset-scoped incidents unfreeze that
          // asset; chain-scoped (route-wide) incidents unfreeze every frozen
          // asset on the chain so the freeze cannot be stranded.
          await this.unfreezeRoute(tx, incident);

          // Durable optimistic state-version transition: exactly one resolver
          // wins; a racing resolver aborts and retries against fresh state.
          const updated = await tx.financialIncident.updateMany({
            where: {
              id: input.incidentId,
              version: incident.version,
              status: { not: "RESOLVED" },
            },
            data: {
              status: "RESOLVED",
              resolvedAt: new Date(),
              operatorId: input.operatorId,
              operatorEvidence: input.operatorEvidence as Prisma.InputJsonValue,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) {
            throw new ConcurrentLedgerModificationError("Incident resolution raced");
          }

          return tx.financialIncident.findUniqueOrThrow({ where: { id: input.incidentId } });
        });
      } catch (error) {
        lastError = error;
        if (!(error instanceof ConcurrentLedgerModificationError) || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  /**
   * Unfreeze the route an incident froze: the asset for an asset-scoped
   * incident, or every frozen asset on the chain for a chain-scoped incident.
   * Runs inside the resolution transaction after all health rechecks passed.
   */
  private async unfreezeRoute(
    tx: Prisma.TransactionClient,
    incident: FinancialIncident
  ): Promise<void> {
    if (incident.assetId) {
      const asset = await tx.asset.findUnique({
        where: { id: incident.assetId },
        select: { id: true, status: true },
      });
      if (asset && asset.status === "FROZEN") {
        await tx.asset.update({ where: { id: asset.id }, data: { status: "ACTIVE" } });
      }
      return;
    }
    if (incident.chainId !== null) {
      const assets = await tx.asset.findMany({
        where: { chainId: incident.chainId, status: "FROZEN" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const asset of assets) {
        await tx.asset.update({ where: { id: asset.id }, data: { status: "ACTIVE" } });
      }
    }
  }

  /**
   * Reject resolution while any OTHER critical incident for the same asset or
   * chain remains unresolved. An incident with neither asset nor chain is
   * global and considers every other unresolved critical incident.
   */
  private async assertNoOtherBlockingIncidents(
    tx: Prisma.TransactionClient,
    incident: FinancialIncident
  ): Promise<void> {
    const scope =
      incident.assetId !== null
        ? incident.chainId !== null
          ? { OR: [{ assetId: incident.assetId }, { chainId: incident.chainId }] }
          : { assetId: incident.assetId }
        : incident.chainId !== null
          ? { chainId: incident.chainId }
          : {};
    const remaining = await tx.financialIncident.count({
      where: {
        id: { not: incident.id },
        status: { not: "RESOLVED" },
        severity: "CRITICAL",
        ...scope,
      },
    });
    if (remaining > 0) {
      throw new ConflictError("Other blocking incidents remain open");
    }
  }

  /**
   * Require a fresh, matched, fully-provenanced treasury reconciliation for the
   * incident's asset (or every active asset on its chain) inside the locked
   * transaction. Stale or missing evidence fails closed.
   */
  private async assertFreshReconciliation(
    tx: Prisma.TransactionClient,
    incident: FinancialIncident,
    now = Date.now()
  ): Promise<void> {
    const assetIds = incident.assetId
      ? [incident.assetId]
      : incident.chainId !== null
        ? (
            await tx.asset.findMany({
              // Every asset on the chain, frozen or not: a route-wide freeze
              // must prove reconciliation for the whole route before unfreezing.
              where: { chainId: incident.chainId },
              select: { id: true },
              orderBy: { id: "asc" },
            })
          ).map((asset) => asset.id)
        : [];
    if (assetIds.length === 0) return;

    for (const assetId of assetIds) {
      const reconciliation = await tx.treasuryReconciliation.findFirst({
        where: { assetId },
        orderBy: { createdAt: "desc" },
      });
      if (!reconciliation) {
        throw new ConflictError("Fresh treasury reconciliation is required");
      }
      if (reconciliation.status !== "MATCHED" || reconciliation.differenceAtomic !== "0") {
        throw new ConflictError("Treasury reconciliation is mismatched");
      }
      if (
        reconciliation.blockNumber === null ||
        reconciliation.blockNumber === "" ||
        reconciliation.evidence === null ||
        typeof reconciliation.evidence !== "object"
      ) {
        throw new ConflictError("Treasury reconciliation provenance is missing");
      }
      if (now - reconciliation.createdAt.getTime() > DEFAULT_RECONCILIATION_MAX_AGE_MS) {
        throw new ConflictError("Treasury reconciliation is stale");
      }
    }
  }

  /**
   * Persist treasury reconciliation evidence. `differenceAtomic` is signed:
   * zero means MATCHED, anything else is a MISMATCH (never silently corrected).
   */
  async recordReconciliation(input: RecordReconciliationInput): Promise<TreasuryReconciliation> {
    const difference = BigInt(input.observedAtomic) - BigInt(input.ledgerAtomic);
    return this.prisma.treasuryReconciliation.create({
      data: {
        assetId: input.assetId,
        chainId: input.chainId,
        observedAtomic: input.observedAtomic,
        ledgerAtomic: input.ledgerAtomic,
        differenceAtomic: difference.toString(),
        blockNumber: input.blockNumber ?? null,
        status: difference === 0n ? "MATCHED" : "MISMATCH",
        evidence: input.evidence as Prisma.InputJsonValue,
        incidentId: input.incidentId ?? null,
      },
    });
  }
}
