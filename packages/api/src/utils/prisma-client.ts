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

  // ---------------------------------------------------------------------------
  // Production safety gate: reject file: SQLite URLs in production.
  // The Docker entrypoint also enforces this, but this is a defence-in-depth
  // layer that catches the misconfiguration the moment the Prisma adapter is
  // initialised, before any queries run.
  // ---------------------------------------------------------------------------
  if (process.env.NODE_ENV === "production" && databaseUrl.startsWith("file:")) {
    throw new Error(
      "SQLite (file:…) DATABASE_URL is not allowed in production. " +
        "Set DATABASE_URL to a PostgreSQL connection string (postgresql://…)."
    );
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
