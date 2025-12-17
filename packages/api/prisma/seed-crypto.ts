import { PrismaClient } from "../generated/prisma/index.js";
import { HDKey } from "@scure/bip32";

const prisma = new PrismaClient();

/**
 * Generate a test HD wallet xPub for development
 * WARNING: DO NOT use this in production. Generate a real xPub from a secure HD wallet.
 *
 * For production, use hardware wallet or secure key management:
 * 1. Generate a BIP-39 mnemonic
 * 2. Derive the master key: m/44'/60'/0'/0
 * 3. Export the xPub (extended public key) only
 * 4. Store the xPub in the database
 * 5. Keep the private keys in cold storage
 */
function generateTestXPub(): string {
  // This is a TEST xPub derived from a well-known test mnemonic
  // "test test test test test test test test test test test junk"
  // DO NOT use in production
  const testXpub =
    "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
  return testXpub;
}

async function main() {
  console.log("🌱 Starting crypto configuration seed...");

  // ============================================================================
  // 1. Create Admin Wallet (with test xPub)
  // ============================================================================

  const testXpub = generateTestXPub();

  const adminWallet = await prisma.adminWallet.upsert({
    where: { id: "dev_wallet_1" },
    create: {
      id: "dev_wallet_1",
      label: "Development Wallet 2025",
      xpub: testXpub,
      derivationPath: "m/44'/60'/0'/0",
      currentIndex: 0,
      isActive: true,
    },
    update: {},
  });

  console.log(`✅ Admin Wallet configured: ${adminWallet.id}`);

  // ============================================================================
  // 2. Configure Blockchains
  // ============================================================================

  // Ethereum Mainnet (using public RPC for testing)
  const ethereum = await prisma.blockchain.upsert({
    where: { chainId: 1 },
    create: {
      name: "Ethereum",
      chainId: 1,
      rpcUrl: "https://eth.llamarpc.com",
      explorerUrl: "https://etherscan.io",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      isEnabled: true,
      confirmations: 12,
    },
    update: {},
  });

  console.log(`✅ Blockchain configured: ${ethereum.name}`);

  // Polygon (POL) - Lower fees, good for production
  const polygon = await prisma.blockchain.upsert({
    where: { chainId: 137 },
    create: {
      name: "Polygon",
      chainId: 137,
      rpcUrl: "https://polygon-rpc.com",
      explorerUrl: "https://polygonscan.com",
      nativeCurrency: {
        name: "Polygon",
        symbol: "POL",
        decimals: 18,
      },
      isEnabled: true,
      confirmations: 12,
    },
    update: {},
  });

  console.log(`✅ Blockchain configured: ${polygon.name}`);

  // Arbitrum - Layer 2, low fees
  const arbitrum = await prisma.blockchain.upsert({
    where: { chainId: 42161 },
    create: {
      name: "Arbitrum One",
      chainId: 42161,
      rpcUrl: "https://arb1.arbitrum.io/rpc",
      explorerUrl: "https://arbiscan.io",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      isEnabled: true,
      confirmations: 10,
    },
    update: {},
  });

  console.log(`✅ Blockchain configured: ${arbitrum.name}`);

  // Base - Coinbase L2, excellent for production
  const base = await prisma.blockchain.upsert({
    where: { chainId: 8453 },
    create: {
      name: "Base",
      chainId: 8453,
      rpcUrl: "https://mainnet.base.org",
      explorerUrl: "https://basescan.org",
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
      },
      isEnabled: true,
      confirmations: 10,
    },
    update: {},
  });

  console.log(`✅ Blockchain configured: ${base.name}`);

  // ============================================================================
  // 3. Configure Tokens
  // ============================================================================

  // USDC on Ethereum
  const usdcEth = await prisma.token.upsert({
    where: {
      blockchainId_address: {
        blockchainId: ethereum.id,
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
    },
    create: {
      blockchainId: ethereum.id,
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      minDeposit: "10000000", // 10 USDC minimum
      isEnabled: true,
    },
    update: {},
  });

  console.log(`✅ Token configured: ${usdcEth.symbol} on ${ethereum.name}`);

  // USDC on Polygon
  const usdcPolygon = await prisma.token.upsert({
    where: {
      blockchainId_address: {
        blockchainId: polygon.id,
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      },
    },
    create: {
      blockchainId: polygon.id,
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      minDeposit: "10000000", // 10 USDC minimum
      isEnabled: true,
    },
    update: {},
  });

  console.log(`✅ Token configured: ${usdcPolygon.symbol} on ${polygon.name}`);

  // USDC on Arbitrum
  const usdcArbitrum = await prisma.token.upsert({
    where: {
      blockchainId_address: {
        blockchainId: arbitrum.id,
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      },
    },
    create: {
      blockchainId: arbitrum.id,
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      minDeposit: "10000000", // 10 USDC minimum
      isEnabled: true,
    },
    update: {},
  });

  console.log(`✅ Token configured: ${usdcArbitrum.symbol} on ${arbitrum.name}`);

  // USDC on Base
  const usdcBase = await prisma.token.upsert({
    where: {
      blockchainId_address: {
        blockchainId: base.id,
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
    },
    create: {
      blockchainId: base.id,
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      minDeposit: "10000000", // 10 USDC minimum
      isEnabled: true,
    },
    update: {},
  });

  console.log(`✅ Token configured: ${usdcBase.symbol} on ${base.name}`);

  // USDT on Ethereum (optional, another popular stablecoin)
  const usdtEth = await prisma.token.upsert({
    where: {
      blockchainId_address: {
        blockchainId: ethereum.id,
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      },
    },
    create: {
      blockchainId: ethereum.id,
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
      minDeposit: "10000000", // 10 USDT minimum
      isEnabled: true,
    },
    update: {},
  });

  console.log(`✅ Token configured: ${usdtEth.symbol} on ${ethereum.name}`);

  // ============================================================================
  // Summary
  // ============================================================================

  const blockchainCount = await prisma.blockchain.count();
  const tokenCount = await prisma.token.count();

  console.log("\n📊 Crypto Configuration Summary:");
  console.log(`   - Blockchains: ${blockchainCount}`);
  console.log(`   - Tokens: ${tokenCount}`);
  console.log(`   - Admin Wallet: ${adminWallet.label}`);
  console.log("\n⚠️  IMPORTANT: Replace test xPub with production xPub before deploying!");
  console.log("🌱 Crypto seeding completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
