import type { PrismaClient } from "../../generated/prisma/index.js";
import { config } from "../config.js";
import { InsufficientFundsError } from "../utils/errors.js";

/**
 * Financial Manager - Double-Entry Ledger System
 *
 * Monetary values are persisted as BigInt cents/chips. Public API boundaries
 * convert to Number only after database arithmetic is complete.
 */
export class FinancialManager {
  constructor(private prisma: PrismaClient) {}

  /**
   * Buy-in to a table (atomic transaction)
   * Transfers funds from MAIN account to IN_PLAY account
   */
  async buyIn(userId: string, tableId: string, amount: number): Promise<void> {
    const amountCents = BigInt(amount);
    await this.prisma.$transaction(
      async (
        tx: Omit<
          PrismaClient,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        const mainAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "MAIN",
            },
          },
        });

        if (!mainAccount) {
          throw new Error("MAIN account not found");
        }

        const mainBalance = mainAccount.balance;
        if (mainBalance < amountCents) {
          throw new InsufficientFundsError(
            `Insufficient balance. Has: ${mainBalance}, Needs: ${amount}`
          );
        }

        // Get or create IN_PLAY account
        const inPlayAccount = await tx.account.upsert({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "IN_PLAY",
            },
          },
          create: {
            userId,
            currency: config.DEFAULT_CURRENCY,
            type: "IN_PLAY",
            balance: 0n,
          },
          update: {},
        });

        // Create ledger entries (double-entry)
        await tx.ledgerEntry.createMany({
          data: [
            {
              accountId: mainAccount.id,
              amount: -amountCents,
              type: "BUY_IN",
              referenceId: tableId,
            },
            {
              accountId: inPlayAccount.id,
              amount: amountCents,
              type: "BUY_IN",
              referenceId: tableId,
            },
          ],
        });

        // Update cached balances
        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { decrement: amountCents } },
        });

        await tx.account.update({
          where: { id: inPlayAccount.id },
          data: { balance: { increment: amountCents } },
        });
      }
    );
  }

  /**
   * Cash out from a table
   * Transfers funds from IN_PLAY account back to MAIN account
   */
  async cashOut(userId: string, tableId: string, amount: number): Promise<void> {
    const amountCents = BigInt(amount);
    await this.prisma.$transaction(
      async (
        tx: Omit<
          PrismaClient,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        const inPlayAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "IN_PLAY",
            },
          },
        });

        if (!inPlayAccount) {
          throw new Error("IN_PLAY account not found");
        }

        const inPlayBalance = inPlayAccount.balance;
        if (inPlayBalance < amountCents) {
          throw new InsufficientFundsError(
            `Insufficient in-play balance. Has: ${inPlayBalance}, Needs: ${amount}`
          );
        }

        const mainAccount = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "MAIN",
            },
          },
        });

        await tx.ledgerEntry.createMany({
          data: [
            {
              accountId: inPlayAccount.id,
              amount: -amountCents,
              type: "CASH_OUT",
              referenceId: tableId,
            },
            {
              accountId: mainAccount.id,
              amount: amountCents,
              type: "CASH_OUT",
              referenceId: tableId,
            },
          ],
        });

        // Update balances
        await tx.account.update({
          where: { id: inPlayAccount.id },
          data: { balance: { decrement: amountCents } },
        });

        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { increment: amountCents } },
        });
      }
    );
  }

  /**
   * Get user balances
   */
  async getBalances(
    userId: string
  ): Promise<{ main: number; inPlay: number; pendingWithdrawal: number }> {
    const accounts = await this.prisma.account.findMany({
      where: { userId, currency: config.DEFAULT_CURRENCY },
    });

    const mainAccount = accounts.find((a) => a.type === "MAIN");
    const inPlayAccount = accounts.find((a) => a.type === "IN_PLAY");
    const pendingWithdrawalAccount = accounts.find((a) => a.type === "PENDING_WITHDRAWAL");

    return {
      main: mainAccount ? Number(mainAccount.balance) : 0,
      inPlay: inPlayAccount ? Number(inPlayAccount.balance) : 0,
      pendingWithdrawal: pendingWithdrawalAccount ? Number(pendingWithdrawalAccount.balance) : 0,
    };
  }

  /**
   * Ensure user has accounts (called on first login)
   */
  async ensureAccounts(userId: string): Promise<void> {
    await this.prisma.$transaction(
      async (
        tx: Omit<
          PrismaClient,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        // Create MAIN account if it doesn't exist
        await tx.account.upsert({
          where: {
            userId_currency_type: {
              userId,
              currency: config.DEFAULT_CURRENCY,
              type: "MAIN",
            },
          },
          create: {
            userId,
            currency: config.DEFAULT_CURRENCY,
            type: "MAIN",
            balance: 0n,
          },
          update: {},
        });
      }
    );
  }
}
