/**
 * Asset/auth fixtures for acceptance.
 *
 * Configuration fixtures are allowed; balances are not. These helpers write the
 * shared Asset model (the planned API implementation persists `Asset` rows) so
 * API/custody code can resolve treasury address, RPC pool and finality depths.
 */
import type { Address } from "viem";

export interface AssetFixtureInput {
  assetId: string;
  chainId: number;
  tokenAddress: Address;
  symbol: string;
  decimals: number;
  treasuryAddress: Address;
  rpcUrls: string[];
  minGasAtomic?: string;
  confirmations?: number;
  deepFinality?: number;
  status?: "ACTIVE" | "DEGRADED" | "FROZEN";
}

export function assetRow(input: AssetFixtureInput) {
  return {
    id: input.assetId,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    symbol: input.symbol,
    decimals: input.decimals,
    status: input.status ?? "ACTIVE",
    confirmations: input.confirmations ?? 1,
    deepFinality: input.deepFinality ?? 3,
    treasuryAddress: input.treasuryAddress.toLowerCase(),
    rpcUrls: input.rpcUrls,
    minGasAtomic: input.minGasAtomic ?? "0",
  };
}

export async function createAssetFixture(
  prisma: { asset: { create: (args: { data: unknown }) => Promise<unknown> } },
  input: AssetFixtureInput
): Promise<unknown> {
  return prisma.asset.create({ data: assetRow(input) });
}

/**
 * Test isolation across acceptance files that share one disposable database:
 * close any incident left open by a previous file so chain-scoped admission
 * checks (`Asset or chain has an open critical incident`) do not bleed across
 * independent scenarios. Never touches journal history or balances.
 */
export async function resolveAllOpenIncidents(prisma: {
  financialIncident: { updateMany: (args: unknown) => Promise<unknown> };
}): Promise<void> {
  await prisma.financialIncident.updateMany({
    where: { status: { not: "RESOLVED" } },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      operatorId: "acceptance-file-isolation",
      operatorEvidence: { note: "closed between independent acceptance files" },
    },
  });
}
