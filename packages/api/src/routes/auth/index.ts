import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import crypto from "node:crypto";
import { LoginRequest } from "@pokertools/types";
import { z } from "zod";
import { allowedSiweChainIds, config } from "../../config.js";
import type { PrismaClient } from "../../../generated/prisma/index.js";

const loginSchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid signature format"),
});

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
      return { nonce };
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
      const validation = loginSchema.safeParse(request.body);
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
      if (siweMessage.issuedAt > now) {
        return reply.code(401).send({ error: "SIWE issuedAt is in the future" });
      }
      if (!validateSiweMessage({ message: siweMessage, time: now })) {
        return reply.code(401).send({ error: "Invalid SIWE validity" });
      }
      if (siweMessage.expirationTime && siweMessage.expirationTime <= now) {
        return reply.code(401).send({ error: "SIWE message expired" });
      }
      if (siweMessage.notBefore && siweMessage.notBefore > now) {
        return reply.code(401).send({ error: "SIWE message not yet valid" });
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

      return { token, user: { id: user.id, username: user.username } };
    }
  );

  // POST /auth/logout
  fastify.post("/logout", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const { jti } = request.user;

    await fastify.prisma.session.update({
      where: { jti },
      data: { revoked: true },
    });

    reply.clearCookie("token");
    return { success: true };
  });
};
