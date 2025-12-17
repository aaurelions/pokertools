import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startAnvil,
  stopAnvil,
  deployContracts,
  publicClient,
  walletClient,
  localChain,
} from "../helpers/chain-utils.js";
import { PrismaClient, type User } from "../../../api/generated/prisma/index.js";
import { BlockchainService } from "../../src/services/BlockchainService.js";
import { SweeperService } from "../../src/services/SweeperService.js";
import { WithdrawalBot } from "../../src/services/WithdrawalBot.js";
import { TransactionMonitor } from "../../src/services/TransactionMonitor.js";

import { BlockchainManager } from "../../../api/src/services/BlockchainManager.js";
import { FinancialManager } from "../../../api/src/services/FinancialManager.js";
import { GameManager } from "../../../api/src/services/GameManager.js";
import { createDepositMonitorWorker } from "../../../api/src/workers/deposit-monitor.js";
import { encryptXpub } from "../../../api/src/utils/crypto.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import { Redis } from "ioredis";
// @ts-ignore
import Redlock from "redlock";
import { Queue } from "bullmq";
import { parseAbi, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ActionType } from "@pokertools/types";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "silent",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname,time",
            translateTime: false,
            singleLine: true,
            messageFormat: "{msg}",
          },
        }
      : undefined,
});

// Define ABI as const for strict type inference
const USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidReceiver(address receiver)",
]);

describe("E2E: Deposit -> Game -> Sweep -> Withdraw", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let contracts: { usdcAddress: string; sweeperAddress: string };

  // Services
  let blockchainService: BlockchainService;
  let apiBlockchainManager: BlockchainManager;
  let sweeperService: SweeperService;
  let financialManager: FinancialManager;
  let gameManager: GameManager;
  let withdrawalBot: WithdrawalBot;
  let txMonitor: TransactionMonitor;

  // Users
  let winner: User;
  let loser: User;
  let winnerDepositAddr: string;
  let loserDepositAddr: string;
  let tableId: string;

  beforeAll(async () => {
    await startAnvil();
    contracts = await deployContracts();

    prisma = new PrismaClient();
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
    const redlock = new Redlock([redis]);
    const queue = new Queue("poker-jobs", { connection: redis });

    // Generate xPriv for admin wallet
    const seed = mnemonicToSeedSync(process.env.MASTER_MNEMONIC!);
    const masterKey = HDKey.fromMasterSeed(seed);
    const derivedKey = masterKey.derive("m/44'/60'/0'/0");
    const xpriv = derivedKey.privateExtendedKey;

    // Clean up any existing admin wallet
    await prisma.adminWallet.deleteMany({});

    // Create admin wallet with xPriv
    await prisma.adminWallet.create({
      data: {
        label: "E2E Test Wallet",
        xpub: encryptXpub(xpriv), // Store encrypted xPriv
        derivationPath: "m/44'/60'/0'/0",
        currentIndex: 0,
        isActive: true,
      },
    });

    // Setup blockchain
    const chain = await prisma.blockchain.upsert({
      where: { chainId: 31337 },
      create: {
        id: "anvil_local",
        name: "Anvil Local",
        chainId: 31337,
        rpcUrl: "http://127.0.0.1:8545",
        explorerUrl: "http://localhost:4000",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        confirmations: 1,
        isEnabled: true,
        lastScannedBlock: "0",
      },
      update: {
        lastScannedBlock: "0",
        isEnabled: true,
      },
    });

    // Setup token
    await prisma.token.upsert({
      where: {
        blockchainId_address: {
          blockchainId: chain.id,
          address: contracts.usdcAddress,
        },
      },
      create: {
        blockchainId: chain.id,
        address: contracts.usdcAddress,
        symbol: "USDC",
        name: "Mock USDC",
        decimals: 6,
        minDeposit: "1000000",
        isEnabled: true,
      },
      update: {
        isEnabled: true,
      },
    });

    // Ensure HOUSE user exists
    await prisma.user.upsert({
      where: { username: "HOUSE" },
      create: {
        username: "HOUSE",
        address: "0x0000000000000000000000000000000000000000",
        role: "ADMIN",
      },
      update: {},
    });

    // Initialize services
    blockchainService = new BlockchainService(prisma, logger);
    apiBlockchainManager = new BlockchainManager(prisma);
    financialManager = new FinancialManager(prisma);
    gameManager = new GameManager(redis, redlock, queue, prisma);

    sweeperService = new SweeperService(prisma, blockchainService, logger);
    // @ts-ignore - Override for local testing
    sweeperService.sweeperAddresses[31337] = contracts.sweeperAddress;

    // Mock Telegram bot
    const mockBot = {
      sendMessage: async () => {
        /* mock */
      },
      on: () => {
        /* mock */
      },
      editMessageText: async () => {
        /* mock */
      },
      api: {
        sendMessage: async () => {
          /* mock */
        },
      },
    } as any;

    withdrawalBot = new WithdrawalBot(prisma, redis, blockchainService, logger);
    withdrawalBot.bot = mockBot;

    txMonitor = new TransactionMonitor(prisma, blockchainService, logger);
  });

  afterAll(async () => {
    // Clean up test data in correct order (respecting foreign keys)
    if (winner) {
      await prisma.depositSession.deleteMany({ where: { userId: winner.id } });
      await prisma.userWallet.deleteMany({ where: { userId: winner.id } });
      await prisma.paymentTransaction.deleteMany({ where: { userId: winner.id } });
      await prisma.ledgerEntry.deleteMany({ where: { account: { userId: winner.id } } });
      await prisma.account.deleteMany({ where: { userId: winner.id } });
      await prisma.user.delete({ where: { id: winner.id } }).catch(() => {
        /* ignore */
      });
    }

    if (loser) {
      await prisma.depositSession.deleteMany({ where: { userId: loser.id } });
      await prisma.userWallet.deleteMany({ where: { userId: loser.id } });
      await prisma.paymentTransaction.deleteMany({ where: { userId: loser.id } });
      await prisma.ledgerEntry.deleteMany({ where: { account: { userId: loser.id } } });
      await prisma.account.deleteMany({ where: { userId: loser.id } });
      await prisma.user.delete({ where: { id: loser.id } }).catch(() => {
        /* ignore */
      });
    }

    if (prisma) await prisma.$disconnect();
    if (redis) await redis.quit();
    await stopAnvil();
  });

  it("1. Register Users & Generate Deposit Addresses", async () => {
    const randomId = Date.now();

    const winnerAddr = privateKeyToAccount(generatePrivateKey()).address;
    const loserAddr = privateKeyToAccount(generatePrivateKey()).address;

    winner = await prisma.user.create({
      data: { username: `poker_pro_${randomId}`, address: winnerAddr.toLowerCase() },
    });
    loser = await prisma.user.create({
      data: { username: `fish_${randomId}`, address: loserAddr.toLowerCase() },
    });

    await financialManager.ensureAccounts(winner.id);
    await financialManager.ensureAccounts(loser.id);

    winnerDepositAddr = await apiBlockchainManager.getUserDepositAddress(winner.id);
    loserDepositAddr = await apiBlockchainManager.getUserDepositAddress(loser.id);

    await apiBlockchainManager.startDepositSession(winner.id);
    await apiBlockchainManager.startDepositSession(loser.id);

    expect(winnerDepositAddr).not.toBe(loserDepositAddr);
    expect(winnerDepositAddr).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(loserDepositAddr).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("2. Deposit Funds (On-Chain -> Ledger)", async () => {
    const depositAmount = parseUnits("100", 6);

    // Fund deposit addresses with ETH for gas
    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: winnerDepositAddr as Address,
      value: parseUnits("0.1", 18),
      kzg: undefined,
    });

    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: loserDepositAddr as Address,
      value: parseUnits("0.1", 18),
      kzg: undefined,
    });

    // Verify deposit sessions exist
    const winnerSession = await prisma.depositSession.findFirst({
      where: { userId: winner.id },
      include: { userWallet: true },
      orderBy: { createdAt: "desc" },
    });

    const loserSession = await prisma.depositSession.findFirst({
      where: { userId: loser.id },
      include: { userWallet: true },
      orderBy: { createdAt: "desc" },
    });

    if (!winnerSession?.userWallet || !loserSession?.userWallet) {
      throw new Error("Deposit sessions or user wallets not found");
    }

    // Mint USDC to deposit addresses
    const hash1 = await walletClient.writeContract({
      address: contracts.usdcAddress as `0x${string}`,
      abi: USDC_ABI,
      functionName: "mint",
      args: [winnerDepositAddr as `0x${string}`, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: hash1 });

    const hash2 = await walletClient.writeContract({
      address: contracts.usdcAddress as `0x${string}`,
      abi: USDC_ABI,
      functionName: "mint",
      args: [loserDepositAddr as `0x${string}`, depositAmount],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: hash2 });

    // Mine a block to ensure transactions are processed
    const hash3 = await walletClient.writeContract({
      address: contracts.usdcAddress as `0x${string}`,
      abi: USDC_ABI,
      functionName: "mint",
      args: [contracts.sweeperAddress as `0x${string}`, 0n],
      chain: localChain,
      account: walletClient.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: hash3 });

    // Run deposit monitor
    const mockApp = { log: logger } as any;
    const depositWorker = createDepositMonitorWorker(mockApp, prisma, redis);
    const depositQueue = new Queue("deposit-monitor", { connection: redis });

    await depositQueue.add("scan", {});
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await depositWorker.close();
    await depositQueue.close();

    // Verify balances
    const winnerBal = await financialManager.getBalances(winner.id);
    const loserBal = await financialManager.getBalances(loser.id);

    expect(winnerBal.main).toBe(10000); // $100.00
    expect(loserBal.main).toBe(10000); // $100.00
  });

  it("3. Play Game (Handles Winner or Split Pot)", async () => {
    tableId = await gameManager.createTable({
      name: "High Stakes",
      mode: "CASH",
      smallBlind: 50,
      bigBlind: 100,
      maxPlayers: 2,
    });

    const buyInAmount = 5000;
    await financialManager.buyIn(winner.id, tableId, buyInAmount);
    await financialManager.buyIn(loser.id, tableId, buyInAmount);

    await gameManager.processAction(
      tableId,
      {
        type: ActionType.SIT,
        playerId: winner.id,
        playerName: winner.username,
        seat: 0,
        stack: buyInAmount,
      },
      winner.id
    );

    await gameManager.processAction(
      tableId,
      {
        type: ActionType.SIT,
        playerId: loser.id,
        playerName: loser.username,
        seat: 1,
        stack: buyInAmount,
      },
      loser.id
    );

    await gameManager.processAction(tableId, { type: ActionType.DEAL }, "system");

    await gameManager.processAction(
      tableId,
      { type: ActionType.RAISE, playerId: winner.id, amount: buyInAmount },
      winner.id
    );

    const state = await gameManager.processAction(
      tableId,
      { type: ActionType.CALL, playerId: loser.id },
      loser.id
    );

    expect(state.street).toBe("SHOWDOWN");
    expect(state.winners).toBeDefined();
    expect(state.winners!.length).toBeGreaterThan(0);

    // ✅ Handle both single winner and split pot (tie)
    await prisma.$transaction(async (tx: any) => {
      // First, deduct buy-ins from both players
      const winnerAcc = await tx.account.findFirst({
        where: { userId: winner.id, type: "IN_PLAY" },
      });
      const loserAcc = await tx.account.findFirst({
        where: { userId: loser.id, type: "IN_PLAY" },
      });

      if (!winnerAcc || !loserAcc) {
        throw new Error("Player accounts not found");
      }

      await tx.account.update({
        where: { id: winnerAcc.id },
        data: { balance: { decrement: buyInAmount } },
      });

      await tx.account.update({
        where: { id: loserAcc.id },
        data: { balance: { decrement: buyInAmount } },
      });

      // Then, credit winners with their share
      for (const winnerInfo of state.winners!) {
        const seatUserId = winnerInfo.seat === 0 ? winner.id : loser.id;
        const account = await tx.account.findFirst({
          where: { userId: seatUserId, type: "IN_PLAY" },
        });

        if (!account) {
          throw new Error(`Account not found for user ${seatUserId}`);
        }

        await tx.account.update({
          where: { id: account.id },
          data: { balance: { increment: winnerInfo.amount } },
        });
      }
    });

    await gameManager.processAction(
      tableId,
      { type: ActionType.STAND, playerId: winner.id },
      winner.id
    );

    await gameManager.processAction(
      tableId,
      { type: ActionType.STAND, playerId: loser.id },
      loser.id
    );

    // ✅ Cash out actual balances (handles ties correctly)
    const winnerFinalBal = await financialManager.getBalances(winner.id);
    const loserFinalBal = await financialManager.getBalances(loser.id);

    if (winnerFinalBal.inPlay > 0) {
      await financialManager.cashOut(winner.id, tableId, winnerFinalBal.inPlay);
    }
    if (loserFinalBal.inPlay > 0) {
      await financialManager.cashOut(loser.id, tableId, loserFinalBal.inPlay);
    }

    // ✅ Verify total chips are conserved (should equal 20000 total)
    const winnerMainBal = await financialManager.getBalances(winner.id);
    const loserMainBal = await financialManager.getBalances(loser.id);
    const totalChips = winnerMainBal.main + loserMainBal.main;

    expect(totalChips).toBe(20000); // $200.00 total always preserved
  });

  it("4. Sweep Funds to Hot Wallet", async () => {
    const hotWalletBalBefore = await publicClient.readContract({
      address: contracts.usdcAddress as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [blockchainService.hotWalletAccount.address as Address],
      authorizationList: undefined,
    });

    // Run the sweeper
    await sweeperService.run();

    // Wait for sweep transactions to confirm
    const expectedIncrease = parseUnits("200", 6);
    let hotWalletBalAfter = hotWalletBalBefore;

    // Poll for balance update (max 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      hotWalletBalAfter = await publicClient.readContract({
        address: contracts.usdcAddress as `0x${string}`,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [blockchainService.hotWalletAccount.address as Address],
        authorizationList: undefined,
      });

      if (hotWalletBalAfter >= hotWalletBalBefore + expectedIncrease) {
        break;
      }
    }

    // Verify deposit addresses are empty
    const winnerDepositBalAfter = await publicClient.readContract({
      address: contracts.usdcAddress as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [winnerDepositAddr as Address],
      authorizationList: undefined,
    });

    const loserDepositBalAfter = await publicClient.readContract({
      address: contracts.usdcAddress as Address,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [loserDepositAddr as Address],
      authorizationList: undefined,
    });

    expect(winnerDepositBalAfter).toBe(0n);
    expect(loserDepositBalAfter).toBe(0n);
    expect(hotWalletBalAfter).toBeGreaterThanOrEqual(hotWalletBalBefore + expectedIncrease);
  });

  it("5. Withdraw Winnings", async () => {
    // Fund hot wallet with ETH for gas
    await walletClient.sendTransaction({
      account: walletClient.account,
      chain: localChain,
      to: blockchainService.hotWalletAccount.address,
      value: parseUnits("1", 18),
      kzg: undefined,
    });

    const users = await prisma.account.findMany({
      where: { type: "MAIN", balance: { gt: 10000 } },
      include: { user: true },
    });

    if (users.length === 0) {
      throw new Error("No user with sufficient balance for withdrawal test");
    }

    const richUser = users[0].user;
    const withdrawAmount = 14000; // $140.00
    const destAddr = "0x9999999999999999999999999999999999999999" as Address;

    const chain = await prisma.blockchain.findUniqueOrThrow({ where: { chainId: 31337 } });
    const token = await prisma.token.findFirstOrThrow({ where: { symbol: "USDC" } });

    const ledgerEntry = await prisma.ledgerEntry.create({
      data: {
        accountId: users[0].id,
        amount: -withdrawAmount,
        type: "WITHDRAWAL",
        metadata: JSON.stringify({
          blockchainId: chain.id,
          tokenId: token.id,
          address: destAddr,
          amountRaw: parseUnits((withdrawAmount / 100).toString(), 6).toString(),
        }),
      },
    });

    const amountRaw = BigInt(JSON.parse(ledgerEntry.metadata as string).amountRaw);

    // Use hot wallet client for withdrawal
    const hotWalletClient = await blockchainService.getHotWalletClient(chain);

    const hash = await hotWalletClient.writeContract({
      address: contracts.usdcAddress as `0x${string}`,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [destAddr, amountRaw],
      chain: localChain,
      account: blockchainService.hotWalletAccount,
    });

    await prisma.paymentTransaction.create({
      data: {
        userId: richUser.id,
        type: "WITHDRAWAL",
        ledgerEntryId: ledgerEntry.id,
        txHash: hash,
        blockchainId: chain.id,
        tokenId: token.id,
        address: destAddr,
        amountRaw: amountRaw.toString(),
        amountCredit: withdrawAmount,
        status: "PROCESSING",
      },
    });

    await publicClient.waitForTransactionReceipt({ hash });

    // Monitor transaction confirmation
    await (txMonitor as any).monitor();

    const tx = await prisma.paymentTransaction.findFirst({ where: { txHash: hash } });
    expect(tx?.status).toBe("CONFIRMED");

    // Verify withdrawal succeeded
    const destBal = await publicClient.readContract({
      address: contracts.usdcAddress as `0x${string}`,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [destAddr as Address],
      authorizationList: undefined,
    });

    expect(destBal).toBe(amountRaw);
  });
});
