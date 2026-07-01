import { PrismaClient } from "../../../api/generated/prisma/index.js";
import type { Blockchain, Token } from "../../../api/generated/prisma/index.js";
import {
  parseAbi,
  parseUnits,
  hexToSignature,
  formatUnits,
  type PublicClient,
  type LocalAccount,
} from "viem";
import { BlockchainService } from "./blockchain-service.js";
import { config } from "../config.js";
import type { Logger } from "pino";
import { CircuitBreaker, withRetry } from "../utils/resilience.js";

// ABI for the BatchSweeper Contract
const BATCH_ABI = parseAbi([
  "function batchSweep(address token, address[] owners, uint256[] amounts, uint256[] deadlines, uint8[] v, bytes32[] r, bytes32[] s)",
  "error ArrayLengthMismatch()",
]);

// ABI for ERC20 Permit info
const TOKEN_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

type ChainWithTokens = Blockchain & { tokens: Token[] };

type Candidate = [
  { address: string; derivationIndex: number }, // Wallet subset
  LocalAccount, // User Account subset
  bigint, // Balance
];

export class SweeperService {
  private isRunning = false;
  private sweepBreaker = new CircuitBreaker("sweep-broadcast");
  private sweeperAddresses = this.buildSweeperMap();

  constructor(
    private prisma: PrismaClient,
    private chainService: BlockchainService,
    private logger: Logger
  ) {}

  private buildSweeperMap(): Record<number, string> {
    const fallback: Record<number, string> = {
      137: config.BATCH_SWEEPER_ADDRESS_POLYGON,
      1: config.BATCH_SWEEPER_ADDRESS_MAINNET,
      31337: config.BATCH_SWEEPER_ADDRESS_LOCAL,
    };

    if (!config.SWEEPER_CONTRACT_MAP) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(config.SWEEPER_CONTRACT_MAP) as Record<string, string>;
      return Object.fromEntries(
        Object.entries(parsed)
          .map(([chainId, address]) => [Number(chainId), address] as const)
          .filter(
            ([chainId, address]) => Number.isInteger(chainId) && /^0x[a-fA-F0-9]{40}$/.test(address)
          )
      );
    } catch {
      throw new Error('SWEEPER_CONTRACT_MAP must be valid JSON: {"1":"0x..."}');
    }
  }

  async startCron() {
    setInterval(() => {
      void this.run();
    }, config.SWEEP_INTERVAL_MS);
    await this.run();
  }

  async run() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const chains = await this.prisma.blockchain.findMany({
        where: { isEnabled: true },
        include: { tokens: { where: { isEnabled: true } } },
      });

      for (const chain of chains) {
        if (!this.sweeperAddresses[chain.chainId]) continue;
        await this.processChain(chain);
      }
    } catch (e) {
      this.logger.error(e, "Sweeper Error");
    } finally {
      this.isRunning = false;
    }
  }

  private async processChain(chain: ChainWithTokens) {
    const publicClient = this.chainService.getPublicClient(chain);
    const gasPrice = await publicClient.getGasPrice();

    if (parseFloat(formatUnits(gasPrice, 9)) > config.MAX_GAS_PRICE_GWEI) {
      this.logger.info(`Skipping ${chain.name}: High Gas`);
      return;
    }

    // Paginate all wallets (cursor-based)
    const pageSize = 100;
    let lastId: string | undefined = undefined;
    const allWallets: Awaited<ReturnType<typeof this.prisma.userWallet.findMany>> = [];

    while (true) {
      const page: Awaited<ReturnType<typeof this.prisma.userWallet.findMany>> =
        await this.prisma.userWallet.findMany({
          take: pageSize,
          ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
          orderBy: { id: "asc" },
        });
      if (page.length === 0) break;
      allWallets.push(...page);
      lastId = page[page.length - 1].id;
    }

    const batchSize = 20;

    for (const token of chain.tokens) {
      const candidates: Candidate[] = [];

      for (const wallet of allWallets) {
        this.logger.info(`Checking wallet ${wallet.id}:`);
        this.logger.info(`  Stored address: ${wallet.address}`);

        // Check balance of stored (on-chain) address
        const balance = await publicClient.readContract({
          address: token.address as `0x${string}`,
          abi: TOKEN_ABI,
          functionName: "balanceOf",
          args: [wallet.address as `0x${string}`],
        });

        this.logger.info(`  Balance: ${formatUnits(balance, token.decimals)} ${token.symbol}`);

        const minSweep = parseUnits(config.MIN_SWEEP_VALUE_USD.toString(), token.decimals);

        if (balance >= minSweep) {
          const userAccount = await this.chainService.getUserAccount(wallet.derivationIndex);
          candidates.push([wallet, userAccount, balance]);
        }
      }

      // Process in batches
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        await this.executeBatch(chain, token, batch, publicClient);
      }
    }
  }

  private async executeBatch(
    chain: ChainWithTokens,
    token: Token,
    candidates: Candidate[],
    publicClient: PublicClient
  ) {
    const sweeperAddr = this.sweeperAddresses[chain.chainId] as `0x${string}`;
    const hotWalletClient = this.chainService.getHotWalletClient(chain);

    const owners: Array<`0x${string}`> = [];
    const amounts: bigint[] = [];
    const deadlines: bigint[] = [];
    const vs: number[] = [];
    const rs: Array<`0x${string}`> = [];
    const ss: Array<`0x${string}`> = [];

    // Generate off-chain Permit signatures for each owner
    const tokenContract = { address: token.address as `0x${string}`, abi: TOKEN_ABI };
    const [name, version] = await Promise.all([
      publicClient.readContract({
        ...tokenContract,
        functionName: "name",
      }),
      publicClient.readContract({ ...tokenContract, functionName: "version" }).catch(() => "1"),
    ]);

    for (const [wallet, userAccount, balance] of candidates) {
      const nonce = await publicClient.readContract({
        ...tokenContract,
        functionName: "nonces",
        args: [wallet.address as `0x${string}`],
      });

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const sig = await userAccount.signTypedData({
        domain: {
          name,
          version,
          chainId: BigInt(chain.chainId),
          verifyingContract: token.address as `0x${string}`,
        },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: wallet.address as `0x${string}`,
          spender: sweeperAddr,
          value: balance,
          nonce,
          deadline,
        },
      });

      const { v, r, s } = hexToSignature(sig);

      owners.push(wallet.address as `0x${string}`);
      amounts.push(balance);
      deadlines.push(deadline);
      vs.push(Number(v));
      rs.push(r);
      ss.push(s);
    }

    if (owners.length === 0) return;

    try {
      this.logger.info(`Sweeping ${owners.length} wallets for ${token.symbol}`);

      const hash = await withRetry(async () => {
        const nonce = await this.chainService.getNextHotWalletNonce(chain);
        return hotWalletClient.writeContract({
          address: sweeperAddr,
          abi: BATCH_ABI,
          functionName: "batchSweep",
          args: [token.address as `0x${string}`, owners, amounts, deadlines, vs, rs, ss],
          chain: null,
          account: hotWalletClient.account!,
          nonce,
        });
      }, this.sweepBreaker);

      this.logger.info(`Sweep Tx Sent: ${hash}`);

      // Log a ledger entry per owner for accounting
      for (let i = 0; i < owners.length; i++) {
        const wallet = await this.prisma.userWallet.findFirst({
          where: { address: owners[i] },
          include: { user: { include: { accounts: true } } },
        });

        if (!wallet) continue;

        const mainAccount = wallet.user.accounts.find(
          (acc) => acc.type === "MAIN" && acc.currency === "USDC"
        );

        if (!mainAccount) continue;

        await this.prisma.ledgerEntry.create({
          data: {
            accountId: mainAccount.id,
            amount: 0,
            type: "SWEEP",
            referenceId: hash,
            metadata: {
              from: owners[i],
              token: token.symbol,
              amount: amounts[i].toString(),
            },
          },
        });
      }
    } catch (e) {
      this.logger.error(e, "Batch Execution Failed");
    }
  }
}
