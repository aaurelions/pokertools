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
import { decryptXpriv } from "../utils/crypto.js";
import type { Redis } from "ioredis";

export class BlockchainService {
  private publicClients = new Map<number, PublicClient>();
  private hotWalletClients = new Map<number, WalletClient>();
  private localNonceCache = new Map<number, number>();
  private masterHDKey: HDKey;
  public hotWalletAccount: Account;

  constructor(
    private prisma: PrismaClient,
    private logger: Logger,
    private redis?: Redis
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

    // Build transport with failover when backup RPC URL exists
    const rpcUrls = [chain.rpcUrl, chain.rpcUrlBackup].filter((url): url is string => Boolean(url));

    const transport =
      rpcUrls.length > 1
        ? fallback(
            rpcUrls.map((url) =>
              http(url, {
                retryCount: config.RPC_RETRY_COUNT,
                retryDelay: config.RPC_RETRY_DELAY_MS,
                timeout: config.RPC_TIMEOUT_MS,
              })
            )
          )
        : http(chain.rpcUrl, {
            retryCount: config.RPC_RETRY_COUNT,
            retryDelay: config.RPC_RETRY_DELAY_MS,
            timeout: config.RPC_TIMEOUT_MS,
          });

    const client = createPublicClient({
      chain: viemChain,
      transport,
    });

    this.publicClients.set(chain.chainId, client);
    return client;
  }

  getHotWalletClient(chain: Blockchain): WalletClient {
    if (this.hotWalletClients.has(chain.chainId)) {
      return this.hotWalletClients.get(chain.chainId)!;
    }

    const publicClient = this.getPublicClient(chain);
    const client = createWalletClient({
      account: this.hotWalletAccount,
      chain: publicClient.chain,
      transport: http(chain.rpcUrl, {
        retryCount: config.RPC_RETRY_COUNT,
        retryDelay: config.RPC_RETRY_DELAY_MS,
        timeout: config.RPC_TIMEOUT_MS,
      }),
    });

    this.hotWalletClients.set(chain.chainId, client);
    return client;
  }

  async getNextHotWalletNonce(chain: Blockchain): Promise<number> {
    const publicClient = this.getPublicClient(chain);
    const key = `nonce:hotwallet:${chain.chainId}:${this.hotWalletAccount.address.toLowerCase()}`;

    if (this.redis) {
      const pendingNonce = await publicClient.getTransactionCount({
        address: this.hotWalletAccount.address,
        blockTag: "pending",
      });
      const nonce = (await this.redis.eval(
        `
        local key = KEYS[1]
        local pending = tonumber(ARGV[1])
        local ttl = tonumber(ARGV[2])
        local current = redis.call('GET', key)
        if not current or tonumber(current) < pending then
          redis.call('SET', key, pending, 'EX', ttl)
          return pending
        end
        local nextNonce = redis.call('INCR', key)
        redis.call('EXPIRE', key, ttl)
        return nextNonce
        `,
        1,
        key,
        pendingNonce.toString(),
        "3600"
      )) as number;
      return nonce;
    }

    const cached = this.localNonceCache.get(chain.chainId);
    if (cached === undefined) {
      const pendingNonce = await publicClient.getTransactionCount({
        address: this.hotWalletAccount.address,
        blockTag: "pending",
      });
      this.localNonceCache.set(chain.chainId, pendingNonce);
      return pendingNonce;
    }

    const next = cached + 1;
    this.localNonceCache.set(chain.chainId, next);
    return next;
  }

  getExplorerLink(chain: Blockchain, hash: `0x${string}`): string {
    return chain.explorerUrl + "/tx/" + hash;
  }

  /**
   * Get a user account (with private key) for signing transactions
   * This MUST derive the same addresses as the API's BlockchainManager
   *
   * Uses the encrypted xpriv field (separate secret from API's xpub)
   */
  async getUserAccount(derivationIndex: number) {
    const adminWallet = await this.prisma.adminWallet.findFirst({
      where: { isActive: true },
    });

    if (!adminWallet) {
      throw new Error("No active AdminWallet found");
    }

    // Decrypt xpriv (private key material) using the separate xpriv encryption secret
    const xpriv = decryptXpriv(adminWallet.xpriv);
    const hdKey = HDKey.fromExtendedKey(xpriv);
    const childKey = hdKey.deriveChild(derivationIndex);

    if (!childKey.privateKey) {
      throw new Error(`Cannot derive private key for index ${derivationIndex}`);
    }

    const account = privateKeyToAccount(`0x${Buffer.from(childKey.privateKey).toString("hex")}`);

    return account;
  }
}
