import { PrismaClient } from "../../../api/generated/prisma/index.js";
import type { Blockchain } from "../../../api/generated/prisma/index.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  PublicClient,
  WalletClient,
  Account,
  defineChain,
  fallback,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { config, SECRETS } from "../config.js";
import type { Logger } from "pino";
import { decryptXpub } from "../utils/crypto.js";

export class BlockchainService {
  private publicClients = new Map<number, PublicClient>();
  private masterHDKey: HDKey;
  public hotWalletAccount: Account;
  private cachedDerivationPath: string | null = null;

  constructor(
    private prisma: PrismaClient,
    private logger: Logger
  ) {
    const seed = mnemonicToSeedSync(SECRETS.MASTER_MNEMONIC);
    this.masterHDKey = HDKey.fromMasterSeed(seed);

    this.hotWalletAccount = mnemonicToAccount(SECRETS.MASTER_MNEMONIC, {
      path: config.HOT_WALLET_DERIVATION_PATH as `m/44'/60'/${string}`,
    });

    this.logger.info(`🔥 Hot Wallet Initialized: ${this.hotWalletAccount.address}`);
  }

  getPublicClient(chain: Blockchain): PublicClient {
    if (this.publicClients.has(chain.chainId)) {
      return this.publicClients.get(chain.chainId)!;
    }

    const currency = chain.nativeCurrency as {
      name: string;
      symbol: string;
      decimals: number;
    };

    const viemChain = defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: {
        decimals: currency.decimals,
        name: currency.name,
        symbol: currency.symbol,
      },
      rpcUrls: {
        default: { http: [chain.rpcUrl] },
      },
      blockExplorers: {
        default: { name: "Explorer", url: chain.explorerUrl },
      },
    });

    // Build transport with failover if backup URL exists
    const rpcUrls = [chain.rpcUrl, chain.rpcUrlBackup].filter((url): url is string => Boolean(url));

    const transport =
      rpcUrls.length > 1
        ? fallback(rpcUrls.map((url) => http(url, { retryCount: 3 })))
        : http(chain.rpcUrl, { retryCount: 3 });

    const client = createPublicClient({
      chain: viemChain,
      transport,
    });

    this.publicClients.set(chain.chainId, client);
    return client;
  }

  getHotWalletClient(chain: Blockchain): WalletClient {
    const publicClient = this.getPublicClient(chain);
    return createWalletClient({
      account: this.hotWalletAccount,
      chain: publicClient.chain,
      transport: http(chain.rpcUrl),
    });
  }

  getExplorerLink(chain: Blockchain, hash: `0x${string}`): string {
    return chain.explorerUrl + "/tx/" + hash;
  }

  /**
   * Get and cache the active admin wallet derivation path
   */
  private async getDerivationPath(): Promise<string> {
    if (this.cachedDerivationPath) {
      return this.cachedDerivationPath;
    }

    const adminWallet = await this.prisma.adminWallet.findFirst({
      where: { isActive: true },
    });

    if (!adminWallet) {
      throw new Error("No active AdminWallet found");
    }

    this.cachedDerivationPath = adminWallet.derivationPath;
    return this.cachedDerivationPath;
  }

  /**
   * Get a user account (with private key) for signing transactions
   * This MUST derive the same addresses as the API's BlockchainManager
   */
  async getUserAccount(derivationIndex: number) {
    const adminWallet = await this.prisma.adminWallet.findFirst({
      where: { isActive: true },
    });

    if (!adminWallet) {
      throw new Error("No active AdminWallet found");
    }

    // Decrypt the xpriv
    const xpriv = decryptXpub(adminWallet.xpub); // Contains xpriv now
    const hdKey = HDKey.fromExtendedKey(xpriv);
    const childKey = hdKey.deriveChild(derivationIndex);

    if (!childKey.privateKey) {
      throw new Error(`Cannot derive private key for index ${derivationIndex}`);
    }

    const account = privateKeyToAccount(
      `0x${Buffer.from(childKey.privateKey).toString("hex")}`
    );

    return account;
  }
}
