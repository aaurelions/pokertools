/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

describe("Auth - Full SIWE Flow Integration Test", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signedMessageForFreshNonce(
    account: PrivateKeyAccount
  ): Promise<{ message: string; signature: string; nonce: string }> {
    const nonceRes = await app.inject({ method: "POST", url: "/auth/nonce" });
    const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "localhost",
      nonce,
      uri: "http://localhost",
      version: "1",
    });
    return { message, signature: await account.signMessage({ message }), nonce };
  }

  it("should successfully login with a valid SIWE signature", async () => {
    // 1. Generate a random wallet
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    console.log(`🔐 Generated test wallet: ${address}`);

    // 2. Request Nonce
    const nonceRes = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address },
    });

    expect(nonceRes.statusCode).toBe(200);
    const { nonce } = JSON.parse(nonceRes.body);
    expect(nonce).toBeTruthy();

    // 3. Create SIWE Message
    // Note: viem/siwe createSiweMessage expects specific parameters to match the verification
    const message = createSiweMessage({
      address,
      chainId: 1, // Mainnet
      domain: "localhost", // Fastify usually defaults to localhost or configured domain
      nonce,
      uri: "http://localhost", // Origin
      version: "1",
      statement: "Sign in to PokerTools",
    });

    // 4. Sign Message
    const signature = await account.signMessage({
      message,
    });

    // 5. Login
    // Ensure the URL is exactly as registered
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        message,
        signature,
      },
    });

    if (loginRes.statusCode !== 200) {
      console.error("Login failed:", loginRes.body);
    }

    expect(loginRes.statusCode).toBe(200);
    const body = JSON.parse(loginRes.body);

    expect(body.token).toBeTruthy();
    expect(body.user).toBeTruthy();
    expect(body.user.username).toContain("player_");

    // Verify token works
    const meRes = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: {
        authorization: `Bearer ${body.token}`,
      },
    });

    expect(meRes.statusCode).toBe(200);
    const me = JSON.parse(meRes.body);
    expect(me.address.toLowerCase()).toBe(address.toLowerCase());
  });

  it("should fail with manipulated message", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    const nonceRes = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address },
    });
    const { nonce } = JSON.parse(nonceRes.body);

    const message = createSiweMessage({
      address,
      chainId: 1,
      domain: "localhost",
      nonce,
      uri: "http://localhost",
      version: "1",
      statement: "Sign in to PokerTools",
    });

    // Sign the original message
    const signature = await account.signMessage({ message });

    // Tamper with the message
    const tamperedMessage = message.replace(nonce, "invalidnonce");

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        message: tamperedMessage,
        signature,
      },
    });

    expect(loginRes.statusCode).toBe(401); // Either nonce check or signature verification will fail
  });

  it("defaults to an opaque, non-wallet-derived username", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, signature } = await signedMessageForFreshNonce(account);

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(loginRes.statusCode).toBe(200);
    const body = JSON.parse(loginRes.body) as { user: { id: string; username: string } };

    // 128-bit CSPRNG default with a display-only prefix: no wallet-derived
    // substring can leak through public projections (e.g. tournament entries).
    expect(body.user.username).toMatch(/^player_[0-9a-f]{32}$/);
    const addressLower = account.address.toLowerCase();
    expect(body.user.username).not.toContain(addressLower.slice(2, 14));
    expect(body.user.username).not.toContain(addressLower);

    const row = await app.prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(row.username).toBe(body.user.username);
    expect(row.address).toBe(addressLower);
  });

  it("converges concurrent first logins for the same wallet on one principal", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const [first, second] = await Promise.all([
      signedMessageForFreshNonce(account),
      signedMessageForFreshNonce(account),
    ]);

    const [loginA, loginB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { message: first.message, signature: first.signature },
      }),
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { message: second.message, signature: second.signature },
      }),
    ]);

    expect(loginA.statusCode).toBe(200);
    expect(loginB.statusCode).toBe(200);
    const a = JSON.parse(loginA.body) as {
      token: string;
      user: { id: string; username: string };
    };
    const b = JSON.parse(loginB.body) as {
      token: string;
      user: { id: string; username: string };
    };

    // Same durable principal, same opaque default name, no duplicate row.
    expect(a.user.id).toBe(b.user.id);
    expect(a.user.username).toBe(b.user.username);
    expect(a.user.username).toMatch(/^player_[0-9a-f]{32}$/);
    const addressLower = account.address.toLowerCase();
    expect(await app.prisma.user.count({ where: { address: addressLower } })).toBe(1);

    // Both issued sessions resolve to that same principal.
    for (const token of [a.token, b.token]) {
      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect((JSON.parse(me.body) as { id: string }).id).toBe(a.user.id);
    }
  });

  it("consumes a nonce only when the signature is valid", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, signature, nonce } = await signedMessageForFreshNonce(account);

    // A message altered after signing fails signature verification before the
    // nonce claim; the Redis nonce is not consumed by an invalid attempt.
    const tampered = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message: message.replace(nonce, "invalidnonce"), signature },
    });
    expect(tampered.statusCode).toBe(401);

    // The original valid message still works, then is consumed exactly once.
    const valid = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(valid.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { message, signature },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.body).error).toBe("Invalid or expired nonce");
  });
});
