import type {
  ChipAccountKind,
  ChipEntryType,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/index.js";
import { AppError, InsufficientFundsError } from "../utils/errors.js";

/**
 * ChipLedger — durable principal chip accounting.
 *
 * Chips are integer, independent gameplay units. They are NOT cents and have no
 * implied asset value. This ledger records:
 *   - operator/fixture GRANTs (the only way a PLAY_CHIPS account is funded),
 *   - transfers between AVAILABLE, TABLE_RESERVE, TOURNAMENT_RESERVE and
 *     OPERATOR accounts.
 *
 * Every mutation is an append-only `ChipLedgerEntry` paired with a
 * compare-and-swap on the cached `ChipAccount.balance`/`version`. Callers MUST
 * run these methods inside a transaction so a failed CAS rolls the journal back.
 *
 * This module performs no unit conversion of any kind: chip amounts in, chip
 * amounts out. Asset conversion lives in `economic-policy.ts`.
 */

export class ChipInvariantError extends AppError {
  constructor(message: string) {
    super(message, 500, "CHIP_INVARIANT");
  }
}

export class ChipConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CHIP_CONFLICT");
  }
}

export class ChipConcurrentModificationError extends AppError {
  constructor(message = "Concurrent chip account modification detected") {
    super(message, 409, "CHIP_CONCURRENT_MODIFICATION");
  }
}

export interface ChipAccountRef {
  principalId: string;
  kind: ChipAccountKind;
  /** Table/tournament id for reserve accounts. Ignored for AVAILABLE/OPERATOR. */
  scopeId?: string | null;
}

export interface ChipMutation {
  accountId: string;
  entryId: string;
  amount: bigint;
  balanceAfter: bigint;
  replayed: boolean;
}

export interface ChipDeltaOptions {
  type: ChipEntryType;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface ChipBalances {
  /** Available (unreserved) chips. */
  available: bigint;
  /** Chips escrowed on tables (TABLE_RESERVE). */
  inPlay: bigint;
  /** Chips escrowed in tournaments (TOURNAMENT_RESERVE). */
  tournament: bigint;
  /** Chips cannot be withdrawn on chain; only asset accounts carry that liability. */
  pendingWithdrawal: bigint;
}

function scopeKeyFor(ref: ChipAccountRef): string {
  if (ref.scopeId !== undefined && ref.scopeId !== null) return ref.scopeId;
  if (ref.kind === "AVAILABLE") return "@owner";
  if (ref.kind === "OPERATOR") return "@system";
  throw new ChipInvariantError(`Reserve account for ${ref.kind} requires a scopeId`);
}

export class ChipLedger {
  constructor(private readonly prisma: PrismaClient) {}

  /** Materialize (or read) the account for a reference. Safe inside a tx. */
  async ensureAccount(client: Prisma.TransactionClient, ref: ChipAccountRef) {
    const scopeKey = scopeKeyFor(ref);
    return client.chipAccount.upsert({
      where: {
        principalId_kind_scopeKey: {
          principalId: ref.principalId,
          kind: ref.kind,
          scopeKey,
        },
      },
      create: {
        principalId: ref.principalId,
        kind: ref.kind,
        scopeKey,
        balance: 0n,
      },
      update: {},
    });
  }

  /** Read an account without materializing it. */
  async getAccount(client: Prisma.TransactionClient | PrismaClient, ref: ChipAccountRef) {
    const scopeKey = scopeKeyFor(ref);
    return client.chipAccount.findUnique({
      where: {
        principalId_kind_scopeKey: {
          principalId: ref.principalId,
          kind: ref.kind,
          scopeKey,
        },
      },
    });
  }

  /**
   * Apply one signed chip delta and append the journal row. Idempotent on
   * `idempotencyKey`; a replay with a different amount is a conflict.
   */
  async applyDelta(
    client: Prisma.TransactionClient,
    ref: ChipAccountRef,
    delta: bigint,
    options: ChipDeltaOptions
  ): Promise<ChipMutation> {
    if (delta === 0n) {
      throw new ChipInvariantError("Zero chip postings are not allowed");
    }

    const account = await this.ensureAccount(client, ref);

    if (options.idempotencyKey) {
      const existing = await client.chipLedgerEntry.findUnique({
        where: { idempotencyKey: options.idempotencyKey },
      });
      if (existing) {
        if (existing.accountId !== account.id || existing.amount !== delta) {
          throw new ChipConflictError(
            "idempotencyKey was already used with a different chip delta"
          );
        }
        return {
          accountId: existing.accountId,
          entryId: existing.id,
          amount: existing.amount,
          balanceAfter: existing.balanceAfter,
          replayed: true,
        };
      }
    }

    const current = account.balance;
    const next = current + delta;
    if (next < 0n) {
      throw new InsufficientFundsError(
        `Insufficient chips for account ${account.id}: balance ${current}, delta ${delta}`
      );
    }

    const updated = await client.chipAccount.updateMany({
      where: { id: account.id, version: account.version },
      data: { balance: next, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new ChipConcurrentModificationError();
    }

    let entry;
    try {
      entry = await client.chipLedgerEntry.create({
        data: {
          accountId: account.id,
          amount: delta,
          balanceAfter: next,
          type: options.type,
          referenceId: options.referenceId ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
          metadata: options.metadata,
        },
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2002") {
        throw new ChipConflictError("Chip journal idempotency key already exists");
      }
      throw error;
    }

    return {
      accountId: account.id,
      entryId: entry.id,
      amount: delta,
      balanceAfter: next,
      replayed: false,
    };
  }

  /**
   * Move chips between two accounts. Idempotent on `idempotencyKey`; the debit
   * and credit are recorded with suffixed keys and a shared referenceId.
   */
  async transfer(
    client: Prisma.TransactionClient,
    from: ChipAccountRef,
    to: ChipAccountRef,
    amount: bigint,
    options: ChipDeltaOptions
  ): Promise<{ debit: ChipMutation; credit: ChipMutation; replayed: boolean }> {
    if (amount <= 0n) {
      throw new ChipInvariantError("Chip transfer amount must be positive");
    }
    const key = options.idempotencyKey ?? null;

    if (key) {
      const existing = await client.chipLedgerEntry.findUnique({
        where: { idempotencyKey: `${key}:out` },
      });
      if (existing) {
        const credit = await client.chipLedgerEntry.findUnique({
          where: { idempotencyKey: `${key}:in` },
        });
        return {
          debit: {
            accountId: existing.accountId,
            entryId: existing.id,
            amount: existing.amount,
            balanceAfter: existing.balanceAfter,
            replayed: true,
          },
          credit: credit
            ? {
                accountId: credit.accountId,
                entryId: credit.id,
                amount: credit.amount,
                balanceAfter: credit.balanceAfter,
                replayed: true,
              }
            : {
                accountId: "",
                entryId: "",
                amount,
                balanceAfter: 0n,
                replayed: true,
              },
          replayed: true,
        };
      }
    }

    const debit = await this.applyDelta(client, from, -amount, {
      ...options,
      idempotencyKey: key ? `${key}:out` : null,
    });
    const credit = await this.applyDelta(client, to, amount, {
      ...options,
      type: options.type === "TRANSFER_OUT" ? "TRANSFER_IN" : options.type,
      idempotencyKey: key ? `${key}:in` : null,
    });
    return { debit, credit, replayed: false };
  }

  /**
   * Operator/fixture chip grant. The only funding path for PLAY_CHIPS. Records
   * an append-only `ChipGrant` linked to its journal entry. Idempotent on
   * `idempotencyKey`.
   */
  async grant(
    client: Prisma.TransactionClient,
    input: {
      principalId: string;
      amount: bigint;
      reason: string;
      operatorId: string;
      idempotencyKey: string;
    }
  ): Promise<{ entry: ChipMutation; grantId: string; replayed: boolean }> {
    if (input.amount <= 0n) {
      throw new ChipInvariantError("Chip grant amount must be positive");
    }
    if (!input.idempotencyKey) {
      throw new ChipInvariantError("Chip grant requires an idempotencyKey");
    }

    const existingGrant = await client.chipGrant.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existingGrant) {
      const entry = existingGrant.ledgerEntryId
        ? await client.chipLedgerEntry.findUnique({ where: { id: existingGrant.ledgerEntryId } })
        : null;
      return {
        grantId: existingGrant.id,
        entry: {
          accountId: entry?.accountId ?? "",
          entryId: entry?.id ?? "",
          amount: existingGrant.amount,
          balanceAfter: entry?.balanceAfter ?? 0n,
          replayed: true,
        },
        replayed: true,
      };
    }

    const entry = await this.applyDelta(
      client,
      { principalId: input.principalId, kind: "AVAILABLE" },
      input.amount,
      {
        type: "GRANT",
        referenceId: `grant:${input.idempotencyKey}`,
        idempotencyKey: `grant:${input.idempotencyKey}`,
        metadata: { reason: input.reason, operatorId: input.operatorId },
      }
    );

    const grant = await client.chipGrant.create({
      data: {
        principalId: input.principalId,
        amount: input.amount,
        reason: input.reason,
        operatorId: input.operatorId,
        idempotencyKey: input.idempotencyKey,
        ledgerEntryId: entry.entryId,
      },
    });

    return { entry, grantId: grant.id, replayed: false };
  }

  /** Read the AVAILABLE balance for a principal (0 when no account exists). */
  async getAvailable(
    client: Prisma.TransactionClient | PrismaClient,
    principalId: string
  ): Promise<bigint> {
    const account = await this.getAccount(client, { principalId, kind: "AVAILABLE" });
    return account?.balance ?? 0n;
  }

  /** Sum of all reserve balances for a principal. */
  async getReservedTotal(
    client: Prisma.TransactionClient | PrismaClient,
    principalId: string
  ): Promise<bigint> {
    const accounts = await client.chipAccount.findMany({
      where: { principalId, kind: { in: ["TABLE_RESERVE", "TOURNAMENT_RESERVE"] } },
      select: { balance: true },
    });
    return accounts.reduce((sum, account) => sum + account.balance, 0n);
  }

  /** Aggregate chip balances used by the user-facing balance projection. */
  async getBalances(
    client: Prisma.TransactionClient | PrismaClient,
    principalId: string
  ): Promise<ChipBalances> {
    const accounts = await client.chipAccount.findMany({
      where: { principalId },
      select: { kind: true, balance: true },
    });
    const sumKind = (kind: ChipAccountKind) =>
      accounts
        .filter((account) => account.kind === kind)
        .reduce((sum, account) => sum + account.balance, 0n);
    return {
      available: sumKind("AVAILABLE"),
      inPlay: sumKind("TABLE_RESERVE"),
      tournament: sumKind("TOURNAMENT_RESERVE"),
      pendingWithdrawal: 0n,
    };
  }

  /** Ensure a principal has a materialized AVAILABLE account. */
  async ensureAvailableAccount(client: Prisma.TransactionClient, principalId: string) {
    return this.ensureAccount(client, { principalId, kind: "AVAILABLE" });
  }

  /**
   * Recent append-only chip journal entries for a principal across every chip
   * account (available and reserves). Amounts stay as bigint here; the wire
   * projection is responsible for canonical decimal strings.
   */
  async listEntries(
    client: Prisma.TransactionClient | PrismaClient,
    principalId: string,
    take = 20
  ) {
    return client.chipLedgerEntry.findMany({
      where: { account: { principalId } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        amount: true,
        balanceAfter: true,
        type: true,
        referenceId: true,
        createdAt: true,
      },
    });
  }
}
