import crypto from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { Principal, PrincipalKind, ServiceScope } from "@pokertools/types";

// ---------------------------------------------------------------------------
// Canonical principal identity + table authorization.
//
// The public/wire identity is the shared three-field `Principal`
// ({ id, kind, walletAddress }) from @pokertools/types. The API resolves
// additional, server-only authorization state onto `AuthenticatedPrincipal`
// (effective scopes, resource restrictions, operator authority). Those extras
// are never a client-selectable DTO.
// ---------------------------------------------------------------------------

export type { Principal, PrincipalKind, ServiceScope } from "@pokertools/types";

export const TABLE_SCOPES = ["table:observe", "table:act", "table:chat"] as const;
export type TableScope = ServiceScope;

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
  scopes: TableScope[];
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
  scopes: TableScope[];
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
  scopes: TableScope[];
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
  scopes: TableScope[];
  tableId: string | null;
  seat: number | null;
  revoked: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
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

function parseScopes(raw: unknown): TableScope[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<TableScope>();
  for (const value of raw) {
    if (isTableScope(value)) unique.add(value);
  }
  return [...unique];
}

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
   * Create a service credential and its backing SERVICE identity. The token is
   * generated here and returned once; callers must never persist the plaintext.
   * When `audit` is supplied, the credential and its durable audit record are
   * committed atomically.
   */
  async createServiceCredential(
    input: CreateServiceCredentialInput
  ): Promise<CreatedServiceCredential> {
    const token = generateServiceToken();
    const keyHash = hashServiceToken(token);
    const username = `service_${crypto.randomBytes(8).toString("hex")}`;

    const credential = await this.prisma.$transaction(async (tx) => {
      const serviceUser = await tx.user.create({
        data: {
          username,
          address: null,
          kind: "SERVICE",
          role: "PLAYER",
        },
      });

      const created = await tx.serviceCredential.create({
        data: {
          userId: serviceUser.id,
          name: input.name,
          keyHash,
          scopes: input.scopes,
          tableId: input.tableId ?? null,
          seat: input.seat ?? null,
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
              scopes: input.scopes,
              tableId: created.tableId,
              seat: created.seat,
              serviceUserId: serviceUser.id,
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
