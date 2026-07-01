import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";

export class IdempotencyConflictError extends Error {
  statusCode = 409;
  code = "IDEMPOTENCY_CONFLICT";
}

export class IdempotencyInProgressError extends Error {
  statusCode = 409;
  code = "IDEMPOTENCY_IN_PROGRESS";
}

export class IdempotencyManager {
  constructor(private readonly prisma: PrismaClient) {}

  hash(payload: unknown): string {
    return crypto.createHash("sha256").update(this.stable(payload)).digest("hex");
  }

  async run<T extends Record<string, unknown>>(input: {
    key: string;
    scope: string;
    userId: string;
    requestHash: string;
    ttlSeconds?: number;
    handler: () => Promise<T>;
  }): Promise<{ replayed: boolean; response: T }> {
    const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 86_400) * 1000);
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope: input.scope, key: input.key } },
    });

    if (existing) return this.resolveExisting<T>(existing, input.userId, input.requestHash);

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key: input.key,
          scope: input.scope,
          userId: input.userId,
          requestHash: input.requestHash,
          expiresAt,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const raced = await this.prisma.idempotencyRecord.findUniqueOrThrow({
          where: { scope_key: { scope: input.scope, key: input.key } },
        });
        return this.resolveExisting<T>(raced, input.userId, input.requestHash);
      }
      throw error;
    }

    try {
      const response = await input.handler();
      await this.prisma.idempotencyRecord.update({
        where: { scope_key: { scope: input.scope, key: input.key } },
        data: { status: "COMPLETED", response: response as Prisma.InputJsonValue, statusCode: 200 },
      });
      return { replayed: false, response };
    } catch (error) {
      await this.prisma.idempotencyRecord
        .update({
          where: { scope_key: { scope: input.scope, key: input.key } },
          data: { status: "FAILED", errorCode: error instanceof Error ? error.message : "unknown" },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private stable(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => this.stable(v)).join(",")}]`;
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${this.stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }

  private resolveExisting<T extends Record<string, unknown>>(
    existing: { userId: string; requestHash: string; status: string; response: unknown },
    userId: string,
    requestHash: string
  ): { replayed: boolean; response: T } {
    if (existing.userId !== userId || existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        "Idempotency key was already used for a different request"
      );
    }
    if (existing.status === "COMPLETED" && existing.response) {
      return { replayed: true, response: existing.response as T };
    }
    throw new IdempotencyInProgressError("A request with this idempotency key is still processing");
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    );
  }
}
