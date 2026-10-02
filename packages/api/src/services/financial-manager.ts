import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import { ChipLedger, type ChipAccountRef, type ChipBalances } from "./chip-ledger.js";
import { EconomicPolicyService } from "./economic-policy.js";
import { ValidationError } from "../utils/errors.js";

/**
 * FinancialManager — economic integration for the engine.
 *
 * Engine chips are integer gameplay units. PLAY_CHIPS tables/tournaments settle
 * against the durable principal `ChipAccount` balance and append-only chip
 * journal. They do NOT touch legacy cents/`Account`/`LedgerEntry` rows and do
 * not assume any default currency or 1-chip = 1-cent rate.
 *
 * An ASSET-backed table/tournament references a persisted EconomicPolicy. Every
 * asset movement is an AtomicLedger journal and is persisted as a
 * `ChipAssetConversion` (or `ChipAssetSettlement` for a whole hand). Funding a
 * PLAY_CHIPS account happens only through an explicit operator/fixture grant;
 * ASSET-backed principals need no chip grant because their reserve chips are
 * minted from the exact atomic conversion.
 */

export interface ChipOperationOptions {
  /** Operation idempotency key; makes the underlying chip mutation replay-safe. */
  idempotencyKey?: string;
  /** Audit reference (defaults to the table/tournament id). */
  referenceId?: string;
}

export interface HandSettlementInput {
  tableId: string;
  handId: string;
  playerNetChanges: Record<string, string>;
  rakeTotal: string | number | bigint;
  houseUserId: string;
}

/** Canonical string view of chip balances (never mixed with asset amounts). */
export interface ChipBalanceView {
  available: string;
  inPlay: string;
  tournament: string;
  totalInPlay: string;
  pendingWithdrawal: string;
}

/** Canonical chip journal history entry (integer chips as decimal strings). */
export interface ChipHistoryEntryView {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  referenceId: string | null;
  createdAt: string;
}

function toChipBigInt(value: number | string | bigint, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new ValidationError(`Invalid ${label}`);
  }
  if (parsed < 0n) throw new ValidationError(`${label} must not be negative`);
  return parsed;
}

/**
 * A settlement transaction is safe to re-run wholesale: `applySettleHand` is
 * idempotent on the hand id and the chip account CAS never double-applies. Only
 * transient concurrency conflicts (serialization failure, SQLite busy) are
 * retried; a business/validation error fails immediately.
 */
function isRetryableSettlementError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  if (code === "P2034" || code === "CHIP_CONCURRENT_MODIFICATION") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("database is locked") || message.includes("timed out");
}

function tableReserveRef(principalId: string, tableId: string): ChipAccountRef {
  return { principalId, kind: "TABLE_RESERVE", scopeId: tableId };
}

function tournamentPoolRef(tournamentId: string): ChipAccountRef {
  return {
    principalId: `tournament:${tournamentId}`,
    kind: "TOURNAMENT_RESERVE",
    scopeId: tournamentId,
  };
}

function operatorRef(operatorId: string): ChipAccountRef {
  return { principalId: operatorId, kind: "OPERATOR" };
}

export class FinancialManager {
  private readonly chips: ChipLedger;
  private readonly economics: EconomicPolicyService;

  constructor(private readonly prisma: PrismaClient) {
    this.chips = new ChipLedger(prisma);
    this.economics = new EconomicPolicyService(prisma);
  }

  // ==========================================================================
  // Account bootstrap & balances
  // ==========================================================================

  /** Ensure a principal has a materialized available chip account. */
  async ensureAccounts(userId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.chips.ensureAvailableAccount(tx, userId));
  }

  /** Exact bigint chip balances. */
  async getChipBalances(userId: string): Promise<ChipBalances> {
    return this.chips.getBalances(this.prisma, userId);
  }

  /**
   * Canonical decimal-string chip balance view. Deliberately separate from asset
   * atomic balances; the two are never converted implicitly.
   */
  async getChipBalancesView(userId: string): Promise<ChipBalanceView> {
    const balances = await this.chips.getBalances(this.prisma, userId);
    return {
      available: balances.available.toString(),
      inPlay: balances.inPlay.toString(),
      tournament: balances.tournament.toString(),
      totalInPlay: (balances.inPlay + balances.tournament).toString(),
      pendingWithdrawal: balances.pendingWithdrawal.toString(),
    };
  }

  /**
   * Canonical chip journal history projection. Amounts are integer chips as
   * decimal strings — never cents and never asset atomic amounts.
   */
  async getChipHistoryView(userId: string, take = 20): Promise<ChipHistoryEntryView[]> {
    const entries = await this.chips.listEntries(this.prisma, userId, take);
    return entries.map((entry) => ({
      id: entry.id,
      amount: entry.amount.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      type: entry.type,
      referenceId: entry.referenceId,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  /**
   * Operator/fixture chip grant. This is the ONLY way a PLAY_CHIPS account is
   * funded; there is no implicit wallet or finance-withdrawal path.
   */
  async grantChips(
    principalId: string,
    amount: number | string | bigint,
    options: { reason: string; operatorId: string; idempotencyKey: string }
  ) {
    const chips = toChipBigInt(amount, "grant amount");
    if (chips <= 0n) throw new ValidationError("grant amount must be positive");
    return this.prisma.$transaction((tx) =>
      this.chips.grant(tx, {
        principalId,
        amount: chips,
        reason: options.reason,
        operatorId: options.operatorId,
        idempotencyKey: options.idempotencyKey,
      })
    );
  }

  // ==========================================================================
  // Tables — buy-in / add chips / stand
  // ==========================================================================

  /** Buy into a table. Reserves chips, or converts exact atomic when backed. */
  async buyIn(
    userId: string,
    tableId: string,
    amount: number | string | bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const chips = toChipBigInt(amount, "buy-in amount");
    if (chips <= 0n) throw new ValidationError("buy-in amount must be positive");
    await this.prisma.$transaction((tx) => this.applyBuyIn(tx, userId, tableId, chips, options));
  }

  async applyBuyIn(
    tx: Prisma.TransactionClient,
    userId: string,
    tableId: string,
    chips: bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const policy = await this.economics.resolveTablePolicy(tx, tableId);
    if (!policy) {
      await this.chips.transfer(
        tx,
        { principalId: userId, kind: "AVAILABLE" },
        tableReserveRef(userId, tableId),
        chips,
        {
          type: "BUY_IN",
          referenceId: options.referenceId ?? tableId,
          idempotencyKey: options.idempotencyKey ?? null,
        }
      );
      return;
    }

    const key = options.idempotencyKey ?? `buyin:table:${tableId}:${userId}`;
    await this.economics.convertChipsToAtomic(tx, {
      policy,
      principalId: userId,
      scopeType: "TABLE",
      scopeId: tableId,
      chips,
      idempotencyKey: key,
    });
    // Represent the converted value as chips escrowed for this principal.
    await this.chips.applyDelta(tx, tableReserveRef(userId, tableId), chips, {
      type: "BUY_IN",
      referenceId: options.referenceId ?? tableId,
      idempotencyKey: `${key}:mint`,
    });
  }

  /** Cash out chips from a table reserve back to available (or atomic). */
  async cashOut(
    userId: string,
    tableId: string,
    amount: number | string | bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const chips = toChipBigInt(amount, "cash-out amount");
    if (chips === 0n) return;
    await this.prisma.$transaction((tx) => this.applyCashOut(tx, userId, tableId, chips, options));
  }

  async applyCashOut(
    tx: Prisma.TransactionClient,
    userId: string,
    tableId: string,
    chips: bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const policy = await this.economics.resolveTablePolicy(tx, tableId);
    if (!policy) {
      await this.chips.transfer(
        tx,
        tableReserveRef(userId, tableId),
        { principalId: userId, kind: "AVAILABLE" },
        chips,
        {
          type: "CASH_OUT",
          referenceId: options.referenceId ?? tableId,
          idempotencyKey: options.idempotencyKey ?? null,
        }
      );
      return;
    }

    await this.chips.applyDelta(tx, tableReserveRef(userId, tableId), -chips, {
      type: "CASH_OUT",
      referenceId: options.referenceId ?? tableId,
      idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:reserve` : null,
    });
    await this.economics.convertAtomicToChips(tx, {
      policy,
      principalId: userId,
      scopeType: "TABLE",
      scopeId: tableId,
      chips,
      idempotencyKey: options.idempotencyKey ?? `cashout:${tableId}:${userId}:${chips}`,
    });
  }

  /** Current table reserve (in-play) chips for a principal. */
  async getTableReserve(userId: string, tableId: string): Promise<bigint> {
    const account = await this.chips.getAccount(this.prisma, tableReserveRef(userId, tableId));
    return account?.balance ?? 0n;
  }

  /**
   * Force a principal's table reserve to match the authoritative engine stack.
   * The delta is journaled as a hand win/loss against the hand/table reference.
   * Safe to call inside a caller-owned transaction.
   */
  async applyTableReserveSync(
    tx: Prisma.TransactionClient,
    userId: string,
    tableId: string,
    targetStack: bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    if (targetStack < 0n) throw new ValidationError("target stack must not be negative");
    const account = await this.chips.getAccount(tx, tableReserveRef(userId, tableId));
    const current = account?.balance ?? 0n;
    const delta = targetStack - current;
    if (delta === 0n) return;
    await this.chips.applyDelta(tx, tableReserveRef(userId, tableId), delta, {
      type: delta > 0n ? "HAND_WIN" : "HAND_LOSS",
      referenceId: options.referenceId ?? tableId,
      idempotencyKey: options.idempotencyKey ?? null,
      metadata: { reason: "stand_engine_stack_sync", targetStack: targetStack.toString() },
    });
  }

  /** Move any residual table reserve back to available. */
  async applyResidualReserveRelease(
    tx: Prisma.TransactionClient,
    userId: string,
    tableId: string,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const reserve = await this.getTableReserveInTransaction(tx, userId, tableId);
    if (reserve <= 0n) return;
    await this.applyCashOut(tx, userId, tableId, reserve, {
      ...options,
      idempotencyKey: options.idempotencyKey ?? `residual:${tableId}:${userId}`,
    });
  }

  private async getTableReserveInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    tableId: string
  ): Promise<bigint> {
    const account = await this.chips.getAccount(tx, tableReserveRef(userId, tableId));
    return account?.balance ?? 0n;
  }

  // ==========================================================================
  // Hand settlement
  // ==========================================================================

  /** Settle a hand against table reserves. Idempotent on the hand id. */
  async settleHand(input: HandSettlementInput): Promise<{ replayed: boolean }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.applySettleHand(tx, input));
      } catch (error) {
        lastError = error;
        if (!isRetryableSettlementError(error) || attempt === 8) throw error;
        // Whole-transaction retry: applySettleHand is idempotent on handId.
        await new Promise((resolve) => setTimeout(resolve, 5 * attempt));
      }
    }
    throw lastError;
  }

  /**
   * Apply every durably-recorded settle-hand intent for a table, in creation
   * order, inside the caller's transaction. This is the "flush before cashout"
   * boundary: a hand's outbox row can be committed but not yet dispatched to the
   * settlement worker, so cashing out first would credit the engine stack while
   * leaving the durable settlement to pay the same hand again.
   *
   * Ordering is oldest-first. Idempotency is provided by `applySettleHand`'s
   * handId marker (chip journal reference + `ChipAssetSettlement`), so a row the
   * worker already processed is a no-op and a later worker run is a no-op too.
   */
  async flushPendingTableSettlements(
    tx: Prisma.TransactionClient,
    tableId: string,
    houseUserId: string
  ): Promise<{ applied: number; replayed: number }> {
    const rows = await tx.gameOutbox.findMany({
      where: { tableId, kind: "settle-hand" },
      orderBy: { createdAt: "asc" },
      select: { payload: true },
    });

    let applied = 0;
    let replayed = 0;
    for (const row of rows) {
      const payload = row.payload as {
        tableId?: string;
        handId?: string;
        playerNetChanges?: Record<string, string>;
        rakeTotal?: string | number;
      } | null;
      if (!payload || typeof payload.handId !== "string" || !payload.playerNetChanges) {
        continue;
      }
      const result = await this.applySettleHand(tx, {
        tableId: payload.tableId ?? tableId,
        handId: payload.handId,
        playerNetChanges: payload.playerNetChanges,
        rakeTotal: payload.rakeTotal ?? 0,
        houseUserId,
      });
      if (result.replayed) replayed += 1;
      else applied += 1;
    }
    return { applied, replayed };
  }

  async applySettleHand(
    tx: Prisma.TransactionClient,
    input: HandSettlementInput
  ): Promise<{ replayed: boolean }> {
    const rake = toChipBigInt(input.rakeTotal, "rake");
    const entries = Object.entries(input.playerNetChanges);
    let netTotal = 0n;
    for (const [, change] of entries) netTotal += BigInt(change);
    if (netTotal + rake !== 0n) {
      throw new ValidationError(`Unbalanced chip settlement for hand ${input.handId}`);
    }

    const existing = await tx.chipLedgerEntry.findFirst({
      where: {
        referenceId: input.handId,
        type: { in: ["HAND_WIN", "HAND_LOSS", "RAKE"] },
      },
      select: { id: true },
    });
    if (existing) return { replayed: true };

    // ASSET-backed settlement: move atomic liability between per-principal
    // in-play reserves and credit rake to the operator, in the same tx.
    const policy = await this.economics.resolveTablePolicy(tx, input.tableId);
    if (policy && entries.length > 0) {
      await this.economics.settleHandAtomic(tx, {
        policy,
        scopeType: "TABLE",
        scopeId: input.tableId,
        referenceId: input.handId,
        deltas: entries.map(([principalId, change]) => ({
          principalId,
          chips: BigInt(change),
        })),
        rake,
        operatorId: input.houseUserId,
      });
    }

    const reference = input.handId;
    for (const [principalId, changeStr] of entries) {
      const change = BigInt(changeStr);
      if (change === 0n) continue;
      await this.chips.applyDelta(tx, tableReserveRef(principalId, input.tableId), change, {
        type: change > 0n ? "HAND_WIN" : "HAND_LOSS",
        referenceId: reference,
        idempotencyKey: `settle:${input.handId}:${principalId}`,
        metadata: { tableId: input.tableId },
      });
    }

    if (rake > 0n) {
      await this.chips.applyDelta(tx, operatorRef(input.houseUserId), rake, {
        type: "RAKE",
        referenceId: reference,
        idempotencyKey: `settle:${input.handId}:rake`,
        metadata: { tableId: input.tableId },
      });
    }
    return { replayed: false };
  }

  // ==========================================================================
  // Tournaments
  // ==========================================================================

  /** Register a tournament entry: escrow buy-in and route fee to the operator. */
  async registerTournament(
    userId: string,
    tournamentId: string,
    amounts: { buyIn: number | string | bigint; fee: number | string | bigint },
    options: ChipOperationOptions & { operatorId?: string | null } = {}
  ): Promise<{ operatorId: string | null }> {
    const buyIn = toChipBigInt(amounts.buyIn, "buy-in");
    const fee = toChipBigInt(amounts.fee, "fee");
    return this.prisma.$transaction((tx) =>
      this.applyTournamentRegistration(tx, userId, tournamentId, buyIn, fee, options)
    );
  }

  async applyTournamentRegistration(
    tx: Prisma.TransactionClient,
    userId: string,
    tournamentId: string,
    buyIn: bigint,
    fee: bigint,
    options: ChipOperationOptions & { operatorId?: string | null } = {}
  ): Promise<{ operatorId: string | null }> {
    const policy = await this.economics.resolveTournamentPolicy(tx, tournamentId);
    const referenceId = options.referenceId ?? tournamentId;
    const key = options.idempotencyKey ?? null;
    const operatorId = options.operatorId ?? null;

    if (!policy) {
      if (buyIn > 0n) {
        await this.chips.transfer(
          tx,
          { principalId: userId, kind: "AVAILABLE" },
          tournamentPoolRef(tournamentId),
          buyIn,
          { type: "TOURNAMENT_BUY_IN", referenceId, idempotencyKey: key ? `${key}:buyin` : null }
        );
      }
      if (fee > 0n) {
        if (operatorId) {
          await this.chips.transfer(
            tx,
            { principalId: userId, kind: "AVAILABLE" },
            operatorRef(operatorId),
            fee,
            { type: "TOURNAMENT_FEE", referenceId, idempotencyKey: key ? `${key}:fee` : null }
          );
        } else {
          await this.chips.applyDelta(tx, { principalId: userId, kind: "AVAILABLE" }, -fee, {
            type: "TOURNAMENT_FEE",
            referenceId,
            idempotencyKey: key ? `${key}:fee` : null,
          });
        }
      }
      return { operatorId };
    }

    // ASSET-backed: buy-in converts USER_AVAILABLE -> pooled TOURNAMENT_RESERVE
    // and is represented as chips in the tournament pool. The fee converts
    // USER_AVAILABLE -> OPERATOR atomically, so an ASSET principal needs no chip
    // grant at all.
    if (buyIn > 0n) {
      await this.economics.convertChipsToAtomic(tx, {
        policy,
        principalId: userId,
        scopeType: "TOURNAMENT",
        scopeId: tournamentId,
        chips: buyIn,
        idempotencyKey: key ?? `register:${tournamentId}:${userId}`,
      });
      await this.chips.applyDelta(tx, tournamentPoolRef(tournamentId), buyIn, {
        type: "TOURNAMENT_BUY_IN",
        referenceId,
        idempotencyKey: key ? `${key}:buyin` : null,
      });
    }
    if (fee > 0n) {
      if (!operatorId) {
        throw new ValidationError(
          "ASSET-backed tournament fee requires an operator principal to receive it"
        );
      }
      await this.economics.convertFeeToOperator(tx, {
        policy,
        principalId: userId,
        operatorId,
        scopeType: "TOURNAMENT",
        scopeId: tournamentId,
        chips: fee,
        idempotencyKey: key ? `${key}:fee` : `register-fee:${tournamentId}:${userId}`,
      });
    }
    return { operatorId };
  }

  /**
   * Pay a tournament prize: pool -> winner available (chips and, if backed,
   * atomic TOURNAMENT_RESERVE -> user available). Prizes are computed to sum
   * exactly to the prize pool, so the pool is fully distributed and never
   * silently stranded.
   */
  async payoutTournament(
    tx: Prisma.TransactionClient,
    userId: string,
    tournamentId: string,
    amount: number | string | bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const chips = toChipBigInt(amount, "payout");
    if (chips <= 0n) return;
    const referenceId = options.referenceId ?? tournamentId;
    const key = options.idempotencyKey ?? null;

    await this.chips.transfer(
      tx,
      tournamentPoolRef(tournamentId),
      { principalId: userId, kind: "AVAILABLE" },
      chips,
      { type: "TOURNAMENT_PAYOUT", referenceId, idempotencyKey: key ? `${key}:payout` : null }
    );

    const policy = await this.economics.resolveTournamentPolicy(tx, tournamentId);
    if (policy) {
      await this.economics.convertAtomicToChips(tx, {
        policy,
        principalId: userId,
        scopeType: "TOURNAMENT",
        scopeId: tournamentId,
        chips,
        idempotencyKey: key ?? `payout:${tournamentId}:${userId}:${chips}`,
        direction: "TOURNAMENT_PAYOUT",
      });
    }
  }

  /** Refund an escrowed tournament buy-in back to the principal. Fee is kept. */
  async refundTournament(
    tx: Prisma.TransactionClient,
    userId: string,
    tournamentId: string,
    amount: number | string | bigint,
    options: ChipOperationOptions = {}
  ): Promise<void> {
    const chips = toChipBigInt(amount, "refund");
    if (chips <= 0n) return;
    const key = options.idempotencyKey ?? null;

    await this.chips.transfer(
      tx,
      tournamentPoolRef(tournamentId),
      { principalId: userId, kind: "AVAILABLE" },
      chips,
      {
        type: "TOURNAMENT_REFUND",
        referenceId: options.referenceId ?? tournamentId,
        idempotencyKey: key ? `${key}:refund` : null,
      }
    );

    const policy = await this.economics.resolveTournamentPolicy(tx, tournamentId);
    if (policy) {
      await this.economics.convertAtomicToChips(tx, {
        policy,
        principalId: userId,
        scopeType: "TOURNAMENT",
        scopeId: tournamentId,
        chips,
        idempotencyKey: key ? `${key}:refund-atomic` : `refund:${tournamentId}:${userId}:${chips}`,
      });
    }
  }

  async getTournamentPool(tournamentId: string): Promise<bigint> {
    const account = await this.chips.getAccount(this.prisma, tournamentPoolRef(tournamentId));
    return account?.balance ?? 0n;
  }
}
