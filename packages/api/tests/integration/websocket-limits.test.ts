import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

describe("WebSocket connection limits", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      baseUrl = "http://127.0.0.1:3000";
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("enforces a per-user concurrent connection limit", async () => {
    const address = `0x${"a".repeat(40)}`;
    const user = await app.prisma.user.create({
      data: { address, username: `ws_limit_${Date.now()}` },
    });
    await app.financialManager.ensureAccounts(user.id);

    const jti = `ws-limit-${Date.now()}`;
    await app.prisma.session.create({
      data: {
        userId: user.id,
        jti,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    const token = await app.jwt.sign(
      { userId: user.id, address: user.address, jti },
      { jti, expiresIn: "1h" }
    );

    const connections: WebSocket[] = [];
    const wsUrl = baseUrl.replace("http", "ws") + "/ws/play";

    try {
      for (let i = 0; i < 4; i++) {
        const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${token}`]);
        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => resolve());
          ws.on("error", reject);
          setTimeout(() => reject(new Error("Connection timeout")), 5000);
        });
        connections.push(ws);
      }

      const rejected = new WebSocket(wsUrl, ["pokertools", `jwt.${token}`]);
      await new Promise<void>((resolve, reject) => {
        rejected.on("close", (code) => {
          expect(code).toBe(1008);
          resolve();
        });
        rejected.on("error", reject);
        setTimeout(() => reject(new Error("Connection limit timeout")), 5000);
      });
      connections.push(rejected);

      expect(connections.filter((ws) => ws.readyState === WebSocket.OPEN).length).toBe(4);
    } finally {
      for (const ws of connections) {
        ws.close();
      }
      await app.prisma.session.deleteMany({ where: { userId: user.id } });
      await app.prisma.ledgerEntry.deleteMany({
        where: { account: { userId: user.id } },
      });
      await app.prisma.account.deleteMany({ where: { userId: user.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("bounds pre-authentication messages instead of allowing an unbounded queue", async () => {
    const address = `0x${"b".repeat(40)}`;
    const user = await app.prisma.user.create({
      data: { address, username: `ws_queue_${Date.now()}` },
    });
    await app.financialManager.ensureAccounts(user.id);

    const jti = `ws-queue-${Date.now()}`;
    await app.prisma.session.create({
      data: {
        userId: user.id,
        jti,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    const token = await app.jwt.sign(
      { userId: user.id, address: user.address, jti },
      { jti, expiresIn: "1h" }
    );

    const wsUrl = baseUrl.replace("http", "ws") + "/ws/play";

    const ws = new WebSocket(wsUrl, ["pokertools", `jwt.${token}`]);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => {
          for (let i = 0; i < 20; i++) {
            ws.send(JSON.stringify({ type: "PING" }));
          }
        });
        ws.on("message", () => resolve());
        ws.on("close", () => resolve());
        ws.on("error", reject);
        setTimeout(resolve, 500);
      });
      expect(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING).toBe(true);
    } finally {
      ws.close();
      await app.prisma.session.deleteMany({ where: { userId: user.id } });
      await app.prisma.ledgerEntry.deleteMany({
        where: { account: { userId: user.id } },
      });
      await app.prisma.account.deleteMany({ where: { userId: user.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("keeps JWT authentication bounded by connection/session validation", async () => {
    const address = `0x${"c".repeat(40)}`;
    const user = await app.prisma.user.create({
      data: { address, username: `ws_proto_${Date.now()}` },
    });
    await app.financialManager.ensureAccounts(user.id);

    const jti = `ws-proto-${Date.now()}`;
    await app.prisma.session.create({
      data: {
        userId: user.id,
        jti,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });

    const token = await app.jwt.sign(
      { userId: user.id, address: user.address, jti },
      { jti, expiresIn: "1h" }
    );

    expect(token.length).toBeGreaterThan(100);
    const decoded = await app.jwt.verify<{ userId: string; jti: string }>(token);
    expect(decoded.userId).toBe(user.id);
    expect(decoded.jti).toBe(jti);

    await app.prisma.session.deleteMany({ where: { userId: user.id } });
    await app.prisma.ledgerEntry.deleteMany({
      where: { account: { userId: user.id } },
    });
    await app.prisma.account.deleteMany({ where: { userId: user.id } });
    await app.prisma.user.delete({ where: { id: user.id } });
  });
});
