/**
 * Prisma-backed custody persistence.
 *
 * Binds directly to the canonical generated Prisma models
 * (`Asset`, `WithdrawalIntentRecord`, `FinancialIncident`) — no structural casts
 * and no invented columns. Column mapping:
 *
 * - internal `intentId`            -> `WithdrawalIntentRecord.id`
 * - internal `nonce`/`deadline`    -> DB BigInt (rejected above MAX_SAFE_INTEGER)
 * - internal `treasuryNonce`       -> `WithdrawalIntentRecord.broadcastNonce`
 * - internal `incidentId`          -> `FinancialIncident.id`
 * - internal `openedAt`/`detail`   -> `FinancialIncident.createdAt`/`evidence`
 *
 * Per `(chainId, treasuryAddress)` serialization uses a pinned PostgreSQL
 * session connection holding `pg_advisory_lock`. The lock is held across nonce
 * reading, signing and the persistence writes. Non-PostgreSQL datasources use a
 * process-local mutex and are refused in production.
 */
import type {
  Asset,
  FinancialIncident,
  Prisma,
  PrismaClient,
  WithdrawalIntentRecord,
} from "@pokertools/api/database";
import { KeyedMutex } from "./in-memory-store.js";
import type { AssetStatus } from "@pokertools/types";
import type {
  AssetRegistry,
  IncidentRecord,
  IncidentResolution,
  IncidentStore,
  NewWithdrawalRecord,
  OpenIncidentInput,
  TreasuryAsset,
  WithdrawalRecord,
  WithdrawalState,
  WithdrawalStore,
  TransitionRequest,
  TransitionPatch,
} from "./types.js";
import { REPLACEMENT_POLICY } from "./types.js";

const MAX_TREASURY_NONCE = Number.MAX_SAFE_INTEGER;

function toSafeNumber(value: bigint | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${field} exceeds safe integer range`);
    return value;
  }
  if (value > BigInt(MAX_TREASURY_NONCE) || value < 0n) {
    throw new RangeError(`${field} exceeds safe integer range`);
  }
  return Number(value);
}

function asJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

/**
 * Convert a plain record to a Prisma InputJsonValue. Going through JSON drops
 * `undefined` members and non-JSON values, so callers cannot smuggle invalid
 * JSON into the durable evidence column.
 */
function toInputJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function mapWithdrawalRow(row: WithdrawalIntentRecord): WithdrawalRecord {
  return {
    intentId: row.id,
    principalId: row.principalId,
    assetId: row.assetId,
    chainId: row.chainId,
    destination: row.destination,
    amountAtomic: row.amountAtomic,
    nonce: toSafeNumber(row.nonce, "WithdrawalIntentRecord.nonce"),
    deadline: toSafeNumber(row.deadline, "WithdrawalIntentRecord.deadline"),
    signature: row.signature,
    payloadHash: row.payloadHash,
    state: row.state,
    reservedJournalId: row.reservedJournalId,
    signedRawTx: (row.signedRawTx as `0x${string}` | null) ?? null,
    signedCallData: (row.signedCallData as `0x${string}` | null) ?? null,
    signedValueAtomic: row.signedValueAtomic,
    txHash: row.txHash,
    treasuryNonce:
      row.broadcastNonce === null
        ? null
        : toSafeNumber(row.broadcastNonce, "WithdrawalIntentRecord.broadcastNonce"),
    receiptBlockNumber: row.receiptBlockNumber,
    receiptBlockHash: row.receiptBlockHash,
    confirmedJournalId: row.confirmedJournalId,
    reorgJournalId: row.reorgJournalId,
    replacementPolicy: row.replacementPolicy,
    treasuryAddress: row.treasuryAddress,
    tokenAddress: row.tokenAddress,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function mapIncidentRow(row: FinancialIncident): IncidentRecord {
  const evidence = asJsonObject(row.evidence);
  return {
    incidentId: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    assetId: row.assetId ?? undefined,
    chainId: row.chainId ?? undefined,
    principalId: typeof evidence.principalId === "string" ? evidence.principalId : undefined,
    intentId:
      row.affectedId ?? (typeof evidence.intentId === "string" ? evidence.intentId : undefined),
    detail: evidence,
    openedAt: row.createdAt.getTime(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : undefined,
  };
}

export function mapAssetRow(row: Asset): TreasuryAsset {
  const rpcUrls = Array.isArray(row.rpcUrls)
    ? row.rpcUrls.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    assetId: row.id,
    chainId: row.chainId,
    tokenAddress: row.tokenAddress,
    treasuryAddress: row.treasuryAddress,
    rpcUrls,
    minGasAtomic: row.minGasAtomic,
    confirmations: row.confirmations,
    deepFinality: row.deepFinality,
    status: row.status,
  };
}

function patchToData(patch: TransitionPatch): Prisma.WithdrawalIntentRecordUpdateManyMutationInput {
  const data: Prisma.WithdrawalIntentRecordUpdateManyMutationInput = {};
  if (patch.signedRawTx !== undefined) data.signedRawTx = patch.signedRawTx;
  if (patch.signedCallData !== undefined) data.signedCallData = patch.signedCallData;
  if (patch.signedValueAtomic !== undefined) data.signedValueAtomic = patch.signedValueAtomic;
  if (patch.txHash !== undefined) data.txHash = patch.txHash;
  if (patch.treasuryNonce !== undefined) data.broadcastNonce = BigInt(patch.treasuryNonce);
  if (patch.receiptBlockNumber !== undefined) data.receiptBlockNumber = patch.receiptBlockNumber;
  if (patch.receiptBlockHash !== undefined) data.receiptBlockHash = patch.receiptBlockHash;
  if (patch.reservedJournalId !== undefined) data.reservedJournalId = patch.reservedJournalId;
  if (patch.confirmedJournalId !== undefined) data.confirmedJournalId = patch.confirmedJournalId;
  if (patch.reorgJournalId !== undefined) data.reorgJournalId = patch.reorgJournalId;
  return data;
}

/**
 * Pinned PostgreSQL advisory-lock session. `pool.connect()` pins one backend for
 * the whole critical section; the lock is session-scoped and released explicitly.
 */
class PostgresAdvisoryLock {
  private poolPromise: Promise<import("pg").Pool> | null = null;

  constructor(private readonly databaseUrl: string) {}

  private pool(): Promise<import("pg").Pool> {
    this.poolPromise ??= import("pg").then(
      ({ Pool }) => new Pool({ connectionString: this.databaseUrl })
    );
    return this.poolPromise;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      }
    } finally {
      client.release();
    }
  }
}

export class PrismaWithdrawalStore implements WithdrawalStore {
  private readonly mutex = new KeyedMutex();
  private readonly advisory: PostgresAdvisoryLock | null;
  private readonly isPostgres: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    databaseUrl: string
  ) {
    this.isPostgres =
      databaseUrl.startsWith("postgresql://") || databaseUrl.startsWith("postgres://");
    if (!this.isPostgres && process.env.NODE_ENV === "production") {
      throw new Error("Custody requires a PostgreSQL treasury lock in production");
    }
    this.advisory = this.isPostgres ? new PostgresAdvisoryLock(databaseUrl) : null;
  }

  async get(intentId: string): Promise<WithdrawalRecord | null> {
    const row = await this.prisma.withdrawalIntentRecord.findUnique({ where: { id: intentId } });
    return row ? mapWithdrawalRow(row) : null;
  }

  async create(record: NewWithdrawalRecord): Promise<WithdrawalRecord> {
    const row = await this.prisma.withdrawalIntentRecord.create({
      data: {
        id: record.intentId,
        principalId: record.principalId,
        assetId: record.assetId,
        chainId: record.chainId,
        destination: record.destination,
        amountAtomic: record.amountAtomic,
        nonce: BigInt(record.nonce),
        deadline: BigInt(record.deadline),
        signature: record.signature,
        payloadHash: record.payloadHash ?? null,
        state: "RESERVED",
        reservedJournalId: record.reservedJournalId ?? null,
        treasuryAddress: record.treasuryAddress?.toLowerCase() ?? null,
        tokenAddress: record.tokenAddress?.toLowerCase() ?? null,
        replacementPolicy: REPLACEMENT_POLICY,
      },
    });
    return mapWithdrawalRow(row);
  }

  async transition(request: TransitionRequest): Promise<WithdrawalRecord | null> {
    const where: Prisma.WithdrawalIntentRecordWhereInput = {
      id: request.intentId,
      state: { in: request.from },
    };
    if (request.expectedTreasuryNonce !== undefined) {
      where.broadcastNonce = BigInt(request.expectedTreasuryNonce);
    }
    const data: Prisma.WithdrawalIntentRecordUpdateManyMutationInput = {
      state: request.to,
      ...patchToData(request.patch ?? {}),
    };
    const result = await this.prisma.withdrawalIntentRecord.updateMany({ where, data });
    if (result.count === 0) return null;
    return this.get(request.intentId);
  }

  async listByStates(states: WithdrawalState[], limit: number): Promise<WithdrawalRecord[]> {
    const rows = await this.prisma.withdrawalIntentRecord.findMany({
      where: { state: { in: states } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map(mapWithdrawalRow);
  }

  async maxPersistedTreasuryNonce(chainId: number, treasuryAddress: string): Promise<number> {
    // Reservation normalizes addresses. Filter the treasury BEFORE limiting;
    // another treasury's high nonces must never hide this treasury's maximum.
    const rows = await this.prisma.withdrawalIntentRecord.findMany({
      where: {
        chainId,
        treasuryAddress: treasuryAddress.toLowerCase(),
        broadcastNonce: { not: null },
      },
      orderBy: { broadcastNonce: "desc" },
      take: 1,
    });
    const row = rows[0];
    return row?.broadcastNonce === null || row?.broadcastNonce === undefined
      ? -1
      : toSafeNumber(row.broadcastNonce, "WithdrawalIntentRecord.broadcastNonce");
  }

  async withTreasuryLock<T>(
    chainId: number,
    treasuryAddress: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `custody:treasury:${chainId}:${treasuryAddress.toLowerCase()}`;
    if (this.advisory) {
      return this.advisory.run(key, fn);
    }
    return this.mutex.run(key, fn);
  }
}

/** Incident store backed by the canonical `FinancialIncident` model. */
export class PrismaIncidentStore implements IncidentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async open(input: OpenIncidentInput): Promise<IncidentRecord> {
    const openRows = await this.prisma.financialIncident.findMany({
      where: { kind: input.kind, status: { not: "RESOLVED" } },
    });
    const existing = openRows.find(
      (row) =>
        (row.assetId ?? null) === (input.assetId ?? null) &&
        (row.affectedId ?? null) === (input.intentId ?? null)
    );
    const evidence = toInputJson({
      ...(input.detail ?? {}),
      principalId: input.principalId,
      intentId: input.intentId,
    });
    if (existing) {
      const merged = toInputJson({
        ...asJsonObject(existing.evidence),
        ...(input.detail ?? {}),
        principalId: input.principalId,
        intentId: input.intentId,
      });
      const updated = await this.prisma.financialIncident.update({
        where: { id: existing.id },
        data: { evidence: merged },
      });
      return mapIncidentRow(updated);
    }
    const created = await this.prisma.financialIncident.create({
      data: {
        kind: input.kind,
        severity: input.severity,
        status: "OPEN",
        assetId: input.assetId ?? null,
        chainId: input.chainId ?? null,
        affectedId: input.intentId ?? input.assetId ?? null,
        evidence,
      },
    });
    return mapIncidentRow(created);
  }

  async get(incidentId: string): Promise<IncidentRecord | null> {
    const row = await this.prisma.financialIncident.findUnique({ where: { id: incidentId } });
    return row ? mapIncidentRow(row) : null;
  }

  async listOpen(filter?: {
    kind?: IncidentRecord["kind"];
    assetId?: string;
  }): Promise<IncidentRecord[]> {
    const rows = await this.prisma.financialIncident.findMany({
      where: {
        status: { not: "RESOLVED" },
        ...(filter?.kind ? { kind: filter.kind } : {}),
        ...(filter?.assetId ? { assetId: filter.assetId } : {}),
      },
    });
    return rows.map(mapIncidentRow);
  }

  async resolve(incidentId: string, resolution: IncidentResolution): Promise<IncidentRecord> {
    const current = await this.get(incidentId);
    if (!current) throw new Error(`Unknown incident: ${incidentId}`);
    const updated = await this.prisma.financialIncident.update({
      where: { id: incidentId },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        operatorId: resolution.resolvedBy,
        operatorEvidence: toInputJson({
          note: resolution.note,
          evidence: resolution.evidence ?? {},
        }),
        version: { increment: 1 },
      },
    });
    return mapIncidentRow(updated);
  }
}

/** Asset registry backed by the canonical `Asset` model. */
export class PrismaAssetRegistry implements AssetRegistry {
  constructor(private readonly prisma: PrismaClient) {}

  async get(assetId: string): Promise<TreasuryAsset | null> {
    const row = await this.prisma.asset.findUnique({ where: { id: assetId } });
    return row ? mapAssetRow(row) : null;
  }

  async list(): Promise<TreasuryAsset[]> {
    const rows = await this.prisma.asset.findMany({});
    return rows.map(mapAssetRow);
  }

  async setStatus(assetId: string, status: AssetStatus, reason: string): Promise<void> {
    const current = await this.get(assetId);
    if (!current) throw new Error(`Unknown asset: ${assetId}`);
    void reason;
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { status },
    });
  }
}
