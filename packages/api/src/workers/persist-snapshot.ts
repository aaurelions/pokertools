import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { createPrismaClient } from "../utils/prisma-client.js";

const prisma = createPrismaClient();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Persist Snapshot Worker (legacy write-behind projection).
 *
 * Game mutations are now persisted synchronously inside the DB CAS
 * transaction, so this queued projection is redundant. It is retained only as a
 * defensive reconciliation and must never regress the authoritative snapshot
 * version nor reopen/close a table lifecycle.
 */
const worker = new Worker(
  "persist-snapshot",
  async (job) => {
    const { tableId, version, snapshot } = job.data as {
      tableId: string;
      version?: number;
      snapshot?: { _version?: number };
    };

    const table = await prisma.table.findUnique({
      where: { id: tableId },
      select: { state: true, status: true, stateVersion: true },
    });
    if (!table || table.status === "CLOSED") return;

    const incomingVersion = version ?? snapshot?._version ?? 0;
    // The authoritative row already committed at (or beyond) this version.
    if (table.stateVersion >= incomingVersion) return;

    // A legacy caller may still ship the snapshot; only apply it if it is newer
    // and available. Otherwise there is nothing to reconcile.
    if (!snapshot) return;
    const result = await prisma.table.updateMany({
      where: { id: tableId, stateVersion: table.stateVersion, status: table.status },
      data: {
        state: JSON.stringify(snapshot),
        stateVersion: incomingVersion,
      },
    });
    if (result.count === 1) {
      console.log(`💾 Reconciled snapshot for table ${tableId} to version ${incomingVersion}`);
    }
  },
  { connection: redis }
);

worker.on("failed", (job, err) => {
  console.error(`❌ persist-snapshot job ${job?.id} failed:`, err);
});

export default worker;
