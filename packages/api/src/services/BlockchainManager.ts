import { PrismaClient } from "../../generated/prisma/index.js";
import { createPublicClient, http, fallback, type PublicClient, defineChain } from "viem";
import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "../utils/errors.js";
import { config } from "../config.js";
import { decryptXpub } from "../utils/crypto.js";

// Simple in-memory cache for clients to avoid recreating them constantly
const clientCache = new Map<string, PublicClient>();

export class BlockchainManager {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get a Viem PublicClient for a specific blockchain ID (from DB)
   */
  async getClient(blockchainId: string): Promise<PublicClient> {
    if (clientCache.has(blockchainId)) {
      return clientCache.get(blockchainId)!;
    }

    const chainConfig = await this.prisma.blockchain.findUniqueOrThrow({
      where: { id: blockchainId },
    });

    if (!chainConfig.isEnabled) {
      throw new AppError(`Blockchain ${chainConfig.name} is disabled`, 400);
    }

    const nativeCurrency = chainConfig.nativeCurrency as {
      name: string;
      symbol: string;
      decimals: number;
    };

    // Construct Viem Chain object dynamically
    const viemChain = defineChain({
      id: chainConfig.chainId,
      name: chainConfig.name,
      network: chainConfig.name.toLowerCase().replace(/\s/g, "-"),
      nativeCurrency: {
        name: nativeCurrency.name,
        symbol: nativeCurrency.symbol,
        decimals: nativeCurrency.decimals,
      },
      rpcUrls: {
        default: { http: [chainConfig.rpcUrl] },
        public: { http: [chainConfig.rpcUrl] },
      },
      blockExplorers: {
        default: { name: "Explorer", url: chainConfig.explorerUrl },
      },
    });

    // Build transport with failover support
    const rpcUrls = [chainConfig.rpcUrl, chainConfig.rpcUrlBackup].filter((url): url is string =>
      Boolean(url)
    );

    // Use configurable retry/timeout settings from environment
    const rpcOptions = {
      retryCount: config.RPC_RETRY_COUNT,
      retryDelay: config.RPC_RETRY_DELAY,
      timeout: config.RPC_TIMEOUT,
    };

    const transport =
      rpcUrls.length > 1
        ? fallback(rpcUrls.map((url) => http(url, rpcOptions)))
        : http(chainConfig.rpcUrl, rpcOptions);

    const client = createPublicClient({
      chain: viemChain,
      transport,
    });

    clientCache.set(blockchainId, client);
    return client;
  }

  /**
   * Generate or retrieve the deposit address for a user.
   * This is idempotent: if user has an index, return address.
   * If not, increment AdminWallet index and assign.
   */
  async getUserDepositAddress(userId: string): Promise<string> {
    // 1. Check if user already has a wallet assigned
    const existingWallet = await this.prisma.userWallet.findFirst({
      where: { userId, adminWallet: { isActive: true } },
      include: { adminWallet: true },
    });

    if (existingWallet) {
      return existingWallet.address;
    }

    // 2. Get active admin xpub
    const adminWallet = await this.prisma.adminWallet.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: "desc" }, // Use most recent active
    });

    if (!adminWallet) {
      throw new AppError("No active deposit wallet configured", 500);
    }

    // 3. Atomic increment of derivation index
    // We use a transaction to ensure no two users get the same index
    const newWallet = await this.prisma.$transaction(async (tx) => {
      // Lock and increment
      const wallet = await tx.adminWallet.update({
        where: { id: adminWallet.id },
        data: { currentIndex: { increment: 1 } },
      });

      const index = wallet.currentIndex; // This is the new unique index

      // Derive address (decrypt xpub first - stored encrypted in DB)
      const xpub = decryptXpub(wallet.xpub);
      const address = this.deriveAddressFromXpub(xpub, index);

      // Assign to user
      return await tx.userWallet.create({
        data: {
          userId,
          adminWalletId: wallet.id,
          derivationIndex: index,
          address,
        },
      });
    });

    return newWallet.address;
  }

  /**
   * Derive EVM address from xPub at specific index
   * Uses @scure/bip32 for HD logic and viem for address formatting
   *
   * ⚠️ CRITICAL: This derivation path MUST match BlockchainService.getUserAccount()
   * in the admin package to ensure addresses are consistent across systems.
   *
   * The xPub should be derived at m/44'/60'/0'/0, then we append the index.
   * Final logical path: m/44'/60'/0'/0/{index}
   */
  private deriveAddressFromXpub(xpubOrXpriv: string, index: number): string {
    const hdKey = HDKey.fromExtendedKey(xpubOrXpriv);
    const childKey = hdKey.deriveChild(index);

    if (!childKey.privateKey) {
      throw new Error(`Cannot derive private key for index ${index}`);
    }

    // Use same method as BlockchainService
    const account = privateKeyToAccount(
      `0x${Buffer.from(childKey.privateKey).toString("hex")}`
    );

    return account.address.toLowerCase();
  }

  /**
   * Start a deposit monitoring session
   */
  async startDepositSession(
    userId: string,
    durationMinutes = 30
  ): Promise<{ address: string; expiresAt: Date }> {
    // Ensure wallet exists
    const address = await this.getUserDepositAddress(userId);

    const wallet = await this.prisma.userWallet.findFirstOrThrow({
      where: { userId, address },
    });

    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

    // Create or extend session
    await this.prisma.depositSession.create({
      data: {
        userId,
        userWalletId: wallet.id,
        expiresAt,
      },
    });

    return { address, expiresAt };
  }
}
