import crypto from "node:crypto";
import { AssetIdSchema, MAX_UINT256 } from "@pokertools/types";
import type { AtomicAccountClass, Prisma, PrismaClient } from "../../generated/prisma/index.js";
import { AppError, InsufficientFundsError } from "../utils/errors.js";

/**
 * AtomicLedger — canonical multi-asset, append-only, balanced journal.
 *
 * Invariants:
 * - Every journal transaction's postings sum to exactly zero (bigint) per asset.
 * - History (JournalTransaction + JournalPosting) is append-only/immutable.
 * - Cached AtomicAccount balances are a projection updated with compare-and-swap
 *   on `version`; callers must run `post` inside a transaction so a failed CAS
 *   rolls the whole write back.
 * - User-owned accounts may never go negative. System-owned accounts
 *   (ownerId === null) may be debited explicitly.
 * - A durable per-asset `Asset.ledgerVersion` is incremented inside every write
 *   transaction. This serializes all posts/rebuilds for the same asset and lets
 *   reconciliation/readiness fence against concurrent writers.
 *
 * Amounts are canonical SIGNED decimal strings, never cents/chips. This module
 * performs no unit conversion of any kind.
 */

/**
 * Canonical signed decimal string: no leading zeros, no `-0`, no `+`, no
 * whitespace/exponent.
 */
export const SIGNED_ATOMIC_PATTERN = /^(0|-?[1-9][0-9]*)$/;

/** Parse a canonical signed atomic decimal string into a bigint. */
export function parseSignedAtomic(value: unknown): bigint {
  if (typeof value !== "string" || !SIGNED_ATOMIC_PATTERN.test(value) || value === "-0") {
    throw new LedgerInvariantError("Amount is not a canonical signed decimal string");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256 || parsed < -MAX_UINT256) {
    throw new LedgerInvariantError("Amount is outside the signed uint256 range");
  }
  return parsed;
}

/** Serialize a bigint into a canonical signed atomic decimal string. */
export function serializeSignedAtomic(value: bigint): string {
  if (value > MAX_UINT256 || value < -MAX_UINT256) {
    throw new LedgerInvariantError("Amount is outside the signed uint256 range");
  }
  return value.toString();
}

export class LedgerInvariantError extends AppError {
  constructor(message: string) {
    super(message, 500, "LEDGER_INVARIANT");
  }
}

export class LedgerConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "LEDGER_CONFLICT");
  }
}

export class ConcurrentLedgerModificationError extends AppError {
  constructor(message = "Concurrent ledger modification detected") {
    super(message, 409, "LEDGER_CONCURRENT_MODIFICATION");
  }
}

export interface LedgerPostingInput {
  accountId: string;
  /** Signed canonical decimal string (negative = debit). */
  amountAtomic: string;
}

export interface LedgerPostInput {
  /** Optional caller-provided transaction id; generated when omitted. */
  id?: string;
  /** Globally unique idempotency key for this journal transaction. */
  requestId: string;
  assetId: string;
  /**
   * Optional pre-computed payload hash. It is NEVER trusted: the ledger
   * recomputes from the actual postings and rejects any mismatch.
   */
  payloadHash?: string;
  postings: LedgerPostingInput[];
}

export interface PostedJournal {
  id: string;
  assetId: string;
  requestId: string;
  payloadHash: string;
  createdAt: Date;
  postings: Array<{ id: string; accountId: string; amountAtomic: string }>;
}

export interface AtomicBalance {
  accountId: string;
  assetId: string;
  ownerId: string | null;
  class: string;
  balanceAtomic: string;
  version: number;
}

/** Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

/**
 * Transient PostgreSQL transaction conflicts (serialization failure, deadlock,
 * Prisma transaction conflict). These are safe to retry at an outer boundary.
 */
export function isTransientTransactionConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (
    code === "40001" ||
    code === "40P01" ||
    code === "P2034" ||
    code === "P2028" ||
    code === "P2024"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("Operation has timed out") || message.includes("Transaction already closed")
  );
}

/**
 * Deterministic, order-independent content hash over canonicalized postings
 * (sorted by account then amount). Duplicate legs are preserved.
 */
export function computeJournalPayloadHash(assetId: string, postings: LedgerPostingInput[]): string {
  const legs = postings
    .map((posting) => ({
      accountId: posting.accountId,
      amountAtomic: serializeSignedAtomic(parseSignedAtomic(posting.amountAtomic)),
    }))
    .sort((a, b) => {
      if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
      if (a.amountAtomic !== b.amountAtomic) return a.amountAtomic < b.amountAtomic ? -1 : 1;
      return 0;
    });
  const canonical = JSON.stringify({ assetId, postings: legs });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Run `work` in a transaction, retrying transient PG conflicts and unique
 * violations at the OUTER transaction boundary. Never re-query inside an
 * aborted transaction.
 */
export async function runTransactionWithRetry<T>(
  prisma: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Interactive transactions wait for the durable asset/journal row lock.
      // Local SQLite is a single-writer file shared with workers; allow it to
      // queue behind other writers rather than failing at the 5s default.
      return await prisma.$transaction(work, { maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      lastError = error;
      const retryable = isTransientTransactionConflict(error) || isUniqueViolation(error);
      if (!retryable || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50 * attempt, 400)));
    }
  }
  throw lastError;
}

function toPostedJournal(record: {
  id: string;
  assetId: string;
  requestId: string;
  payloadHash: string;
  createdAt: Date;
  postings: Array<{ id: string; accountId: string; amountAtomic: string }>;
}): PostedJournal {
  return {
    id: record.id,
    assetId: record.assetId,
    requestId: record.requestId,
    payloadHash: record.payloadHash,
    createdAt: record.createdAt,
    postings: record.postings.map((posting) => ({
      id: posting.id,
      accountId: posting.accountId,
      amountAtomic: posting.amountAtomic,
    })),
  };
}

export class AtomicLedger {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Acquire the durable per-asset write lock by incrementing `ledgerVersion`
   * inside the caller's transaction. Returns false when the asset is unknown.
   */
  async lockAsset(client: Prisma.TransactionClient, assetId: string): Promise<boolean> {
    const asset = await client.asset.findUnique({
      where: { id: assetId },
      select: { id: true },
    });
    if (!asset) return false;
    await client.asset.update({
      where: { id: assetId },
      data: { ledgerVersion: { increment: 1 } },
    });
    return true;
  }

  /**
   * Append one balanced journal transaction and update the cached balances.
   *
   * MUST be called inside a transaction. Idempotent on `requestId`: replaying
   * an identical payload returns the existing journal; replaying with a
   * different payload is a conflict. The idempotency read happens AFTER the
   * durable asset lock, so a committed winner is observed deterministically.
   */
  async post(client: Prisma.TransactionClient, input: LedgerPostInput): Promise<PostedJournal> {
    const assetId = AssetIdSchema.parse(input.assetId);
    if (typeof input.requestId !== "string" || input.requestId.length === 0) {
      throw new LedgerInvariantError("requestId is required");
    }
    if (!Array.isArray(input.postings) || input.postings.length < 2) {
      throw new LedgerInvariantError("A journal transaction requires at least two postings");
    }

    let sum = 0n;
    const normalized = input.postings.map((posting) => {
      const amount = parseSignedAtomic(posting.amountAtomic);
      if (amount === 0n) {
        throw new LedgerInvariantError("Zero-amount postings are not allowed");
      }
      sum += amount;
      return { accountId: posting.accountId, amount };
    });
    if (sum !== 0n) {
      throw new LedgerInvariantError("Journal postings must sum to zero");
    }

    // Never trust a caller-supplied hash: recompute from the real postings and
    // reject a mismatch (prevents replaying old economics under a new hash).
    const payloadHash = computeJournalPayloadHash(assetId, input.postings);
    if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
      throw new LedgerConflictError("Supplied payloadHash does not match the journal postings");
    }

    // Serialize per asset. This is the first write lock every ledger path takes.
    const locked = await this.lockAsset(client, assetId);
    if (!locked) {
      throw new LedgerInvariantError("Unknown asset for journal transaction");
    }

    const existing = await client.journalTransaction.findUnique({
      where: { requestId: input.requestId },
      include: { postings: true },
    });
    if (existing) {
      if (existing.assetId !== assetId || existing.payloadHash !== payloadHash) {
        throw new LedgerConflictError("requestId was already used with a different payload");
      }
      return toPostedJournal(existing);
    }

    // Let a unique violation propagate to the OUTER transaction boundary; do
    // not query inside this (potentially aborted) transaction.
    const transaction = await client.journalTransaction.create({
      data: {
        ...(input.id !== undefined ? { id: input.id } : {}),
        assetId,
        requestId: input.requestId,
        payloadHash,
        // Journal is created unsealed, populated, then sealed below in the same
        // transaction so it can never be extended after commit.
        sealed: false,
      },
      select: { id: true },
    });

    // Append immutable posting rows preserving every individual leg.
    await client.journalPosting.createMany({
      data: normalized.map((posting) => ({
        transactionId: transaction.id,
        assetId,
        accountId: posting.accountId,
        amountAtomic: serializeSignedAtomic(posting.amount),
      })),
    });

    // Apply balance deltas aggregated per account, in sorted account order, to
    // avoid deadlocks between concurrent transactions.
    const deltas = new Map<string, bigint>();
    for (const posting of normalized) {
      deltas.set(posting.accountId, (deltas.get(posting.accountId) ?? 0n) + posting.amount);
    }
    const accountIds = [...deltas.keys()].sort();
    for (const accountId of accountIds) {
      await this.applyBalanceDelta(client, assetId, accountId, deltas.get(accountId)!);
    }

    // Seal: the only permitted update to a journal transaction. After commit,
    // no further posting may be added to this group.
    await client.journalTransaction.update({
      where: { id: transaction.id },
      data: { sealed: true },
    });

    const completed = await client.journalTransaction.findUniqueOrThrow({
      where: { id: transaction.id },
      include: { postings: true },
    });
    return toPostedJournal(completed);
  }

  /** Convenience wrapper that owns the transaction boundary + conflict retry. */
  async postAtomic(input: LedgerPostInput, maxAttempts = 3): Promise<PostedJournal> {
    return runTransactionWithRetry(this.prisma, (tx) => this.post(tx, input), maxAttempts);
  }

  private async applyBalanceDelta(
    client: Prisma.TransactionClient,
    assetId: string,
    accountId: string,
    delta: bigint
  ): Promise<void> {
    const account = await client.atomicAccount.findUnique({ where: { id: accountId } });
    if (!account || account.assetId !== assetId) {
      throw new LedgerInvariantError("Posting account does not belong to the transaction asset");
    }

    const current = parseSignedAtomic(account.balanceAtomic);
    const next = current + delta;
    if (account.ownerId !== null && next < 0n) {
      throw new InsufficientFundsError("Insufficient atomic balance for user account");
    }

    const updated = await client.atomicAccount.updateMany({
      where: { id: accountId, assetId, version: account.version },
      data: { balanceAtomic: serializeSignedAtomic(next), version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new ConcurrentLedgerModificationError();
    }
  }

  /** Read a journal transaction (with postings) by its idempotency key. */
  async readJournal(
    client: Prisma.TransactionClient | PrismaClient,
    requestId: string
  ): Promise<PostedJournal | null> {
    const record = await client.journalTransaction.findUnique({
      where: { requestId },
      include: { postings: true },
    });
    return record ? toPostedJournal(record) : null;
  }

  /** Read every cached balance for an owner across assets. */
  async listBalancesForOwner(
    client: Prisma.TransactionClient | PrismaClient,
    ownerId: string
  ): Promise<AtomicBalance[]> {
    const accounts = await client.atomicAccount.findMany({
      where: { ownerId },
      orderBy: [{ assetId: "asc" }, { class: "asc" }],
    });
    return accounts.map((account) => ({
      accountId: account.id,
      assetId: account.assetId,
      ownerId: account.ownerId,
      class: account.class,
      balanceAtomic: account.balanceAtomic,
      version: account.version,
    }));
  }

  /** Read one cached balance, returning null when the account does not exist. */
  async getAccount(
    client: Prisma.TransactionClient | PrismaClient,
    params: { assetId: string; ownerId: string | null; class: AtomicAccountClass }
  ): Promise<AtomicBalance | null> {
    const ownerKey = params.ownerId ?? "@system";
    const account = await client.atomicAccount.findUnique({
      where: {
        assetId_ownerKey_class: {
          assetId: params.assetId,
          ownerKey,
          class: params.class,
        },
      },
    });
    if (!account) return null;
    return {
      accountId: account.id,
      assetId: account.assetId,
      ownerId: account.ownerId,
      class: account.class,
      balanceAtomic: account.balanceAtomic,
      version: account.version,
    };
  }

  /**
   * Read an account, materializing a zero-balance row when absent.
   *
   * Deliberately avoids `upsert`: it performs a plain read first and only
   * INSERTs when missing, so it never takes an update lock on an existing row
   * before the caller acquires the asset lock. A concurrent create race
   * surfaces as a unique violation and is retried at the outer boundary.
   */
  async ensureAccount(
    client: Prisma.TransactionClient,
    params: { assetId: string; ownerId: string | null; class: AtomicAccountClass }
  ): Promise<AtomicBalance> {
    const assetId = AssetIdSchema.parse(params.assetId);
    const ownerKey = params.ownerId ?? "@system";
    const existing = await client.atomicAccount.findUnique({
      where: { assetId_ownerKey_class: { assetId, ownerKey, class: params.class } },
    });
    if (existing) {
      return {
        accountId: existing.id,
        assetId: existing.assetId,
        ownerId: existing.ownerId,
        class: existing.class,
        balanceAtomic: existing.balanceAtomic,
        version: existing.version,
      };
    }

    const created = await client.atomicAccount.create({
      data: {
        assetId,
        ownerId: params.ownerId,
        ownerKey,
        class: params.class,
        balanceAtomic: "0",
      },
    });
    return {
      accountId: created.id,
      assetId: created.assetId,
      ownerId: created.ownerId,
      class: created.class,
      balanceAtomic: created.balanceAtomic,
      version: created.version,
    };
  }

  /**
   * Fully verify an asset: every journal transaction group sums to zero AND
   * every cached account projection equals the sum of its postings. Checking
   * only the aggregate would miss two imbalanced transactions that net to zero.
   */
  async assertAssetBalanced(
    client: Prisma.TransactionClient | PrismaClient,
    assetId: string
  ): Promise<{ postings: number; transactions: number; total: string }> {
    const postings = await client.journalPosting.findMany({
      where: { assetId },
      select: { transactionId: true, accountId: true, amountAtomic: true },
    });

    const perTransaction = new Map<string, { total: bigint; count: number }>();
    const perAccount = new Map<string, bigint>();
    for (const posting of postings) {
      const amount = parseSignedAtomic(posting.amountAtomic);
      const entry = perTransaction.get(posting.transactionId) ?? { total: 0n, count: 0 };
      entry.total += amount;
      entry.count += 1;
      perTransaction.set(posting.transactionId, entry);
      perAccount.set(posting.accountId, (perAccount.get(posting.accountId) ?? 0n) + amount);
    }

    const transactions = await client.journalTransaction.findMany({
      where: { assetId },
      select: { id: true, sealed: true },
    });
    if (transactions.length !== perTransaction.size) {
      throw new LedgerInvariantError("Journal transaction exists without postings or vice versa");
    }
    for (const transaction of transactions) {
      const entry = perTransaction.get(transaction.id);
      if (!entry) {
        throw new LedgerInvariantError("Journal transaction has no postings");
      }
      if (!transaction.sealed) {
        throw new LedgerInvariantError(`Journal transaction is not sealed: ${transaction.id}`);
      }
      if (entry.count < 2) {
        throw new LedgerInvariantError(`Journal transaction has fewer than two postings`);
      }
      if (entry.total !== 0n) {
        throw new LedgerInvariantError(`Journal transaction is not balanced: ${transaction.id}`);
      }
    }

    const accounts = await client.atomicAccount.findMany({
      where: { assetId },
      select: { id: true, ownerId: true, balanceAtomic: true },
    });
    for (const account of accounts) {
      const expected = perAccount.get(account.id) ?? 0n;
      if (account.ownerId !== null && expected < 0n) {
        throw new LedgerInvariantError("User account has negative net postings");
      }
      if (parseSignedAtomic(account.balanceAtomic) !== expected) {
        throw new LedgerInvariantError(`Balance projection diverged for account ${account.id}`);
      }
    }

    let total = 0n;
    for (const value of perAccount.values()) total += value;
    if (total !== 0n) {
      throw new LedgerInvariantError("Asset journal is not balanced");
    }

    return {
      postings: postings.length,
      transactions: perTransaction.size,
      total: total.toString(),
    };
  }

  /**
   * Deterministically rebuild the cached balance projection from the immutable
   * journal. Only AtomicAccount projection rows are touched; journal history is
   * never modified. Acquires every asset's durable lock in sorted order before
   * snapshotting, so a concurrent committed posting cannot be overwritten.
   * Running twice produces no further changes.
   */
  async rebuild(): Promise<{ assets: number; accounts: number; changed: number }> {
    return runTransactionWithRetry(this.prisma, async (tx: Prisma.TransactionClient) => {
      const assets = await tx.asset.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      });
      // Lock every asset (sorted) BEFORE snapshotting so all posts for these
      // assets are ordered against this rebuild.
      for (const asset of assets) {
        await tx.asset.update({
          where: { id: asset.id },
          data: { ledgerVersion: { increment: 1 } },
        });
      }

      const [postings, accounts] = await Promise.all([
        tx.journalPosting.findMany({
          select: { accountId: true, amountAtomic: true },
        }),
        tx.atomicAccount.findMany({
          select: { id: true, balanceAtomic: true },
        }),
      ]);

      const sums = new Map<string, bigint>();
      for (const posting of postings) {
        sums.set(
          posting.accountId,
          (sums.get(posting.accountId) ?? 0n) + parseSignedAtomic(posting.amountAtomic)
        );
      }

      let changed = 0;
      for (const account of accounts) {
        const next = sums.get(account.id) ?? 0n;
        if (parseSignedAtomic(account.balanceAtomic) !== next) {
          await tx.atomicAccount.update({
            where: { id: account.id },
            data: { balanceAtomic: serializeSignedAtomic(next), version: { increment: 1 } },
          });
          changed += 1;
        }
      }

      return { assets: assets.length, accounts: accounts.length, changed };
    });
  }
}
