import { Worker, type Job } from "bullmq";
import { PrismaClient } from "../../generated/prisma/index.js";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { BlockchainManager } from "../services/blockchain-manager.js";
import { parseAbi } from "viem";
import type { FastifyInstance } from "fastify";
import { createPrismaClient } from "../utils/prisma-client.js";
import { getHouseUserId } from "../utils/house-user.js";

// ABI for ERC20 Transfer event and BalanceOf
const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/**
 * Create Deposit Monitor Worker
 *
 * Strategy:
 * 1. Runs periodically (e.g., every 15-30 seconds).
 * 2. Fetches all ACTIVE deposit sessions.
 * 3. Groups them by user address.
 * 4. For each supported chain/token, checks the on-chain balance/logs.
 * 5. Detects new deposits and stores them as PENDING.
 * 6. Checks PENDING deposits for confirmations and upgrades to CONFIRMED when ready.
 *
 * Production hardening:
 * - Block hash canonicality checks (reorg protection)
 * - Status-guarded idempotent confirmation updates in a single transaction
 * - BigInt arithmetic for all financial conversions (no floating point)
 * - Tracks lastScannedBlock to prevent gaps in monitoring
 * - Validates block confirmations before crediting chips
 * - Uses structured logging instead of console.log
 */
export function createDepositMonitorWorker(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis: Redis
): Worker {
  const blockchainManager = new BlockchainManager(prisma);
  const logger = app.log.child({ worker: "deposit-monitor" });

  const worker = new Worker(
    "deposit-monitor",
    async (job: Job) => {
      logger.info("Scanning active deposit sessions...");

      // Get active sessions
      const now = new Date();
      const sessions = await prisma.depositSession.findMany({
        where: { expiresAt: { gt: now } },
        include: { userWallet: true },
      });

      if (sessions.length === 0) {
        logger.info("No active deposit sessions to scan");
        return;
      }

      // Deduplicate by wallet address
      const uniqueWallets = new Map<string, (typeof sessions)[0]>();
      for (const session of sessions) {
        if (!uniqueWallets.has(session.userWallet.address)) {
          uniqueWallets.set(session.userWallet.address, session);
        }
      }

      logger.info({ walletCount: uniqueWallets.size }, "Scanning unique wallet addresses");

      // Get enabled blockchains and tokens
      const blockchains = await prisma.blockchain.findMany({
        where: { isEnabled: true },
        include: { tokens: { where: { isEnabled: true } } },
      });

      // Build a Set of active wallet addresses for O(1) lookup
      const walletToUserMap = new Map(
        Array.from(uniqueWallets.entries()).map(([addr, session]) => [
          addr.toLowerCase(),
          session.userId,
        ])
      );

      logger.info({ activeWalletCount: walletToUserMap.size }, "Built active wallet lookup map");

      // Scan by BLOCK (not by user) - O(Chains × Tokens) RPC calls
      for (const chain of blockchains) {
        try {
          const client = await blockchainManager.getClient(chain.id);
          const currentBlock = await client.getBlockNumber();

          // Determine scan range using lastScannedBlock
          const lastScanned = chain.lastScannedBlock
            ? BigInt(chain.lastScannedBlock)
            : currentBlock - BigInt(config.INITIAL_SCAN_LOOKBACK_BLOCKS);

          const fromBlock = lastScanned + 1n;
          const toBlock = currentBlock;

          // Skip if no new blocks
          if (fromBlock > toBlock) {
            continue;
          }

          logger.info(
            {
              chain: chain.name,
              fromBlock: fromBlock.toString(),
              toBlock: toBlock.toString(),
            },
            "Scanning block range for all transfers"
          );

          // Scan each token on this chain
          let allTokensSucceeded = true;
          for (const token of chain.tokens) {
            try {
              // Get ALL Transfer events for this token in block range
              const logs = await client.getContractEvents({
                address: token.address as `0x${string}`,
                abi: ERC20_ABI,
                eventName: "Transfer",
                fromBlock,
                toBlock,
              });

              logger.info(
                {
                  chain: chain.name,
                  token: token.symbol,
                  logsFound: logs.length,
                },
                "Retrieved transfer logs"
              );

              // Filter in memory - check if 'to' is in our active wallet set
              for (const log of logs) {
                const fromAddress = log.args.from?.toLowerCase();
                const toAddress = log.args.to?.toLowerCase();

                if (!toAddress || !walletToUserMap.has(toAddress)) {
                  continue; // Not one of our users
                }

                // Reject zero-address mint transfers (from === 0x0)
                // These are token mints, not real user deposits
                if (fromAddress === "0x0000000000000000000000000000000000000000" || !fromAddress) {
                  logger.info(
                    { txHash: log.transactionHash, token: token.symbol },
                    "Skipping zero-address mint transfer"
                  );
                  continue;
                }

                const txHash = log.transactionHash;
                const amount = log.args.value!;
                const txBlockNumber = log.blockNumber!;
                const userId = walletToUserMap.get(toAddress)!;

                // Check if already processed
                const existingDeposit = await prisma.paymentTransaction.findUnique({
                  where: { blockchainId_txHash: { blockchainId: chain.id, txHash } },
                });

                if (existingDeposit) continue;

                // --- Block hash canonicality check ---
                // Fetch the block to get its hash for later reorg detection
                let blockHash: string | null = null;
                try {
                  const block = await client.getBlock({
                    blockNumber: txBlockNumber,
                    includeTransactions: false,
                  });
                  blockHash = block.hash;
                } catch (blockErr) {
                  logger.warn(
                    { txHash, blockNumber: txBlockNumber.toString(), error: blockErr },
                    "Could not fetch block hash for canonicality check, storing deposit without"
                  );
                }

                // Convert token amount to Chips (cents) using BigInt arithmetic ONLY
                const amountBigInt = BigInt(amount);
                const decimalsBigInt = 10n ** BigInt(token.decimals);
                const chips = (amountBigInt * 100n) / decimalsBigInt;

                // Safety check
                if (chips > Number.MAX_SAFE_INTEGER) {
                  logger.error({ txHash, amount: amountBigInt.toString() }, "Deposit too large");
                  continue;
                }

                if (chips <= 0) continue;

                const minDepositBigInt = BigInt(token.minDeposit);
                if (amountBigInt < minDepositBigInt) {
                  logger.info(
                    {
                      txHash,
                      amount: amountBigInt.toString(),
                      minDeposit: token.minDeposit,
                      token: token.symbol,
                    },
                    "Deposit below minimum, skipping"
                  );
                  continue;
                }

                const confirmations = Number(currentBlock - txBlockNumber);
                const requiredConfirmations = chain.confirmations;

                const status = confirmations >= requiredConfirmations ? "CONFIRMED" : "PENDING";

                await prisma.$transaction(async (tx) => {
                  // Credit Ledger ONLY if CONFIRMED
                  if (status === "CONFIRMED") {
                    const mainAccount = await tx.account.findUniqueOrThrow({
                      where: {
                        userId_currency_type: {
                          userId,
                          currency: config.DEFAULT_CURRENCY,
                          type: "MAIN",
                        },
                      },
                    });

                    const ledgerEntry = await tx.ledgerEntry.create({
                      data: {
                        accountId: mainAccount.id,
                        amount: chips,
                        type: "DEPOSIT",
                        referenceId: txHash,
                        metadata: {
                          chain: chain.name,
                          token: token.symbol,
                          blockHash,
                          blockNumber: txBlockNumber.toString(),
                        },
                      },
                    });

                    await tx.account.update({
                      where: { id: mainAccount.id },
                      data: { balance: { increment: chips } },
                    });

                    // Double-entry: debit HOUSE_RESERVE for the on-chain funds leaving the hot wallet
                    const houseUserId = await getHouseUserId(prisma);
                    const houseReserveAccount = await tx.account.findUnique({
                      where: {
                        userId_currency_type: {
                          userId: houseUserId,
                          currency: config.DEFAULT_CURRENCY,
                          type: "HOUSE_RESERVE",
                        },
                      },
                    });
                    if (houseReserveAccount) {
                      await tx.ledgerEntry.create({
                        data: {
                          accountId: houseReserveAccount.id,
                          amount: -chips,
                          type: "DEPOSIT",
                          referenceId: txHash,
                          metadata: {
                            chain: chain.name,
                            token: token.symbol,
                            blockHash,
                            blockNumber: txBlockNumber.toString(),
                          },
                        },
                      });
                      await tx.account.update({
                        where: { id: houseReserveAccount.id },
                        data: { balance: { decrement: chips } },
                      });
                    }

                    // Record PaymentTransaction with link to ledger entry and blockHash
                    await tx.paymentTransaction.create({
                      data: {
                        userId,
                        type: "DEPOSIT",
                        blockchainId: chain.id,
                        tokenId: token.id,
                        txHash,
                        address: toAddress,
                        blockNumber: txBlockNumber.toString(),
                        blockHash,
                        amountRaw: amount.toString(),
                        amountCredit: chips,
                        status,
                        ledgerEntryId: ledgerEntry.id,
                        confirmedAt: new Date(),
                      },
                    });

                    logger.info(
                      {
                        event: "deposit_confirmed",
                        userId,
                        txHash,
                        amount: chips.toString(),
                        confirmations,
                        blockHash,
                      },
                      "Deposit confirmed and credited"
                    );
                  } else {
                    // Record PaymentTransaction without ledger link (pending), with blockHash
                    await tx.paymentTransaction.create({
                      data: {
                        userId,
                        type: "DEPOSIT",
                        blockchainId: chain.id,
                        tokenId: token.id,
                        txHash,
                        address: toAddress,
                        blockNumber: txBlockNumber.toString(),
                        blockHash,
                        amountRaw: amount.toString(),
                        amountCredit: chips,
                        status,
                      },
                    });

                    logger.info(
                      {
                        event: "deposit_pending",
                        userId,
                        txHash,
                        amount: chips,
                        confirmations,
                        requiredConfirmations,
                        blockHash,
                      },
                      "Deposit detected but pending confirmations"
                    );
                  }
                });
              }
            } catch (tokenErr) {
              allTokensSucceeded = false;
              logger.error(
                { error: tokenErr, token: token.symbol, chain: chain.name },
                "Error processing token"
              );
            }
          }

          if (allTokensSucceeded) {
            // Update lastScannedBlock only if all tokens on this chain succeeded
            await prisma.blockchain.update({
              where: { id: chain.id },
              data: { lastScannedBlock: toBlock.toString() },
            });

            logger.info(
              { chain: chain.name, lastScannedBlock: toBlock.toString() },
              "Updated lastScannedBlock"
            );
          } else {
            logger.warn(
              { chain: chain.name, toBlock: toBlock.toString() },
              "Skipping lastScannedBlock update due to partial token scan failure"
            );
          }
        } catch (chainErr) {
          logger.error({ error: chainErr, chain: chain.name }, "Error scanning chain");
        }
      }

      // Check PENDING deposits for confirmation upgrades (with blockHash canonicality)
      await checkPendingDeposits(prisma, blockchainManager, logger);
    },
    {
      connection: redis as any,
      concurrency: config.DEPOSIT_SCAN_CONCURRENCY,
      limiter: {
        max: config.DEPOSIT_SCAN_MAX_RPCS,
        duration: config.DEPOSIT_SCAN_LIMIT_DURATION_MS,
      },
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Deposit scan completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err }, "Deposit scan failed");
  });

  return worker;
}

/**
 * Check PENDING deposits and upgrade to CONFIRMED when they have enough confirmations.
 *
 * Production hardening:
 * - Idempotent confirmation: uses status-guarded updateMany in a transaction to
 *   prevent double-crediting even under concurrent worker execution.
 * - Block hash canonicality: before upgrading, verifies the stored blockHash
 *   still matches the canonical chain at that block number (reorg detection).
 *   If the block hash differs, the deposit is marked FAILED with recoveryState REORGED.
 */
async function checkPendingDeposits(
  prisma: PrismaClient,
  blockchainManager: BlockchainManager,
  logger: any
): Promise<void> {
  logger.info("Checking pending deposits for confirmations");

  const pendingDeposits = await prisma.paymentTransaction.findMany({
    where: { status: "PENDING", type: "DEPOSIT" },
    include: { blockchain: true, token: true },
  });

  for (const deposit of pendingDeposits) {
    try {
      const client = await blockchainManager.getClient(deposit.blockchainId);
      const currentBlock = await client.getBlockNumber();
      const depositBlock = BigInt(deposit.blockNumber!);
      const confirmations = Number(currentBlock - depositBlock);
      const requiredConfirmations = deposit.blockchain.confirmations;

      if (confirmations < requiredConfirmations) {
        continue; // Not enough confirmations yet
      }

      // --- Block hash canonicality check (reorg detection) ---
      // If we stored a blockHash at detection time, verify the canonical chain
      // still has the same hash at that block number.
      if (deposit.blockHash) {
        try {
          const canonicalBlock = await client.getBlock({
            blockNumber: depositBlock,
            includeTransactions: false,
          });

          if (canonicalBlock.hash.toLowerCase() !== deposit.blockHash.toLowerCase()) {
            logger.warn(
              {
                event: "deposit_reorg_detected",
                depositId: deposit.id,
                txHash: deposit.txHash,
                storedBlockHash: deposit.blockHash,
                canonicalBlockHash: canonicalBlock.hash,
                blockNumber: depositBlock.toString(),
              },
              "Reorg detected: stored blockHash differs from canonical chain. Marking deposit as FAILED."
            );

            // Mark deposit as FAILED with REORGED recovery state in a transaction
            await prisma.$transaction(async (tx) => {
              // Guard: only update if still PENDING
              const updated = await tx.paymentTransaction.updateMany({
                where: {
                  id: deposit.id,
                  status: "PENDING",
                },
                data: {
                  status: "FAILED",
                  recoveryState: "REORGED",
                  confirmedAt: new Date(),
                },
              });

              if (updated.count === 0) {
                logger.warn(
                  { depositId: deposit.id },
                  "Deposit was already updated by another worker, skipping reorg mark"
                );
              }
            });
            continue;
          }
        } catch (blockErr) {
          logger.warn(
            { depositId: deposit.id, blockNumber: depositBlock.toString(), error: blockErr },
            "Could not verify block hash for canonicality, proceeding with confirmation"
          );
          // Proceed with confirmation even if we can't verify block hash (don't block deposits)
        }
      }

      // --- Idempotent confirmation upgrade in a single status-guarded transaction ---
      // Only upgrade if status is still PENDING. updateMany ensures idempotency:
      // if another worker already upgraded it, count will be 0 and we skip crediting.
      const result = await prisma.$transaction(async (tx) => {
        // Guard: atomically check-and-update the payment transaction status
        const updated = await tx.paymentTransaction.updateMany({
          where: {
            id: deposit.id,
            status: "PENDING", // Critical: only update if still PENDING
          },
          data: {
            status: "CONFIRMED", // Set immediately to prevent race condition
            confirmedAt: new Date(),
          },
        });

        if (updated.count === 0) {
          // Already confirmed by another concurrent worker run
          logger.info(
            {
              event: "deposit_already_confirmed",
              depositId: deposit.id,
              txHash: deposit.txHash,
            },
            "Deposit already confirmed by another worker, skipping credit"
          );
          return { credited: false };
        }

        // Now safe to credit user - no other worker can process this deposit
        const mainAccount = await tx.account.findUniqueOrThrow({
          where: {
            userId_currency_type: {
              userId: deposit.userId,
              currency: config.DEFAULT_CURRENCY,
              type: "MAIN",
            },
          },
        });

        const ledgerEntry = await tx.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: deposit.amountCredit,
            type: "DEPOSIT",
            referenceId: deposit.txHash!,
            metadata: {
              chain: deposit.blockchain.name,
              token: deposit.token.symbol,
              blockHash: deposit.blockHash,
              blockNumber: deposit.blockNumber,
            },
          },
        });

        await tx.account.update({
          where: { id: mainAccount.id },
          data: { balance: { increment: deposit.amountCredit } },
        });

        // Double-entry: debit HOUSE_RESERVE for the on-chain funds leaving the hot wallet
        const houseUserId = await getHouseUserId(prisma);
        const houseReserveAccount = await tx.account.findUnique({
          where: {
            userId_currency_type: {
              userId: houseUserId,
              currency: config.DEFAULT_CURRENCY,
              type: "HOUSE_RESERVE",
            },
          },
        });
        if (houseReserveAccount) {
          await tx.ledgerEntry.create({
            data: {
              accountId: houseReserveAccount.id,
              amount: -deposit.amountCredit,
              type: "DEPOSIT",
              referenceId: deposit.txHash!,
              metadata: {
                chain: deposit.blockchain.name,
                token: deposit.token.symbol,
                blockHash: deposit.blockHash,
                blockNumber: deposit.blockNumber,
              },
            },
          });
          await tx.account.update({
            where: { id: houseReserveAccount.id },
            data: { balance: { decrement: deposit.amountCredit } },
          });
        }

        // Link ledger entry to payment transaction
        await tx.paymentTransaction.update({
          where: { id: deposit.id },
          data: {
            ledgerEntryId: ledgerEntry.id,
          },
        });

        return { credited: true, ledgerEntryId: ledgerEntry.id };
      });

      if (result.credited) {
        logger.info(
          {
            event: "deposit_upgraded",
            depositId: deposit.id,
            userId: deposit.userId,
            txHash: deposit.txHash,
            confirmations,
            ledgerEntryId: result.ledgerEntryId,
          },
          "Pending deposit upgraded to confirmed"
        );
      }
    } catch (err) {
      logger.error({ error: err, depositId: deposit.id }, "Error checking pending deposit");
    }
  }
}

// Standalone entry point for running the worker outside the Fastify process.
export default async function createStandaloneWorker(): Promise<Worker> {
  const prisma = createPrismaClient();
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // Create real Pino logger for standalone mode
  const { default: pino } = await import("pino");
  const logger = pino({
    level: config.LOG_LEVEL || "info",
    transport:
      config.NODE_ENV === "development"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss Z",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  });

  // Mock FastifyInstance with just the log property
  const mockApp = {
    log: logger.child({ worker: "deposit-monitor" }),
  } as unknown as FastifyInstance;

  return createDepositMonitorWorker(mockApp, prisma, redis);
}
