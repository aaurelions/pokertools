import WebSocket from "ws";
import { Queue } from "bullmq";

interface Result {
  name: string;
  count: number;
  ok: number;
  failed: number;
  p50: number;
  p95: number;
  max: number;
}

const API_BASE = process.env.POKERTOOLS_API_BASE ?? "http://localhost:3000";
const WS_URL = process.env.POKERTOOLS_WS_URL ?? API_BASE.replace(/^http/, "ws") + "/ws/play";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 30_000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 16);
const TOKEN = process.env.POKERTOOLS_TOKEN;
const TABLE_ID = process.env.POKERTOOLS_TABLE_ID;

async function timed(
  name: string,
  fn: () => Promise<void>,
  durationMs = DURATION_MS
): Promise<Result> {
  const latencies: number[] = [];
  let ok = 0;
  let failed = 0;
  const end = Date.now() + durationMs;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < end) {
        const started = performance.now();
        try {
          await fn();
          ok++;
        } catch {
          failed++;
        } finally {
          latencies.push(performance.now() - started);
        }
      }
    })
  );

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => Math.round(latencies[Math.floor(latencies.length * p)] ?? 0);
  return {
    name,
    count: latencies.length,
    ok,
    failed,
    p50: pct(0.5),
    p95: pct(0.95),
    max: Math.round(latencies.at(-1) ?? 0),
  };
}

async function apiHealth(): Promise<Result> {
  return timed("api:/health", async () => {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

async function gameActions(): Promise<Result | null> {
  if (!TOKEN || !TABLE_ID) return null;
  const actions = ["CHECK", "CALL", "FOLD"] as const;
  let i = 0;
  return timed("game:actions", async () => {
    const res = await fetch(`${API_BASE}/tables/${TABLE_ID}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        type: actions[i++ % actions.length],
        idempotencyKey: `bench-${Date.now()}-${i}`,
      }),
    });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  });
}

async function sockets(): Promise<Result | null> {
  if (!TOKEN || !TABLE_ID) return null;
  return timed(
    "sockets:connect_join",
    async () =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(WS_URL, ["pokertools", `jwt.${TOKEN}`]);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("socket timeout"));
        }, 5_000);
        ws.on("open", () => ws.send(JSON.stringify({ type: "JOIN", tableId: TABLE_ID })));
        ws.on("message", () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        });
        ws.on("error", reject);
      }),
    Math.min(DURATION_MS, 15_000)
  );
}

async function workers(): Promise<Result> {
  const queue = new Queue("game-events", { connection: { url: REDIS_URL } });
  try {
    return timed("workers:queue_depth", async () => {
      await queue.getJobCounts("waiting", "delayed", "active", "failed");
    });
  } finally {
    await queue.close();
  }
}

function print(results: Array<Result | null>) {
  console.log("name,count,ok,failed,p50_ms,p95_ms,max_ms");
  for (const r of results) {
    if (!r) continue;
    console.log(`${r.name},${r.count},${r.ok},${r.failed},${r.p50},${r.p95},${r.max}`);
  }
}

Promise.all([apiHealth(), workers(), sockets(), gameActions()])
  .then(print)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
