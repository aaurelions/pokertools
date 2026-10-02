import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import crypto from "node:crypto";
import {
  CreateServiceCredentialRequestSchema,
  CreatedServiceCredentialSchema,
  CredentialIdSchema,
  ListServiceCredentialsResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutResponseSchema,
  NonceResponseSchema,
  PrincipalSchema,
  ProvisionServicePrincipalRequestSchema,
  ProvisionedServicePrincipalSchema,
  RevokeServiceCredentialResponseSchema,
  RotateServiceCredentialRequestSchema,
  type LoginRequest,
} from "@pokertools/types";
import { allowedSiweChainIds, config } from "../../config.js";
import { toWirePrincipal } from "../../services/principal-manager.js";
import type { PrismaClient } from "../../../generated/prisma/index.js";

// Wallets and the API can run on different clocks (including Docker's VM).
// Bound tolerance tightly; nonce TTL and atomic consumption still govern replay.
const SIWE_MAX_FUTURE_SKEW_MS = 30_000;

function normalizeHost(host: string | undefined): string {
  return (host ?? "localhost").split(":")[0].toLowerCase();
}

async function createUniqueUsername(prisma: PrismaClient, addressLower: string): Promise<string> {
  const base = `player_${addressLower.slice(2, 14)}`;
  for (let suffix = 0; suffix < 100; suffix++) {
    const username = suffix === 0 ? base : `${base}_${suffix}`;
    const existing = await prisma.user.findUnique({ where: { username } });
    if (!existing) return username;
  }
  return `player_${addressLower.slice(2, 14)}_${crypto.randomBytes(4).toString("hex")}`;
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/nonce
  fastify.post(
    "/nonce",
    {
      config: {
        rateLimit: {
          max: config.NODE_ENV === "test" ? 100 : config.AUTH_NONCE_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
        },
      },
    },
    async (_request, _reply) => {
      const nonce = generateSiweNonce();
      await fastify.redis.set(`nonce:${nonce}`, "1", "EX", config.NONCE_TTL_SECONDS);
      return NonceResponseSchema.parse({ nonce });
    }
  );

  // POST /auth/login
  fastify.post<{
    Body: LoginRequest;
  }>(
    "/login",
    {
      config: {
        rateLimit: {
          max: config.NODE_ENV === "test" ? 100 : config.AUTH_LOGIN_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const validation = LoginRequestSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.code(400).send({ error: "Validation failed" });
      }

      const { message, signature } = validation.data;

      // Parse and verify nonce
      let siweMessage: ReturnType<typeof parseSiweMessage>;
      try {
        siweMessage = parseSiweMessage(message);
      } catch {
        return reply.code(400).send({ error: "Invalid SIWE message" });
      }
      if (
        !siweMessage.uri ||
        !siweMessage.nonce ||
        siweMessage.version !== "1" ||
        !siweMessage.issuedAt ||
        !Number.isFinite(siweMessage.issuedAt.getTime())
      ) {
        return reply.code(400).send({ error: "Invalid SIWE message" });
      }
      const expectedDomain = normalizeHost(request.hostname);
      if (siweMessage.domain?.toLowerCase() !== expectedDomain) {
        return reply.code(401).send({ error: "Invalid SIWE domain" });
      }
      try {
        const uri = new URL(siweMessage.uri);
        if (
          !["http:", "https:"].includes(uri.protocol) ||
          uri.username ||
          uri.password ||
          normalizeHost(uri.host) !== expectedDomain
        ) {
          return reply.code(401).send({ error: "Invalid SIWE URI" });
        }
      } catch {
        return reply.code(400).send({ error: "Invalid SIWE URI" });
      }

      if (!siweMessage.chainId || !allowedSiweChainIds().has(siweMessage.chainId)) {
        return reply.code(401).send({ error: "Invalid SIWE chainId" });
      }

      const now = new Date();
      if (siweMessage.issuedAt.getTime() > now.getTime() + SIWE_MAX_FUTURE_SKEW_MS) {
        return reply.code(401).send({ error: "SIWE issuedAt is in the future" });
      }
      if (siweMessage.expirationTime && siweMessage.expirationTime <= now) {
        return reply.code(401).send({ error: "SIWE message expired" });
      }
      if (siweMessage.notBefore && siweMessage.notBefore > now) {
        return reply.code(401).send({ error: "SIWE message not yet valid" });
      }
      if (!validateSiweMessage({ message: siweMessage, time: now })) {
        return reply.code(401).send({ error: "Invalid SIWE validity" });
      }

      const nonceExists = await fastify.redis.get(`nonce:${siweMessage.nonce}`);
      if (!nonceExists) {
        return reply.code(401).send({ error: "Invalid or expired nonce" });
      }

      // Verify signature
      if (!siweMessage.address) {
        return reply.code(400).send({ error: "Invalid SIWE message: missing address" });
      }

      const valid = await verifyMessage({
        address: siweMessage.address,
        message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      // Invalid signatures cannot consume another wallet's challenge. GETDEL
      // after verification is the atomic once-only claim for concurrent replays.
      if (!(await fastify.redis.getdel(`nonce:${siweMessage.nonce}`))) {
        return reply.code(401).send({ error: "Invalid or expired nonce" });
      }

      // Upsert user (store address in lowercase)
      const addressLower = siweMessage.address.toLowerCase();
      const existingUser = await fastify.prisma.user.findUnique({
        where: { address: addressLower },
      });

      const user =
        existingUser ??
        (await fastify.prisma.user.create({
          data: {
            address: addressLower,
            username: await createUniqueUsername(fastify.prisma, addressLower),
          },
        }));

      // Ensure user has accounts
      await fastify.financialManager.ensureAccounts(user.id);

      // Create session
      const jti = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

      await fastify.prisma.session.create({
        data: { userId: user.id, jti, expiresAt },
      });

      // Issue JWT
      const token = await reply.jwtSign(
        { userId: user.id, address: user.address, jti },
        { jti, expiresIn: `${config.SESSION_TTL_SECONDS}s` }
      );

      reply.setCookie("token", token, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: config.SESSION_TTL_SECONDS,
        path: "/",
      });

      return LoginResponseSchema.parse({
        token,
        user: { id: user.id, username: user.username },
      });
    }
  );

  // GET /auth/me - Canonical three-field wire principal for the caller.
  fastify.get("/me", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    if (!request.principal) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return PrincipalSchema.parse(toWirePrincipal(request.principal));
  });

  // POST /auth/logout
  fastify.post("/logout", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { jti } = request.user;

    await fastify.prisma.session.update({
      where: { jti },
      data: { revoked: true },
    });

    reply.clearCookie("token");
    return LogoutResponseSchema.parse({ success: true });
  });

  // -------------------------------------------------------------------------
  // SERVICE credential administration (operator-only, auditable).
  //
  // Only an explicit ADMIN wallet principal may mint or revoke machine
  // credentials. Service principals can never reach these routes (the global
  // SERVICE scope boundary denies /auth), and `requireOperator` enforces the
  // wallet-admin property in depth.
  // -------------------------------------------------------------------------

  // POST /auth/service-credentials
  fastify.post(
    "/service-credentials",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsed = CreateServiceCredentialRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Validation failed", issues: parsed.error.issues });
      }

      const created = await fastify.principalManager.createServiceCredential({
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        principalId: parsed.data.principalId ?? null,
        tableId: parsed.data.tableId ?? null,
        seat: parsed.data.seat ?? null,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        createdById: request.principal?.id ?? null,
        // Durable, atomic audit: committed in the same transaction as the row.
        audit: {
          actorId: request.principal?.id ?? null,
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        },
      });

      return reply.code(201).send(
        CreatedServiceCredentialSchema.parse({
          ...created,
          expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        })
      );
    }
  );

  // GET /auth/service-credentials
  fastify.get(
    "/service-credentials",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async () => {
      const credentials = await fastify.principalManager.listServiceCredentials();
      return ListServiceCredentialsResponseSchema.parse({
        credentials: credentials.map((credential) => ({
          ...credential,
          expiresAt: credential.expiresAt ? credential.expiresAt.toISOString() : null,
          lastUsedAt: credential.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
          revokedAt: credential.revokedAt ? credential.revokedAt.toISOString() : null,
          createdAt: credential.createdAt.toISOString(),
        })),
      });
    }
  );

  // POST /auth/service-credentials/:id/revoke
  fastify.post<{ Params: { id: string } }>(
    "/service-credentials/:id/revoke",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsed = CredentialIdSchema.safeParse(request.params.id);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid credential id" });
      }

      const revoked = await fastify.principalManager.revokeServiceCredential(parsed.data, {
        actorId: request.principal?.id ?? null,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      if (!revoked) {
        return reply.code(404).send({ error: "SERVICE_CREDENTIAL_NOT_FOUND" });
      }

      return RevokeServiceCredentialResponseSchema.parse({ success: true });
    }
  );

  // POST /auth/service-credentials/:id/rotate
  fastify.post<{ Params: { id: string } }>(
    "/service-credentials/:id/rotate",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsedId = CredentialIdSchema.safeParse(request.params.id);
      if (!parsedId.success) {
        return reply.code(400).send({ error: "Invalid credential id" });
      }
      const parsed = RotateServiceCredentialRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Validation failed", issues: parsed.error.issues });
      }

      const rotated = await fastify.principalManager.rotateServiceCredential(
        parsedId.data,
        { expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : undefined },
        {
          actorId: request.principal?.id ?? null,
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        }
      );
      if (!rotated) {
        return reply.code(404).send({ error: "SERVICE_CREDENTIAL_NOT_FOUND" });
      }

      return reply.code(200).send(
        CreatedServiceCredentialSchema.parse({
          ...rotated,
          expiresAt: rotated.expiresAt ? rotated.expiresAt.toISOString() : null,
        })
      );
    }
  );

  // POST /auth/service-principals — provision a durable SERVICE principal
  // (optionally delegated to an orchestration principal). No credential is
  // minted here; room credentials are issued separately (operator route or
  // competition-scoped agent credential route).
  fastify.post(
    "/service-principals",
    { onRequest: [fastify.authenticate, fastify.requireOperator] },
    async (request, reply) => {
      const parsed = ProvisionServicePrincipalRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Validation failed", issues: parsed.error.issues });
      }

      const created = await fastify.principalManager.provisionServicePrincipal({
        name: parsed.data.name,
        delegatedToPrincipalId: parsed.data.delegatedToPrincipalId ?? null,
        createdById: request.principal?.id ?? null,
        audit: {
          actorId: request.principal?.id ?? null,
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        },
      });

      return reply.code(201).send(
        ProvisionedServicePrincipalSchema.parse({
          ...created,
          createdAt: created.createdAt.toISOString(),
        })
      );
    }
  );
};
