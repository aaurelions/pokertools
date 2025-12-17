/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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
});
