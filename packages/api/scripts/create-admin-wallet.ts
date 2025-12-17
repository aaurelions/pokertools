#!/usr/bin/env tsx
/**
 * Create an encrypted AdminWallet entry
 *
 * Usage: npx tsx scripts/create-admin-wallet.ts <label> <xpub>
 *
 * Example:
 *   npx tsx scripts/create-admin-wallet.ts "Production Hot Wallet" "xpub6CUGRUonZS..."
 */

import { PrismaClient } from "../generated/prisma/index.js";
import { encryptXpub } from "../src/utils/crypto.js";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.error("Usage: npx tsx scripts/create-admin-wallet.ts <label> <xpub>");
    process.exit(1);
  }

  const [label, xpub] = args;

  // Validate xpub format (basic check)
  if (!xpub.startsWith("xpub")) {
    console.error("Error: xpub must start with 'xpub'");
    process.exit(1);
  }

  // Encrypt xpub before storing
  const encryptedXpub = encryptXpub(xpub);

  const wallet = await prisma.adminWallet.create({
    data: {
      label,
      xpub: encryptedXpub,
      derivationPath: "m/44'/60'/0'/0",
      currentIndex: 0,
      isActive: true,
    },
  });

  console.log(`✅ AdminWallet created:`);
  console.log(`   ID: ${wallet.id}`);
  console.log(`   Label: ${wallet.label}`);
  console.log(`   Encrypted: Yes (AES-256-GCM)`);
  console.log(`   Derivation Path: ${wallet.derivationPath}`);
  console.log(`   Current Index: ${wallet.currentIndex}`);
}

main()
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
