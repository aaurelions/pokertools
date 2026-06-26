import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/index.js";

type PrismaClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof PrismaClient>[0]>,
  "adapter"
>;

export function createPrismaClient(options: PrismaClientOptions = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set");
  }

  const adapter =
    databaseUrl.startsWith("postgresql://") || databaseUrl.startsWith("postgres://")
      ? new PrismaPg({ connectionString: databaseUrl })
      : new PrismaBetterSqlite3({ url: databaseUrl });

  return new PrismaClient({
    ...options,
    adapter,
  });
}
