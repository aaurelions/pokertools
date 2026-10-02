import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/index.js";
import type { Principal, PrincipalKind } from "@pokertools/types";
import { AppError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Canonical principal identity + table authorization.
//
// The public/wire identity is the shared three-field `Principal`
// ({ id, kind, walletAddress }) from @pokertools/types. The API resolves
// additional, server-only authorization state onto `AuthenticatedPrincipal`
// (effective scopes, resource restrictions, operator authority). Those extras
// are never a client-selectable DTO.
//
// A durable SERVICE principal may hold several credentials (one table-scoped
// credential per room), so credentials never replace the principal identity.
// ---------------------------------------------------------------------------

export type { Principal, PrincipalKind, ServiceScope } from "@pokertools/types";

export const TABLE_SCOPES = ["table:observe", "table:act", "table:chat"] as const;
export type TableScope = (typeof TABLE_SCOPES)[number];

/** Narrow provisioning grant. Exclusive with table scopes. */
export const ORCHESTRATION_SCOPE = "competition:orchestrate" as const;
export type OrchestrationScope = typeof ORCHESTRATION_SCOPE;

export const SERVICE_SCOPES = [...TABLE_SCOPES, ORCHESTRATION_SCOPE] as const;
export type ServiceScopeName = (typeof SERVICE_SCOPES)[number];

export const ORCHESTRATION_AUTHORIZATION_REASONS = ["OK", "NO_PRINCIPAL", "SCOPE_MISSING"] as const;
export type OrchestrationAuthorizationReason = (typeof ORCHESTRATION_AUTHORIZATION_REASONS)[number];

export interface PrincipalRestrictions {
  tableId: string | null;
  seat: number | null;
}

/**
 * Server-resolved principal. Extends the shared wire contract; the extra fields
 * are authoritative server state and must never be accepted from a client.
 */
export interface AuthenticatedPrincipal extends Principal {
  role: "PLAYER" | "ADMIN" | null;
  scopes: ServiceScopeName[];
  restrictions: PrincipalRestrictions;
  /** Only true for an explicitly ADMIN wallet principal. Never for SERVICE. */
  isOperator: boolean;
  /** Present only for SERVICE principals. */
  credentialId?: string;
}

export type TableAuthorizationReason =
  "OK" | "NO_PRINCIPAL" | "SCOPE_MISSING" | "TABLE_RESTRICTED" | "SEAT_RESTRICTED";

export interface TableAuthorization {
  allowed: boolean;
  reason: TableAuthorizationReason;
}

/** Actor context for durable, transactional audit records. */
export interface CredentialAuditContext {
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateServiceCredentialInput {
  name: string;
  scopes: ServiceScopeName[];
  /** Issue for an existing durable SERVICE principal instead of creating one. */
  principalId?: string | null;
  tableId?: string | null;
  seat?: number | null;
  expiresAt?: Date | null;
  createdById?: string | null;
  /** When present, the create + audit are committed in one transaction. */
  audit?: CredentialAuditContext;
}

export interface CreatedServiceCredential {
  id: string;
  userId: string;
  name: string;
  scopes: ServiceScopeName[];
  tableId: string | null;
  seat: number | null;
  expiresAt: Date | null;
  /** Plaintext token. Returned exactly once; only its hash is persisted. */
  token: string;
}

export interface ServiceCredentialSummary {
  id: string;
  userId: string;
  name: string;
  scopes: ServiceScopeName[];
  tableId: string | null;
  seat: number | null;
  revoked: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * A durable SERVICE principal provisioned by an operator, optionally delegated
 * to an orchestration principal. The principal is a User row of kind SERVICE
 * with no wallet address.
 */
export interface ProvisionedServicePrincipal {
  principalId: string;
  name: string;
  kind: "SERVICE";
  delegatedToPrincipalId: string | null;
  createdAt: Date;
}

/**
 * Opaque service credential tokens are prefixed so they are unambiguous at the
 * authentication boundary: they must never be parsed as a wallet JWT.
 */
export const SERVICE_TOKEN_PREFIX = "ptsvc_";

const WALLET_GAMEPLAY_SCOPES: readonly TableScope[] = TABLE_SCOPES;

function isTableScope(value: unknown): value is TableScope {
  return typeof value === "string" && (TABLE_SCOPES as readonly string[]).includes(value);
}

function isServiceScopeName(value: unknown): value is ServiceScopeName {
  return typeof value === "string" && (SERVICE_SCOPES as readonly string[]).includes(value);
}

function parseScopes(raw: unknown): ServiceScopeName[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<ServiceScopeName>();
  for (const value of raw) {
    if (isServiceScopeName(value)) unique.add(value);
  }
  return [...unique];
}

const SERVICE_PRINCIPAL_NAME_PATTERN = /^[A-Za-z0-9 _.:-]+$/;

/**
 * Generate a 256-bit random service secret with a namespaced prefix.
 * base64url(32 bytes) == 256 bits of entropy, URL/header/cookie safe.
 */
export function generateServiceToken(): string {
  return `${SERVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

/** SHA-256 of the presented token. Only this digest is ever stored. */
export function hashServiceToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function isServiceToken(token: string | undefined | null): boolean {
  return typeof token === "string" && token.startsWith(SERVICE_TOKEN_PREFIX);
}

/** Project a resolved principal onto the shared three-field wire contract. */
export function toWirePrincipal(principal: AuthenticatedPrincipal): Principal {
  return {
    id: principal.id,
    kind: principal.kind,
    walletAddress: principal.walletAddress,
  };
}

export class PrincipalManager {
  constructor(private readonly prisma: PrismaClient) {}

  /** True when the presented token is an opaque service credential. */
  isServiceToken(token: string | undefined | null): boolean {
    return isServiceToken(token);
  }

  /**
   * Build a wallet principal. Returns null (fail closed) when the backing row
   * is not a WALLET or has no wallet address, so a SERVICE/virtual identity can
   * never be promoted to a wallet principal via a forged session/JWT claim.
   * Non-admin wallets get regular gameplay scopes only.
   */
  buildWalletPrincipal(user: {
    id: string;
    address: string | null;
    role: "PLAYER" | "ADMIN";
    kind?: PrincipalKind;
  }): AuthenticatedPrincipal | null {
    if (user.kind !== undefined && user.kind !== "WALLET") return null;
    if (typeof user.address !== "string" || user.address.length === 0) return null;

    return {
      id: user.id,
      kind: "WALLET",
      walletAddress: user.address,
      role: user.role,
      scopes: [...WALLET_GAMEPLAY_SCOPES],
      restrictions: { tableId: null, seat: null },
      isOperator: user.role === "ADMIN",
    };
  }

  /**
   * Resolve an opaque service credential. Returns null for any invalid state:
   * unknown token, revoked credential, expired credential, or missing backing
   * user. Lookup is by digest so the plaintext is never stored or compared.
   * `touch: false` is used for high-frequency revalidation to avoid a write.
   */
  async authenticateServiceToken(
    token: string,
    options: { touch?: boolean } = {}
  ): Promise<AuthenticatedPrincipal | null> {
    const keyHash = hashServiceToken(token);
    const credential = await this.prisma.serviceCredential.findUnique({
      where: { keyHash },
      include: { user: { select: { id: true, address: true, role: true, kind: true } } },
    });

    if (!credential || credential.revoked) return null;
    if (credential.expiresAt !== null && credential.expiresAt <= new Date()) return null;
    if (credential.user.kind !== "SERVICE") return null;

    if (options.touch !== false) {
      // Best-effort last-used telemetry; must never fail authentication.
      await this.prisma.serviceCredential
        .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    return {
      id: credential.user.id,
      kind: "SERVICE",
      walletAddress: null,
      role: null,
      scopes: parseScopes(credential.scopes),
      restrictions: {
        tableId: credential.tableId ?? null,
        seat: credential.seat ?? null,
      },
      isOperator: false,
      credentialId: credential.id,
    };
  }

  /**
   * Authorize a principal for a table scope/resource.
   *
   * `persistedSeat` is the acting/viewing seat derived from authoritative game
   * state — never a client-supplied actor seat. When a credential carries a
   * seat restriction, a missing `persistedSeat` fails closed: it is never
   * treated as "unrestricted".
   */
  authorizeTable(
    principal: AuthenticatedPrincipal | undefined | null,
    scope: TableScope,
    tableId?: string | null,
    persistedSeat?: number | null
  ): TableAuthorization {
    if (!principal) return { allowed: false, reason: "NO_PRINCIPAL" };

    // Canonical contract: table:act implies table:observe.
    const hasScope =
      principal.scopes.includes(scope) ||
      (scope === "table:observe" && principal.scopes.includes("table:act"));
    if (!hasScope) return { allowed: false, reason: "SCOPE_MISSING" };

    const restrictedTable = principal.restrictions.tableId;
    if (restrictedTable && (!tableId || tableId !== restrictedTable)) {
      return { allowed: false, reason: "TABLE_RESTRICTED" };
    }

    const restrictedSeat = principal.restrictions.seat;
    if (restrictedSeat !== null) {
      if (persistedSeat === undefined || persistedSeat === null) {
        return { allowed: false, reason: "SEAT_RESTRICTED" };
      }
      if (persistedSeat !== restrictedSeat) {
        return { allowed: false, reason: "SEAT_RESTRICTED" };
      }
    }

    return { allowed: true, reason: "OK" };
  }

  /**
   * Create a service credential. Without `principalId` a new durable SERVICE
   * principal is created; with `principalId` the credential is attached to an
   * existing SERVICE principal and no new `User` row is created. The token is
   * generated here and returned once; callers must never persist the plaintext.
   * When `audit` is supplied, the credential and its durable audit record are
   * committed atomically.
   *
   * Shape invariant: an orchestration credential carries exactly
   * `competition:orchestrate` and no resource restriction; table credentials
   * carry table scopes only. Mixing the two is rejected so a single credential
   * can never be both a room agent and a competition orchestrator.
   */
  async createServiceCredential(
    input: CreateServiceCredentialInput
  ): Promise<CreatedServiceCredential> {
    const scopes = parseScopes(input.scopes);
    if (scopes.length === 0) {
      throw new AppError(
        "At least one valid service scope is required",
        400,
        "SERVICE_SCOPE_INVALID"
      );
    }
    const tableId = input.tableId ?? null;
    const seat = input.seat ?? null;
    const hasOrchestration = scopes.includes(ORCHESTRATION_SCOPE);
    if (hasOrchestration && (scopes.length !== 1 || tableId !== null || seat !== null)) {
      throw new AppError(
        "competition:orchestrate is exclusive: it cannot be combined with table scopes or resource restrictions",
        400,
        "SERVICE_CREDENTIAL_SCOPE_CONFLICT"
      );
    }
    if (!hasOrchestration && scopes.every((scope) => !isTableScope(scope))) {
      throw new AppError("Table credentials require table scopes", 400, "SERVICE_SCOPE_INVALID");
    }

    const token = generateServiceToken();
    const keyHash = hashServiceToken(token);
    const username = `service_${crypto.randomBytes(8).toString("hex")}`;

    const credential = await this.prisma.$transaction(async (tx) => {
      let serviceUserId: string;
      if (input.principalId) {
        const existing = await tx.user.findUnique({
          where: { id: input.principalId },
          select: { id: true, kind: true },
        });
        if (!existing || existing.kind !== "SERVICE") {
          throw new AppError("SERVICE principal not found", 404, "SERVICE_PRINCIPAL_NOT_FOUND");
        }
        serviceUserId = existing.id;
      } else {
        const serviceUser = await tx.user.create({
          data: {
            username,
            address: null,
            kind: "SERVICE",
            role: "PLAYER",
          },
          select: { id: true },
        });
        serviceUserId = serviceUser.id;
      }

      const created = await tx.serviceCredential.create({
        data: {
          userId: serviceUserId,
          name: input.name,
          keyHash,
          scopes,
          tableId,
          seat,
          expiresAt: input.expiresAt ?? null,
          createdById: input.createdById ?? null,
        },
      });

      if (input.audit) {
        await tx.auditLog.create({
          data: {
            actorId: input.audit.actorId ?? null,
            action: "SERVICE_CREDENTIAL_CREATE",
            resource: `service-credential:${created.id}`,
            ip: input.audit.ip ?? null,
            userAgent: input.audit.userAgent ?? null,
            metadata: {
              name: created.name,
              scopes,
              tableId: created.tableId,
              seat: created.seat,
              serviceUserId,
            },
          },
        });
      }

      return created;
    });

    return {
      id: credential.id,
      userId: credential.userId,
      name: credential.name,
      scopes: parseScopes(credential.scopes),
      tableId: credential.tableId,
      seat: credential.seat,
      expiresAt: credential.expiresAt,
      token,
    };
  }

  /**
   * Provision a durable, named SERVICE principal. No credential is minted here:
   * credentials are issued separately so an operator controls exactly which
   * rooms a principal may act in. When `delegatedToPrincipalId` is supplied,
   * that principal (an ADMIN wallet or a SERVICE principal holding an active
   * orchestration credential) may roster the principal and issue its
   * table-scoped room credentials.
   */
  async provisionServicePrincipal(input: {
    name: string;
    delegatedToPrincipalId?: string | null;
    createdById?: string | null;
    audit?: CredentialAuditContext;
  }): Promise<ProvisionedServicePrincipal> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 64 || !SERVICE_PRINCIPAL_NAME_PATTERN.test(name)) {
      throw new AppError("Invalid service principal name", 400, "SERVICE_PRINCIPAL_NAME_INVALID");
    }

    return this.prisma.$transaction(async (tx) => {
      const existingName = await tx.user.findUnique({ where: { username: name } });
      if (existingName) {
        throw new AppError(
          "Service principal name is already taken",
          409,
          "SERVICE_PRINCIPAL_NAME_TAKEN"
        );
      }

      const delegatedToPrincipalId = input.delegatedToPrincipalId ?? null;
      if (delegatedToPrincipalId) {
        await this.assertOrchestrationDelegate(tx, delegatedToPrincipalId);
      }

      const user = await tx.user.create({
        data: { username: name, address: null, kind: "SERVICE", role: "PLAYER" },
        select: { id: true, username: true, createdAt: true },
      });

      if (delegatedToPrincipalId) {
        await tx.servicePrincipalDelegation.create({
          data: { servicePrincipalId: user.id, delegatePrincipalId: delegatedToPrincipalId },
        });
      }

      if (input.audit) {
        await tx.auditLog.create({
          data: {
            actorId: input.audit.actorId ?? null,
            action: "SERVICE_PRINCIPAL_PROVISION",
            resource: `service-principal:${user.id}`,
            ip: input.audit.ip ?? null,
            userAgent: input.audit.userAgent ?? null,
            metadata: { name: user.username, delegatedToPrincipalId },
          },
        });
      }

      return {
        principalId: user.id,
        name: user.username,
        kind: "SERVICE" as const,
        delegatedToPrincipalId,
        createdAt: user.createdAt,
      };
    });
  }

  /**
   * True when `delegatePrincipalId` is authorized for orchestration (ADMIN
   * wallet or a SERVICE principal with an active orchestration credential).
   */
  private async assertOrchestrationDelegate(
    tx: Prisma.TransactionClient,
    delegatePrincipalId: string
  ): Promise<void> {
    const delegate = await tx.user.findUnique({
      where: { id: delegatePrincipalId },
      select: { id: true, kind: true, role: true },
    });
    if (!delegate) {
      throw new AppError("Delegate principal not found", 404, "DELEGATE_PRINCIPAL_NOT_FOUND");
    }
    if (delegate.kind === "WALLET" && delegate.role === "ADMIN") return;

    const credentials = await tx.serviceCredential.findMany({
      where: { userId: delegatePrincipalId, revoked: false },
      select: { scopes: true, expiresAt: true },
    });
    const now = new Date();
    const authorized = credentials.some(
      (credential) =>
        (credential.expiresAt === null || credential.expiresAt > now) &&
        parseScopes(credential.scopes).includes(ORCHESTRATION_SCOPE)
    );
    if (!authorized) {
      throw new AppError(
        "Delegate principal does not hold orchestration authority",
        403,
        "DELEGATE_NOT_ORCHESTRATOR"
      );
    }
  }

  /**
   * Rotate one credential in place. The durable `principalId` (userId) is
   * retained and the previous secret stops working immediately. Returns null
   * when the credential does not exist.
   */
  async rotateServiceCredential(
    credentialId: string,
    input: { expiresAt?: Date | null } = {},
    audit?: CredentialAuditContext
  ): Promise<CreatedServiceCredential | null> {
    const token = generateServiceToken();
    const keyHash = hashServiceToken(token);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.serviceCredential.findUnique({ where: { id: credentialId } });
      if (!existing) return null;
      if (existing.revoked) {
        throw new AppError(
          "Revoked credentials cannot be rotated; issue a new credential",
          409,
          "SERVICE_CREDENTIAL_REVOKED"
        );
      }

      const updated = await tx.serviceCredential.update({
        where: { id: credentialId },
        data: {
          keyHash,
          lastUsedAt: null,
          expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
        },
      });

      if (audit) {
        await tx.auditLog.create({
          data: {
            actorId: audit.actorId ?? null,
            action: "SERVICE_CREDENTIAL_ROTATE",
            resource: `service-credential:${updated.id}`,
            ip: audit.ip ?? null,
            userAgent: audit.userAgent ?? null,
            metadata: { serviceUserId: updated.userId },
          },
        });
      }

      return {
        id: updated.id,
        userId: updated.userId,
        name: updated.name,
        scopes: parseScopes(updated.scopes),
        tableId: updated.tableId,
        seat: updated.seat,
        expiresAt: updated.expiresAt,
        token,
      };
    });
  }

  /**
   * Issue or rotate a narrow table-scoped credential for an existing SERVICE
   * principal. Used by competition orchestration for its own entrants; the
   * caller is responsible for the entrant/delegation/table ownership checks.
   * The credential is always bound to `tableId`; rotation requires the existing
   * credential to already be bound to the same table.
   */
  async issueScopedCredential(input: {
    principalId: string;
    tableId: string;
    name: string;
    scopes: TableScope[];
    seat?: number | null;
    expiresAt?: Date | null;
    credentialId?: string | null;
    createdById?: string | null;
    audit?: CredentialAuditContext & { metadata?: Record<string, unknown> };
  }): Promise<CreatedServiceCredential> {
    const scopes = [...new Set(input.scopes.filter(isTableScope))];
    if (scopes.length === 0) {
      throw new AppError("At least one table scope is required", 400, "SERVICE_SCOPE_INVALID");
    }
    if (!input.tableId) {
      throw new AppError(
        "Scoped credentials require a table",
        400,
        "SERVICE_CREDENTIAL_TABLE_REQUIRED"
      );
    }
    const seat = input.seat ?? null;
    if (seat !== null && (seat < 0 || seat > 9)) {
      throw new AppError("Seat restriction must be between 0 and 9", 400, "SEAT_INVALID");
    }

    const token = generateServiceToken();
    const keyHash = hashServiceToken(token);

    const credential = await this.prisma.$transaction(async (tx) => {
      const principal = await tx.user.findUnique({
        where: { id: input.principalId },
        select: { id: true, kind: true },
      });
      if (!principal || principal.kind !== "SERVICE") {
        throw new AppError("SERVICE principal not found", 404, "SERVICE_PRINCIPAL_NOT_FOUND");
      }

      let created;
      if (input.credentialId) {
        const existing = await tx.serviceCredential.findUnique({
          where: { id: input.credentialId },
        });
        if (!existing || existing.userId !== input.principalId) {
          throw new AppError(
            "Credential not found for principal",
            404,
            "SERVICE_CREDENTIAL_NOT_FOUND"
          );
        }
        if (existing.tableId !== input.tableId) {
          throw new AppError(
            "Credential is bound to a different table",
            403,
            "SERVICE_CREDENTIAL_TABLE_MISMATCH"
          );
        }
        if (existing.revoked) {
          throw new AppError(
            "Revoked credentials cannot be rotated; issue a new credential",
            409,
            "SERVICE_CREDENTIAL_REVOKED"
          );
        }
        created = await tx.serviceCredential.update({
          where: { id: existing.id },
          data: {
            keyHash,
            name: input.name,
            scopes,
            seat,
            lastUsedAt: null,
            expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
          },
        });
      } else {
        created = await tx.serviceCredential.create({
          data: {
            userId: input.principalId,
            name: input.name,
            keyHash,
            scopes,
            tableId: input.tableId,
            seat,
            expiresAt: input.expiresAt ?? null,
            createdById: input.createdById ?? null,
          },
        });
      }

      if (input.audit) {
        await tx.auditLog.create({
          data: {
            actorId: input.audit.actorId ?? null,
            action: input.credentialId ? "AGENT_CREDENTIAL_ROTATE" : "AGENT_CREDENTIAL_ISSUE",
            resource: `service-credential:${created.id}`,
            ip: input.audit.ip ?? null,
            userAgent: input.audit.userAgent ?? null,
            metadata: {
              serviceUserId: input.principalId,
              tableId: input.tableId,
              scopes,
              seat,
              ...(input.audit.metadata ?? {}),
            },
          },
        });
      }

      return created;
    });

    return {
      id: credential.id,
      userId: credential.userId,
      name: credential.name,
      scopes: parseScopes(credential.scopes),
      tableId: credential.tableId,
      seat: credential.seat,
      expiresAt: credential.expiresAt,
      token,
    };
  }

  /**
   * Durable delegation check: may `delegatePrincipalId` provision/credential
   * this SERVICE principal? Revoked delegations fail closed.
   */
  async isServicePrincipalDelegatedTo(
    servicePrincipalId: string,
    delegatePrincipalId: string
  ): Promise<boolean> {
    const delegation = await this.prisma.servicePrincipalDelegation.findUnique({
      where: { servicePrincipalId },
    });
    return (
      delegation !== null &&
      delegation.revokedAt === null &&
      delegation.delegatePrincipalId === delegatePrincipalId
    );
  }

  /** True when the principal may orchestrate competitions (ADMIN or grant). */
  authorizeOrchestration(principal: AuthenticatedPrincipal | undefined | null): {
    allowed: boolean;
    reason: OrchestrationAuthorizationReason;
  } {
    if (!principal) return { allowed: false, reason: "NO_PRINCIPAL" };
    if (principal.isOperator) return { allowed: true, reason: "OK" };
    if (principal.scopes.includes(ORCHESTRATION_SCOPE)) return { allowed: true, reason: "OK" };
    return { allowed: false, reason: "SCOPE_MISSING" };
  }

  /**
   * Revoke a credential. Returns false when it does not exist. The revocation
   * and its audit record commit atomically when `audit` is supplied.
   */
  async revokeServiceCredential(
    credentialId: string,
    audit?: CredentialAuditContext
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.serviceCredential.findUnique({
        where: { id: credentialId },
        select: { id: true, revoked: true },
      });
      if (!existing) return false;
      if (!existing.revoked) {
        await tx.serviceCredential.update({
          where: { id: credentialId },
          data: { revoked: true, revokedAt: new Date() },
        });
        if (audit) {
          await tx.auditLog.create({
            data: {
              actorId: audit.actorId ?? null,
              action: "SERVICE_CREDENTIAL_REVOKE",
              resource: `service-credential:${credentialId}`,
              ip: audit.ip ?? null,
              userAgent: audit.userAgent ?? null,
            },
          });
        }
      }
      return true;
    });
  }

  async listServiceCredentials(): Promise<ServiceCredentialSummary[]> {
    const credentials = await this.prisma.serviceCredential.findMany({
      orderBy: { createdAt: "desc" },
    });
    return credentials.map((credential) => ({
      id: credential.id,
      userId: credential.userId,
      name: credential.name,
      scopes: parseScopes(credential.scopes),
      tableId: credential.tableId,
      seat: credential.seat,
      revoked: credential.revoked,
      expiresAt: credential.expiresAt,
      lastUsedAt: credential.lastUsedAt,
      revokedAt: credential.revokedAt,
      createdAt: credential.createdAt,
    }));
  }
}
