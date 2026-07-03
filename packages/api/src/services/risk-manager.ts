import type { Redis } from "ioredis";
import type { FastifyRequest } from "fastify";
import { config } from "../config.js";

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
    const windowMs = config.RISK_SCORING_WINDOW_MS;
    const key = `risk:${input.endpoint}:${input.userId}`;
    const ipKey = `risk:${input.endpoint}:ip:${input.request.ip}`;

    const [userCount, ipCount] = await Promise.all([
      this.hit(key, now, windowMs),
      this.hit(ipKey, now, windowMs),
    ]);

    const amount = input.amountCents ?? 0;
    let score = 0;
    if (userCount > config.RISK_USER_COUNT_THRESHOLD) score += config.RISK_USER_COUNT_SCORE;
    if (ipCount > config.RISK_IP_COUNT_THRESHOLD) score += config.RISK_IP_COUNT_SCORE;
    if (amount >= config.RISK_MEDIUM_AMOUNT_CENTS_THRESHOLD)
      score += config.RISK_MEDIUM_AMOUNT_CENTS_SCORE;
    if (amount >= config.RISK_HIGH_AMOUNT_CENTS_THRESHOLD)
      score += config.RISK_HIGH_AMOUNT_CENTS_SCORE;

    const blocked =
      userCount > this.userLimit(input.endpoint) ||
      ipCount > this.ipLimit(input.endpoint) ||
      score >= config.RISK_SCORE_THRESHOLD;

    if (blocked) {
      throw new RiskDeniedError("Request blocked by velocity/risk controls", score);
    }

    return { score };
  }

  private userLimit(endpoint: string): number {
    if (endpoint === "withdraw") return config.RISK_WITHDRAW_USER_LIMIT;
    if (endpoint === "buy-in" || endpoint === "add-chips") return config.RISK_BUY_IN_USER_LIMIT;
    return config.RISK_ACTION_USER_LIMIT;
  }

  private ipLimit(endpoint: string): number {
    if (endpoint === "withdraw") return config.RISK_WITHDRAW_IP_LIMIT;
    if (endpoint === "buy-in" || endpoint === "add-chips") return config.RISK_BUY_IN_IP_LIMIT;
    return config.RISK_ACTION_IP_LIMIT;
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
