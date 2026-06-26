import type { Redis } from "ioredis";
import type { FastifyRequest } from "fastify";

export class RiskDeniedError extends Error {
  statusCode = 429;
  code = "RISK_DENIED";
  constructor(
    message: string,
    public readonly score: number
  ) {
    super(message);
  }
}

export class RiskManager {
  constructor(private readonly redis: Redis) {}

  async assertAllowed(input: {
    userId: string;
    endpoint: string;
    request: FastifyRequest;
    amountCents?: number;
  }): Promise<{ score: number }> {
    const now = Date.now();
    const windowMs = 60_000;
    const key = `risk:${input.endpoint}:${input.userId}`;
    const ipKey = `risk:${input.endpoint}:ip:${input.request.ip}`;

    const [userCount, ipCount] = await Promise.all([
      this.hit(key, now, windowMs),
      this.hit(ipKey, now, windowMs),
    ]);

    let score = 0;
    if (userCount > 20) score += 40;
    if (ipCount > 80) score += 25;
    if ((input.amountCents ?? 0) >= 100_000) score += 20;
    if ((input.amountCents ?? 0) >= 500_000) score += 30;

    const blocked =
      userCount > this.userLimit(input.endpoint) ||
      ipCount > this.ipLimit(input.endpoint) ||
      score >= 70;

    if (blocked) {
      throw new RiskDeniedError("Request blocked by velocity/risk controls", score);
    }

    return { score };
  }

  private userLimit(endpoint: string): number {
    if (endpoint === "withdraw") return 5;
    if (endpoint === "buy-in" || endpoint === "add-chips") return 12;
    return 60;
  }

  private ipLimit(endpoint: string): number {
    if (endpoint === "withdraw") return 20;
    if (endpoint === "buy-in" || endpoint === "add-chips") return 40;
    return 200;
  }

  private async hit(key: string, now: number, windowMs: number): Promise<number> {
    const member = `${now}:${Math.random()}`;
    const multi = this.redis.multi();
    multi.zadd(key, now, member);
    multi.zremrangebyscore(key, 0, now - windowMs);
    multi.zcard(key);
    multi.expire(key, Math.ceil(windowMs / 1000) * 2);
    const result = await multi.exec();
    return Number(result?.[2]?.[1] ?? 0);
  }
}
