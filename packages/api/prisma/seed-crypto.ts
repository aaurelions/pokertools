import { createPrismaClient } from "../src/utils/prisma-client.js";

const prisma = createPrismaClient();

/**
 * Canonical crypto configuration seed.
 *
 * The legacy AdminWallet/Blockchain/Token (derived-address custodial deposits)
 * fixtures have been removed. Canonical deposits verify a direct-treasury
 * ERC-20 transfer against an `Asset` row, so this seed writes `Asset` fixtures
 * only.
 *
 * These are LOCAL DEVELOPMENT fixtures pointing at an Anvil node. They use a
 * clearly marked placeholder treasury and are safe to re-run. Deployed
 * environments must provision real `Asset` rows (treasury address, at least two
 * independent RPC endpoints per chain) through the operator tooling.
 */
const DEV_CHAIN_ID = 31337;
const DEV_TREASURY = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const DEV_RPC_URLS = ["http://127.0.0.1:8545", "http://127.0.0.1:8546"];

interface AssetFixture {
  id: string;
  tokenAddress: string;
  symbol: string;
  decimals: number;
  minGasAtomic: string;
}

const DEV_ASSETS: AssetFixture[] = [
  {
    id: `eip155:${DEV_CHAIN_ID}/erc20:0x5fbdb2315678afecb367f032d93f642f64180aa3`,
    tokenAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    symbol: "USDC",
    decimals: 6,
    minGasAtomic: "0",
  },
];

async function main() {
  console.log("🌱 Starting canonical crypto configuration seed...");

  for (const asset of DEV_ASSETS) {
    const record = await prisma.asset.upsert({
      where: { id: asset.id },
      create: {
        id: asset.id,
        chainId: DEV_CHAIN_ID,
        tokenAddress: asset.tokenAddress,
        symbol: asset.symbol,
        decimals: asset.decimals,
        status: "ACTIVE",
        confirmations: 1,
        deepFinality: 3,
        treasuryAddress: DEV_TREASURY,
        rpcUrls: DEV_RPC_URLS,
        minGasAtomic: asset.minGasAtomic,
      },
      update: {},
    });
    console.log(`✅ Asset configured: ${record.id}`);
  }

  const assetCount = await prisma.asset.count();
  console.log("\n📊 Canonical Crypto Configuration Summary:");
  console.log(`   - Assets: ${assetCount}`);
  console.log(
    "\n⚠️  These are local dev fixtures. Provision real treasury/RPC assets before deploying!"
  );
  console.log("🌱 Canonical crypto seeding completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
