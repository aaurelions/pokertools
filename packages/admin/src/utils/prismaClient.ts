import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../../api/generated/prisma/index.js";

type PrismaClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof PrismaClient>[0]>,
  "adapter"
>;

export function createPrismaClient(options: PrismaClientOptions = {}) {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:../.runtime/dev.db",
  });

  return new PrismaClient({
    ...options,
    adapter,
  });
}
