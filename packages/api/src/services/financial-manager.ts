import type { PrismaClient } from "../../generated/prisma/index.js";
import { InsufficientFundsError } from "../utils/errors.js";

/**
 * Financial Manager - Double-Entry Ledger System
 *
 * All monetary operations use standard Number (integer cents).
 * 1 chip = 1 cent. Safe for up to $21 million with Int.
 */
export class FinancialManager {
  constructor(private prisma: PrismaClient) {}

  /**
   * Buy-in to a table (atomic transaction)
   * Transfers funds from MAIN account to IN_PLAY account
   */
  async buyIn(userId: string, tableId: string, amount: number): Promise<void> {
    await this.prisma.$transaction(
      async (
        tx: Omit<
          PrismaClient,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
        >
      ) => {
        // 1. Get MAIN account
        const mainAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId,
              currency: "USDC",
              type: "MAIN",
            },
          },
        });

        if (!mainAccount) {
          throw new Error("MAIN account not found");
        }

        const mainBalance = mainAccount.balance;
        if (mainBalance < amount) {
          throw new InsufficientFundsError(
            `Insufficient balance. Has: ${mainBalance}, Needs: ${amount}`
          );
        }

        // 2. Get or create IN_PLAY account
        const inPlayAccount = await tx.account.upsert({
          where: {
            userId_currency_type: {
              userId,
              currency: "USDC",
              type: "IN_PLAY",
            },
          },
          create: {
            userId,
            currency: "USDC",
            type: "IN_PLAY",
            balance: 0,
          },
          update: {},
        });

        // 3. Create ledger entries (double-entry)
        await tx.ledgerEntry.createMany({
          data: [
            {
              accountId: mainAccount.id,
              amount: -amount,
              type: "BUY_IN",
              referenceId: tableId,
            },
            {
              accountId: inPlayAccount.id,
              amount: amount,
              type: "BUY_IN",
              referenceId: tableId,
            },
          ],
        });

        // 4. Update cached balances (using Prisma atomic operations)
        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { decrement: amount } },
        });

        await tx.account.update({
          where: { id: inPlayAccount.id },
          data: { balance: { increment: amount } },
        });
      }
    );
  }

  /**
   * Cash out from a table
   * Transfers funds from IN_PLAY account back to MAIN account
   */
  async cashOut(userId: string, tableId: string, amount: number): Promise<void> {
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
              currency: "USDC",
              type: "IN_PLAY",
            },
          },
        });

        if (!inPlayAccount) {
          throw new Error("IN_PLAY account not found");
        }

        const inPlayBalance = inPlayAccount.balance;
        if (inPlayBalance < amount) {
          throw new InsufficientFundsError(
            `Insufficient in-play balance. Has: ${inPlayBalance}, Needs: ${amount}`
          );
        }

        const mainAccount = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: {
              userId,
              currency: "USDC",
              type: "MAIN",
            },
          },
        });

        // Ledger entries
        await tx.ledgerEntry.createMany({
          data: [
            {
              accountId: inPlayAccount.id,
              amount: -amount,
              type: "CASH_OUT",
              referenceId: tableId,
            },
            {
              accountId: mainAccount.id,
              amount: amount,
              type: "CASH_OUT",
              referenceId: tableId,
            },
          ],
        });

        // Update balances (using Prisma atomic operations)
        await tx.account.update({
          where: { id: inPlayAccount.id },
          data: { balance: { decrement: amount } },
        });

        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { increment: amount } },
        });
      }
    );
  }

  /**
   * Get user balances
   */
  async getBalances(userId: string): Promise<{ main: number; inPlay: number }> {
    const accounts = await this.prisma.account.findMany({
      where: { userId, currency: "USDC" },
    });

    const mainAccount = accounts.find((a) => a.type === "MAIN");
    const inPlayAccount = accounts.find((a) => a.type === "IN_PLAY");

    return {
      main: mainAccount ? mainAccount.balance : 0,
      inPlay: inPlayAccount ? inPlayAccount.balance : 0,
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
              currency: "USDC",
              type: "MAIN",
            },
          },
          create: {
            userId,
            currency: "USDC",
            type: "MAIN",
            balance: 0,
          },
          update: {},
        });
      }
    );
  }
}
