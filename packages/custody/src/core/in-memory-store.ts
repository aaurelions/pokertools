/**
 * Deterministic in-memory implementations of the core custody ports.
 *
 * These are the reference semantics used by unit/fault-injection tests. They are
 * intentionally strict (CAS transitions, per-account serialization, idempotent
 * incident opening) so tests exercise the same guard rails the Prisma-backed
 * store enforces.
 */
/* eslint-disable @typescript-eslint/require-await -- in-memory doubles implement Promise-returning ports without real async I/O */
import type { AssetStatus } from "@pokertools/types";
import type {
  AssetRegistry,
  Clock,
  IncidentRecord,
  IncidentResolution,
  IncidentStore,
  NewWithdrawalRecord,
  OpenIncidentInput,
  ReconciliationEvidence,
  TreasuryAccounting,
  TreasuryAsset,
  TransitionRequest,
  WithdrawalRecord,
  WithdrawalState,
  WithdrawalStore,
} from "./types.js";
import { REPLACEMENT_POLICY } from "./types.js";

/** Simple per-key async mutex. Serializes all callbacks sharing a key. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Drop the map entry once this is the tail so keys do not accumulate.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

let sequence = 0;

export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export class InMemoryWithdrawalStore implements WithdrawalStore {
  private records = new Map<string, WithdrawalRecord>();
  private mutex = new KeyedMutex();

  constructor(private readonly clock: Clock) {}

  async get(intentId: string): Promise<WithdrawalRecord | null> {
    const record = this.records.get(intentId);
    return record ? { ...record } : null;
  }

  async create(record: NewWithdrawalRecord): Promise<WithdrawalRecord> {
    if (this.records.has(record.intentId)) {
      throw new Error(`Withdrawal intent already exists: ${record.intentId}`);
    }
    const now = this.clock.now();
    const stored: WithdrawalRecord = {
      ...record,
      payloadHash: record.payloadHash ?? null,
      reservedJournalId: record.reservedJournalId ?? null,
      treasuryAddress: record.treasuryAddress ?? null,
      tokenAddress: record.tokenAddress ?? null,
      state: "RESERVED",
      signedRawTx: null,
      signedCallData: null,
      signedValueAtomic: null,
      txHash: null,
      treasuryNonce: null,
      receiptBlockNumber: null,
      receiptBlockHash: null,
      confirmedJournalId: null,
      reorgJournalId: null,
      replacementPolicy: REPLACEMENT_POLICY,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.intentId, stored);
    return { ...stored };
  }

  async transition(request: TransitionRequest): Promise<WithdrawalRecord | null> {
    const current = this.records.get(request.intentId);
    if (!current) return null;
    if (!request.from.includes(current.state)) return null;
    if (
      request.expectedTreasuryNonce !== undefined &&
      current.treasuryNonce !== null &&
      current.treasuryNonce !== request.expectedTreasuryNonce
    ) {
      return null;
    }
    const patch = request.patch ?? {};
    const updated: WithdrawalRecord = {
      ...current,
      ...patch,
      state: request.to,
      updatedAt: this.clock.now(),
    };
    this.records.set(request.intentId, updated);
    return { ...updated };
  }

  async listByStates(states: WithdrawalState[], limit: number): Promise<WithdrawalRecord[]> {
    const matches = [...this.records.values()]
      .filter((record) => states.includes(record.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    return matches.map((record) => ({ ...record }));
  }

  async maxPersistedTreasuryNonce(chainId: number, treasuryAddress: string): Promise<number> {
    let max = -1;
    for (const record of this.records.values()) {
      if (
        record.chainId === chainId &&
        record.treasuryNonce !== null &&
        record.treasuryNonce > max
      ) {
        max = record.treasuryNonce;
      }
    }
    void treasuryAddress;
    return max;
  }

  async withTreasuryLock<T>(
    chainId: number,
    treasuryAddress: string,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.mutex.run(`treasury:${chainId}:${treasuryAddress.toLowerCase()}`, fn);
  }
}

export class InMemoryIncidentStore implements IncidentStore {
  private incidents = new Map<string, IncidentRecord>();

  constructor(private readonly clock: Clock) {}

  async open(input: OpenIncidentInput): Promise<IncidentRecord> {
    for (const existing of this.incidents.values()) {
      if (
        existing.status !== "RESOLVED" &&
        existing.kind === input.kind &&
        (existing.intentId ?? null) === (input.intentId ?? null) &&
        (existing.assetId ?? null) === (input.assetId ?? null)
      ) {
        return { ...existing, detail: { ...existing.detail, ...(input.detail ?? {}) } };
      }
    }
    const record: IncidentRecord = {
      incidentId: nextId("inc"),
      kind: input.kind,
      severity: input.severity,
      status: "OPEN",
      assetId: input.assetId,
      chainId: input.chainId,
      principalId: input.principalId,
      intentId: input.intentId,
      detail: input.detail ?? {},
      openedAt: this.clock.now(),
    };
    this.incidents.set(record.incidentId, record);
    return { ...record };
  }

  async get(incidentId: string): Promise<IncidentRecord | null> {
    const record = this.incidents.get(incidentId);
    return record ? { ...record } : null;
  }

  async listOpen(filter?: {
    kind?: IncidentRecord["kind"];
    assetId?: string;
  }): Promise<IncidentRecord[]> {
    return [...this.incidents.values()]
      .filter((record) => record.status !== "RESOLVED")
      .filter((record) => (filter?.kind ? record.kind === filter.kind : true))
      .filter((record) => (filter?.assetId ? record.assetId === filter.assetId : true))
      .map((record) => ({ ...record }));
  }

  async resolve(incidentId: string, resolution: IncidentResolution): Promise<IncidentRecord> {
    const record = this.incidents.get(incidentId);
    if (!record) throw new Error(`Unknown incident: ${incidentId}`);
    const resolved: IncidentRecord = {
      ...record,
      status: "RESOLVED",
      resolvedAt: this.clock.now(),
      detail: { ...record.detail, resolution },
    };
    this.incidents.set(incidentId, resolved);
    return { ...resolved };
  }
}

export class InMemoryAssetRegistry implements AssetRegistry {
  private assets = new Map<string, TreasuryAsset>();
  private reasons: Array<{ assetId: string; status: AssetStatus; reason: string; at: number }> = [];

  constructor(
    private readonly clock: Clock,
    assets: TreasuryAsset[] = []
  ) {
    for (const asset of assets) {
      this.assets.set(asset.assetId, { ...asset, rpcUrls: [...asset.rpcUrls] });
    }
  }

  async get(assetId: string): Promise<TreasuryAsset | null> {
    const asset = this.assets.get(assetId);
    return asset ? { ...asset, rpcUrls: [...asset.rpcUrls] } : null;
  }

  async list(): Promise<TreasuryAsset[]> {
    return [...this.assets.values()].map((asset) => ({ ...asset, rpcUrls: [...asset.rpcUrls] }));
  }

  async setStatus(assetId: string, status: AssetStatus, reason: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`Unknown asset: ${assetId}`);
    this.assets.set(assetId, { ...asset, status });
    this.reasons.push({ assetId, status, reason, at: this.clock.now() });
  }

  statusHistory(): ReadonlyArray<{
    assetId: string;
    status: AssetStatus;
    reason: string;
    at: number;
  }> {
    return [...this.reasons];
  }
}

export interface RecordedJournalEntry {
  kind: "WITHDRAWAL_CONFIRMED" | "INCIDENT_OBLIGATION" | "RECONCILIATION";
  intentId?: string;
  assetId: string;
  amountAtomic: string;
  journalId: string;
  evidence?: ReconciliationEvidence;
  at: number;
}

export class InMemoryTreasuryAccounting implements TreasuryAccounting {
  public readonly entries: RecordedJournalEntry[] = [];
  public expected: Record<string, string> = {};

  constructor(private readonly clock: Clock) {}

  private record(entry: Omit<RecordedJournalEntry, "journalId" | "at">): { journalId: string } {
    const journalId = nextId("jrnl");
    this.entries.push({ ...entry, journalId, at: this.clock.now() });
    return { journalId };
  }

  async completeWithdrawal(record: WithdrawalRecord): Promise<{ journalId: string }> {
    return this.record({
      kind: "WITHDRAWAL_CONFIRMED",
      intentId: record.intentId,
      assetId: record.assetId,
      amountAtomic: record.amountAtomic,
    });
  }

  async recordObligation(
    record: WithdrawalRecord,
    _incident: IncidentRecord
  ): Promise<{ journalId: string }> {
    return this.record({
      kind: "INCIDENT_OBLIGATION",
      intentId: record.intentId,
      assetId: record.assetId,
      amountAtomic: record.amountAtomic,
    });
  }

  async recordReconciliation(evidence: ReconciliationEvidence): Promise<{ journalId: string }> {
    return this.record({
      kind: "RECONCILIATION",
      assetId: evidence.assetId,
      amountAtomic: evidence.custodyAtomic,
      evidence,
    });
  }

  async expectedTreasuryAtomic(assetId: string): Promise<string> {
    return this.expected[assetId] ?? "0";
  }
}
