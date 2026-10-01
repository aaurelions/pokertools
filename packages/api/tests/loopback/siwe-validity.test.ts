import { expect, it } from "vitest";
import { createSiweMessage, PokerClient } from "@pokertools/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../../src/app.js";
import { cleanupTestUser } from "../helpers/test-utils.js";

it("enforces SIWE context, validity and once-only nonce claims through loopback", async () => {
  const app = await buildApp();
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new PokerClient({ baseUrl, retry: { count: 0 } });
  const account = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const userIds = new Set<string>();
  const send = async (message: string, signer = account) => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: await signer.signMessage({ message }) }),
    });
    const data = (await response.json()) as { user?: { id: string } };
    if (data.user) userIds.add(data.user.id);
    return response.status;
  };
  try {
    const parameters = {
      address: account.address,
      domain: new URL(baseUrl).hostname,
      uri: baseUrl,
      chainId: 31337,
      issuedAt: new Date(),
      nonce: await client.getNonce(),
    };
    const invalidContexts = [
      { domain: "other.example" },
      { uri: "https://other.example" },
      { chainId: 999999 },
      { nonce: "unknownnonce" },
      { issuedAt: new Date(Date.now() + 60000) },
      { expirationTime: new Date(Date.now() - 60000) },
      { notBefore: new Date(Date.now() + 60000) },
    ];
    for (const change of invalidContexts) {
      expect(await send(createSiweMessage({ ...parameters, ...change }))).toBe(401);
    }
    const valid = createSiweMessage(parameters);
    for (const malformed of [
      "not a SIWE message",
      valid.replace(/Issued At: .+/, "Issued At: not-a-date"),
      valid.replace("Version: 1", "Version: 2"),
      valid.replace(`URI: ${baseUrl}`, "URI: not-a-uri"),
    ]) {
      expect(await send(malformed)).toBe(400);
    }
    // A wrong signer must not burn a valid wallet's challenge.
    expect(await send(valid, other)).toBe(401);
    const login = await client.login({
      message: valid,
      signature: await account.signMessage({ message: valid }),
    });
    userIds.add(login.user.id);
    expect(await send(valid)).toBe(401);
    const clockSkew = createSiweMessage({
      ...parameters,
      nonce: await client.getNonce(),
      issuedAt: new Date(Date.now() + 10000),
    });
    expect(await send(clockSkew)).toBe(200);
    const concurrent = createSiweMessage({ ...parameters, nonce: await client.getNonce() });
    expect((await Promise.all([send(concurrent), send(concurrent)])).sort()).toEqual([200, 401]);
  } finally {
    for (const id of userIds) await cleanupTestUser(app, id);
    await app.close();
  }
});
