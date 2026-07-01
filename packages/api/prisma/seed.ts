import { createId } from "@paralleldrive/cuid2";
import { createPrismaClient } from "../src/utils/prisma-client.js";

const prisma = createPrismaClient();

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

  // 2. Create House MAIN Account (Where Rake goes)
  const houseAccount = await prisma.account.upsert({
    where: {
      userId_currency_type: {
        userId: houseUser.id,
        currency: "USDC",
        type: "MAIN", // Rake is realized profit, goes to MAIN
      },
    },
    create: {
      userId: houseUser.id,
      currency: "USDC",
      type: "MAIN",
      balance: 0, // Start at 0
    },
    update: {},
  });

  console.log(`✅ House Account ensured: ${houseAccount.id}`);

  // 3. Create House system accounts that act as the counterparty for external
  //    money flows (deposits/withdrawals) and tournament escrow. These make the
  //    ledger fully double-entry: SUM(all account balances) == 0.
  for (const type of ["HOUSE_RESERVE", "TOURNAMENT_ESCROW"] as const) {
    const sysAccount = await prisma.account.upsert({
      where: {
        userId_currency_type: { userId: houseUser.id, currency: "USDC", type },
      },
      create: { userId: houseUser.id, currency: "USDC", type, balance: 0 },
      update: {},
    });
    console.log(`✅ House ${type} Account ensured: ${sysAccount.id}`);
  }

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
