import type { FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { ObservabilityManager } from "./observability-manager.js";

export class AuditManager {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly observability?: ObservabilityManager
  ) {}

  async record(input: {
    actorId?: string;
    action: string;
    resource: string;
    request?: FastifyRequest;
    riskScore?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId,
          action: input.action,
          resource: input.resource,
          riskScore: input.riskScore ?? 0,
          ip: input.request?.ip,
          userAgent: input.request?.headers["user-agent"],
          metadata: input.metadata as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (error) {
      this.observability?.increment("pokertools_audit_log_failures_total", {
        action: input.action,
      });
      // Audit failures must be visible but must not take down gameplay.
      console.error("Audit log write failed", error);
    }
  }
}
