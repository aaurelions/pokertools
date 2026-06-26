import type { FastifyInstance, FastifyRequest } from "fastify";

export type HealthStatus = "ok" | "degraded" | "down";

interface Counter {
  help: string;
  values: Map<string, number>;
}

export class ObservabilityManager {
  private readonly counters = new Map<string, Counter>();
  private readonly startedAt = Date.now();

  constructor(private readonly app: FastifyInstance) {
    this.createCounter("pokertools_http_requests_total", "HTTP requests observed by the API");
    this.createCounter("pokertools_game_actions_total", "Game actions processed by table endpoint");
    this.createCounter(
      "pokertools_risk_denials_total",
      "Requests blocked by fraud/velocity controls"
    );
    this.createCounter("pokertools_idempotency_hits_total", "Durable idempotency replay hits");
    this.createCounter("pokertools_audit_log_failures_total", "Audit log write failures");
  }

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const counter = this.counters.get(name);
    if (!counter) return;
    const key = this.labelKey(labels);
    counter.values.set(key, (counter.values.get(key) ?? 0) + value);
  }

  async health() {
    const checks = {
      db: await this.check("db", () => this.app.prisma.$queryRaw`SELECT 1`),
      redis: await this.check("redis", () => this.app.redis.ping()),
      queue: await this.check("queue", () => this.app.queue.getJobCounts()),
    };

    const statuses = Object.values(checks).map((c) => c.status);
    const status: HealthStatus = statuses.includes("down")
      ? "down"
      : statuses.includes("degraded")
        ? "degraded"
        : "ok";

    const [waiting, delayed, failed] = await Promise.all([
      this.app.queue.getWaitingCount().catch(() => -1),
      this.app.queue.getDelayedCount().catch(() => -1),
      this.app.queue.getFailedCount().catch(() => -1),
    ]);

    return {
      status,
      timestamp: Date.now(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
      queues: { gameEvents: { waiting, delayed, failed } },
    };
  }

  metrics(): string {
    const lines = [
      "# HELP pokertools_process_uptime_seconds Process uptime in seconds",
      "# TYPE pokertools_process_uptime_seconds gauge",
      `pokertools_process_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
    ];

    for (const [name, counter] of this.counters) {
      lines.push(`# HELP ${name} ${counter.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labelKey, value] of counter.values) {
        lines.push(`${name}${labelKey} ${value}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }

  attachHttpMetrics(): void {
    this.app.addHook("onResponse", async (request, reply) => {
      this.increment("pokertools_http_requests_total", {
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: String(reply.statusCode),
      });
    });
  }

  requestContext(request: FastifyRequest) {
    return {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    };
  }

  private createCounter(name: string, help: string): void {
    this.counters.set(name, { help, values: new Map([["", 0]]) });
  }

  private labelKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "";
    return `{${entries.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",")}}`;
  }

  private async check(name: string, fn: () => Promise<unknown>) {
    const started = Date.now();
    try {
      await fn();
      const latencyMs = Date.now() - started;
      return { status: latencyMs > 1000 ? "degraded" : "ok", latencyMs } as const;
    } catch (error) {
      this.app.log.error({ error, check: name }, "Health check failed");
      return { status: "down", latencyMs: Date.now() - started } as const;
    }
  }
}
