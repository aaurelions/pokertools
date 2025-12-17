import { Worker, type Job } from "bullmq";
import { PrismaClient } from "../../generated/prisma/index.js";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { BlockchainManager } from "../services/BlockchainManager.js";
import { parseAbi } from "viem";
import type { FastifyInstance } from "fastify";

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
 * Security fixes:
 * - Uses BigInt arithmetic for all financial conversions (no floating point)
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

      // 1. Get active sessions
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

      // 2. Get enabled blockchains and tokens
      const blockchains = await prisma.blockchain.findMany({
        where: { isEnabled: true },
        include: { tokens: { where: { isEnabled: true } } },
      });

      // 3. Build a Set of active wallet addresses for O(1) lookup
      // We use the map for checking existence to ensure case-insensitivity
      const walletToUserMap = new Map(
        Array.from(uniqueWallets.entries()).map(([addr, session]) => [
          addr.toLowerCase(),
          session.userId,
        ])
      );

      logger.info({ activeWalletCount: walletToUserMap.size }, "Built active wallet lookup map");

      // 4. Scan by BLOCK (not by user) - O(Chains × Tokens) RPC calls
      for (const chain of blockchains) {
        try {
          const client = await blockchainManager.getClient(chain.id);
          const currentBlock = await client.getBlockNumber();

          // Determine scan range using lastScannedBlock
          const lastScanned = chain.lastScannedBlock
            ? BigInt(chain.lastScannedBlock)
            : currentBlock - 100n; // Initial safe lookback

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
          for (const token of chain.tokens) {
            try {
              // Get ALL Transfer events for this token in block range
              // Do NOT filter by 'to' address - get everything
              const logs = await client.getContractEvents({
                address: token.address as `0x${string}`,
                abi: ERC20_ABI,
                eventName: "Transfer",
                // NO args filter - we want all transfers
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
                const toAddress = log.args.to?.toLowerCase();
                
                // Debug logging
                if (toAddress) {
                   logger.info({ toAddress, isActive: walletToUserMap.has(toAddress) }, "Checking log address");
                }

                if (!toAddress || !walletToUserMap.has(toAddress)) {
                  continue; // Not one of our users
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

                // PROCESS NEW DEPOSIT
                // Convert token amount to Chips (cents) using BigInt arithmetic ONLY
                const amountBigInt = BigInt(amount);
                const decimalsBigInt = 10n ** BigInt(token.decimals);
                const chips = Number((amountBigInt * 100n) / decimalsBigInt);

                // Safety check
                if (chips > Number.MAX_SAFE_INTEGER) {
                  logger.error({ txHash, amount: amountBigInt.toString() }, "Deposit too large");
                  continue;
                }

                if (chips <= 0) continue;

                // Calculate confirmations
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
                          currency: "USDC",
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
                        metadata: { chain: chain.name, token: token.symbol },
                      },
                    });

                    await tx.account.update({
                      where: { id: mainAccount.id },
                      data: { balance: { increment: chips } },
                    });

                    // Record PaymentTransaction with link to ledger entry
                    await tx.paymentTransaction.create({
                      data: {
                        userId,
                        type: "DEPOSIT",
                        blockchainId: chain.id,
                        tokenId: token.id,
                        txHash,
                        address: toAddress,
                        blockNumber: txBlockNumber.toString(),
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
                        amount: chips,
                        confirmations,
                      },
                      "Deposit confirmed and credited"
                    );
                  } else {
                    // Record PaymentTransaction without ledger link (pending)
                    await tx.paymentTransaction.create({
                      data: {
                        userId,
                        type: "DEPOSIT",
                        blockchainId: chain.id,
                        tokenId: token.id,
                        txHash,
                        address: toAddress,
                        blockNumber: txBlockNumber.toString(),
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
                      },
                      "Deposit detected but pending confirmations"
                    );
                  }
                });
              }
            } catch (tokenErr) {
              logger.error(
                { error: tokenErr, token: token.symbol, chain: chain.name },
                "Error processing token"
              );
            }
          }

          // Update lastScannedBlock after successful scan
          await prisma.blockchain.update({
            where: { id: chain.id },
            data: { lastScannedBlock: toBlock.toString() },
          });

          logger.info(
            { chain: chain.name, lastScannedBlock: toBlock.toString() },
            "Updated lastScannedBlock"
          );
        } catch (chainErr) {
          logger.error({ error: chainErr, chain: chain.name }, "Error scanning chain");
        }
      }

      // 4. Check PENDING deposits for confirmation upgrades
      await checkPendingDeposits(prisma, blockchainManager, logger);
    },
    {
      connection: redis,
      concurrency: 5, // Scan 5 users in parallel
      limiter: {
        max: 10, // Limit RPC calls
        duration: 1000,
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
 * Check PENDING deposits and upgrade to CONFIRMED when they have enough confirmations
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

      if (confirmations >= requiredConfirmations) {
        // Upgrade to CONFIRMED and credit user
        await prisma.$transaction(async (tx) => {
          // Credit Ledger
          const mainAccount = await tx.account.findUniqueOrThrow({
            where: {
              userId_currency_type: {
                userId: deposit.userId,
                currency: "USDC",
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
              },
            },
          });

          await tx.account.update({
            where: { id: mainAccount.id },
            data: { balance: { increment: deposit.amountCredit } },
          });

          // Update PaymentTransaction to CONFIRMED with ledger link
          await tx.paymentTransaction.update({
            where: { id: deposit.id },
            data: {
              status: "CONFIRMED",
              ledgerEntryId: ledgerEntry.id,
              confirmedAt: new Date(),
            },
          });
        });

        logger.info(
          {
            event: "deposit_upgraded",
            depositId: deposit.id,
            userId: deposit.userId,
            txHash: deposit.txHash,
            confirmations,
          },
          "Pending deposit upgraded to confirmed"
        );
      }
    } catch (err) {
      logger.error({ error: err, depositId: deposit.id }, "Error checking pending deposit");
    }
  }
}

// Export for backward compatibility
// This is used if worker is started standalone without FastifyInstance
export default function createStandaloneWorker(): Worker {
  const prisma = new PrismaClient();
  const redis = new Redis(config.REDIS_URL);

  // Create real Pino logger for standalone mode
  // Use pino directly for proper async logging (not blocking console.log)
  const pino = require("pino");
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
  const mockApp = { log: logger.child({ worker: "deposit-monitor" }) } as FastifyInstance;

  return createDepositMonitorWorker(mockApp, prisma, redis);
}
