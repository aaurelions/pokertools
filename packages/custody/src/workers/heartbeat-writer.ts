/**
 * Durable custody heartbeat writer.
 *
 * The isolated custody process is the only component that holds (or can derive)
 * treasury signing material. It persists public, per-route readiness evidence so
 * the API readiness route can gate payouts without ever seeing a key:
 *
 *  - one row per configured `(chainId, treasuryAddress)` route,
 *  - `signerAddress` is the route's public treasury address,
 *  - `signerReady` is true only when the configured signing key's derived public
 *    address equals that treasury address (public key match only),
 *  - `gasReady` is true only when the native-gas quorum agrees and the balance
 *    covers the asset's positive configured floor.
 *
 * Nothing here reads or writes private key material to the database.
 */
import type { PrismaClient } from "@pokertools/api/database";
import type {
  AssetRegistry,
  Clock,
  CustodyLogger,
  RpcQuorumReader,
  TreasuryAsset,
} from "../core/types.js";
import type { TreasuryAccountResolver } from "../core/viem-ports.js";

export interface CustodyHeartbeatWriterDeps {
  prisma: Pick<PrismaClient, "custodyHeartbeat">;
  assets: AssetRegistry;
  quorum: RpcQuorumReader;
  accounts: TreasuryAccountResolver;
  workerId: string;
  clock: Clock;
  logger: CustodyLogger;
}

export interface CustodyHeartbeatEntry {
  chainId: number;
  signerAddress: string;
  signerReady: boolean;
  gasReady: boolean;
}

/**
 * Write one fresh heartbeat per configured `(chain, treasury)` route. Returns
 * the entries written; individual route failures are logged and skipped so one
 * broken RPC route cannot stop evidence for the others.
 */
export class CustodyHeartbeatWriter {
  constructor(private readonly deps: CustodyHeartbeatWriterDeps) {}

  async writeAll(): Promise<CustodyHeartbeatEntry[]> {
    const assets = await this.deps.assets.list();
    const routes = new Map<string, TreasuryAsset>();
    for (const asset of assets) {
      const treasury = asset.treasuryAddress.toLowerCase();
      if (!routes.has(`${asset.chainId}:${treasury}`)) {
        routes.set(`${asset.chainId}:${treasury}`, asset);
      }
    }

    const written: CustodyHeartbeatEntry[] = [];
    for (const asset of routes.values()) {
      const chainId = asset.chainId;
      const treasuryAddress = asset.treasuryAddress.toLowerCase();
      try {
        const signerReady = await this.signerMatches(chainId, treasuryAddress);
        const gasReady = await this.gasReady(asset);
        const entry: CustodyHeartbeatEntry = {
          chainId,
          signerAddress: treasuryAddress,
          signerReady,
          gasReady,
        };
        await this.deps.prisma.custodyHeartbeat.upsert({
          where: {
            chainId_signerAddress_workerId: {
              chainId: entry.chainId,
              signerAddress: entry.signerAddress,
              workerId: this.deps.workerId,
            },
          },
          create: {
            ...entry,
            workerId: this.deps.workerId,
            observedAt: new Date(this.deps.clock.now()),
          },
          update: {
            signerReady: entry.signerReady,
            gasReady: entry.gasReady,
            observedAt: new Date(this.deps.clock.now()),
          },
        });
        written.push(entry);
      } catch (error) {
        this.deps.logger.error(
          {
            chainId,
            code: "HEARTBEAT_WRITE_FAILED",
            error: error instanceof Error ? error.name : String(error),
          },
          "failed to write custody heartbeat"
        );
      }
    }
    return written;
  }

  private async signerMatches(chainId: number, treasuryAddress: string): Promise<boolean> {
    try {
      const account = await this.deps.accounts.resolve(chainId, treasuryAddress);
      return account.address.toLowerCase() === treasuryAddress;
    } catch {
      return false;
    }
  }

  private async gasReady(asset: TreasuryAsset): Promise<boolean> {
    let floor: bigint;
    try {
      floor = BigInt(asset.minGasAtomic);
    } catch {
      return false;
    }
    if (floor <= 0n) return false;

    const balance = await this.deps.quorum.nativeBalance(asset, asset.treasuryAddress);
    if (!balance.agreed || balance.value === null) return false;
    return balance.value >= floor;
  }
}
