import type { PrismaClient } from "../../generated/prisma/index.js";

/** Legacy queued projection: never regress synchronous state or table lifecycle. */
export async function persistSnapshotProjection(
  prisma: PrismaClient,
  tableId: string,
  snapshot: { _version?: number }
): Promise<boolean> {
  const table = await prisma.table.findUnique({ where: { id: tableId } });
  if (!table || !table.state || table.status === "CLOSED") return false;
  const current = (typeof table.state === "string" ? JSON.parse(table.state) : table.state) as {
    _version?: number;
  };
  if ((current?._version ?? 0) >= (snapshot._version ?? 0)) return false;
  const result = await prisma.table.updateMany({
    where: { id: tableId, state: { equals: table.state }, status: table.status },
    data: { state: JSON.stringify(snapshot) },
  });
  return result.count === 1;
}
