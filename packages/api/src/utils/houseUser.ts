import { PrismaClient } from "../../generated/prisma/index.js";

/**
 * Cache for house user ID to avoid repeated DB lookups
 */
let cachedHouseUserId: string | null = null;

/**
 * Get the house user ID dynamically by looking up the user with username "HOUSE"
 * Results are cached after first lookup for performance
 */
export async function getHouseUserId(prisma: PrismaClient): Promise<string> {
  if (cachedHouseUserId) {
    return cachedHouseUserId;
  }

  const houseUser = await prisma.user.findFirst({
    where: {
      OR: [
        { username: "HOUSE" },
        { role: "ADMIN", address: "0x0000000000000000000000000000000000000000" },
      ],
    },
    select: { id: true },
  });

  if (!houseUser) {
    throw new Error("House user not found. Please run 'npm run seed' to initialize the database.");
  }

  cachedHouseUserId = houseUser.id;
  return cachedHouseUserId;
}

/**
 * Clear the cached house user ID (useful for testing)
 */
export function clearHouseUserCache(): void {
  cachedHouseUserId = null;
}
