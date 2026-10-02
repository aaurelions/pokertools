import { createId } from "@paralleldrive/cuid2";
import { createPrismaClient } from "../src/utils/prisma-client.js";
import { ChipLedger } from "../src/services/chip-ledger.js";

const prisma = createPrismaClient();

/**
 * Canonical dev principal + chip fixtures. Chips are integer gameplay units
 * funded only through an explicit operator grant (`ChipGrant` + journal row),
 * mirroring production. Idempotent: a re-run reuses the same grant.
 */
const DEV_PRINCIPAL = {
  username: "DEV_PLAYER",
  address: "0x1111111111111111111111111111111111111111",
};
const DEV_CHIP_GRANT = 10_000n;

async function main() {
  console.log("🌱 Starting database seed...");

  // 1. Create System House User (query by username for idempotency)
  let houseUser = await prisma.user.findUnique({
    where: { username: "HOUSE" },
  });

  if (!houseUser) {
    houseUser = await prisma.user.create({
      data: {
        id: createId(), // Proper CUID
        username: "HOUSE",
        address: "0x0000000000000000000000000000000000000000", // Null address
        role: "ADMIN",
      },
    });
    console.log(`✅ House User created: ${houseUser.id}`);
  } else {
    console.log(`✅ House User already exists: ${houseUser.id}`);
  }

  // 2. Canonical principal + chip fixture for local development.
  const devPrincipal = await prisma.user.upsert({
    where: { username: DEV_PRINCIPAL.username },
    create: {
      username: DEV_PRINCIPAL.username,
      address: DEV_PRINCIPAL.address,
      role: "PLAYER",
      kind: "WALLET",
    },
    update: {},
  });

  const ledger = new ChipLedger(prisma);
  await prisma.$transaction(async (tx) => {
    await ledger.grant(tx, {
      principalId: devPrincipal.id,
      amount: DEV_CHIP_GRANT,
      reason: "dev seed fixture",
      operatorId: houseUser.id,
      idempotencyKey: `seed:${DEV_PRINCIPAL.username}:grant`,
    });
  });
  console.log(`✅ Canonical dev principal ${devPrincipal.username} funded with chips`);

  console.log("🌱 Seeding completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
