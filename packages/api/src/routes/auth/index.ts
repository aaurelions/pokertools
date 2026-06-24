import type { FastifyPluginAsync } from "fastify";
import { verifyMessage } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import crypto from "node:crypto";
import { LoginRequest } from "@pokertools/types";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/nonce
  fastify.post("/nonce", async (_request, _reply) => {
    const nonce = generateSiweNonce();
    await fastify.redis.set(`nonce:${nonce}`, "1", "EX", 300);
    return { nonce };
  });

  // POST /auth/login
  fastify.post<{
    Body: LoginRequest;
  }>("/login", async (request, reply) => {
    const { message, signature } = request.body;

    // 1. Parse and verify nonce
    const siweMessage = parseSiweMessage(message);
    const nonceExists = await fastify.redis.getdel(`nonce:${siweMessage.nonce}`);
    if (!nonceExists) {
      return reply.code(401).send({ error: "Invalid or expired nonce" });
    }

    // 2. Verify signature
    if (!siweMessage.address) {
      return reply.code(400).send({ error: "Invalid SIWE message: missing address" });
    }

    const valid = await verifyMessage({
      address: siweMessage.address,
      message,
      signature,
    });

    if (!valid) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    // 3. Upsert user (store address in lowercase)
    const addressLower = siweMessage.address.toLowerCase();

    const user = await fastify.prisma.user.upsert({
      where: { address: addressLower },
      create: {
        address: addressLower,
        username: `player_${addressLower.slice(2, 8)}`,
      },
      update: {},
    });

    // Ensure user has accounts
    await fastify.financialManager.ensureAccounts(user.id);

    // 4. Create session
    const jti = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await fastify.prisma.session.create({
      data: { userId: user.id, jti, expiresAt },
    });

    // 5. Issue JWT
    const token = await reply.jwtSign(
      { userId: user.id, address: user.address, jti },
      { jti, expiresIn: "7d" }
    );

    reply.setCookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return { token, user: { id: user.id, username: user.username } };
  });

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
