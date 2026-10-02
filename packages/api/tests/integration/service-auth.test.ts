/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { once } from "node:events";
import { ServerMessageSchema, type ServerMessage } from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import {
  createTestUser,
  cleanupTestUser,
  createTable,
  cleanupTestTable,
  type TestUser,
} from "../helpers/test-utils.js";

function waitForFrame(
  ws: WebSocket,
  matches: (frame: ServerMessage) => boolean
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("WS closed before expected frame"));
    const onMessage = (data: RawData) => {
      try {
        const frame = ServerMessageSchema.parse(JSON.parse(data.toString()));
        if (matches(frame)) {
          cleanup();
          resolve(frame);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const timer = setTimeout(() => onError(new Error("WS frame timeout")), 5000);
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

interface CreatedCredential {
  id: string;
  userId: string;
  token: string;
  scopes: string[];
  tableId: string | null;
  seat: number | null;
}

describe("Service principal auth + scoped authorization", () => {
  let app: FastifyInstance;
  let admin: TestUser;
  let player: TestUser;
  let baseUrl: string;
  let tableA: string;
  let tableB: string;

  const createdCredentials: string[] = [];
  const serviceUserIds: string[] = [];

  async function createCredential(
    token: string,
    payload: Record<string, unknown>
  ): Promise<{ statusCode: number; body: CreatedCredential }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    if (res.statusCode === 201) {
      const body = JSON.parse(res.body) as CreatedCredential;
      createdCredentials.push(body.id);
      serviceUserIds.push(body.userId);
      return { statusCode: res.statusCode, body };
    }
    return { statusCode: res.statusCode, body: JSON.parse(res.body) as CreatedCredential };
  }

  async function getTable(token: string, tableId: string) {
    return app.inject({
      method: "GET",
      url: `/tables/${tableId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    baseUrl =
      typeof addr === "object" && addr ? `ws://127.0.0.1:${addr.port}` : "ws://127.0.0.1:3000";

    admin = await createTestUser(app, "svc_admin", 10000);
    player = await createTestUser(app, "svc_player", 10000);
    // The shared wire PrincipalSchema validates EVM address format; give the
    // wallet test user a real-format address (the test helper does not).
    const validAddress = `0x${"1".repeat(40)}`;
    await app.prisma.user.update({
      where: { id: player.id },
      data: { address: validAddress },
    });
    player.address = validAddress;
    await app.prisma.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });

    tableA = await createTable(app, admin.token, {
      name: "svc-table-a",
      allowSpectators: true,
      mode: "CASH",
      smallBlind: 1,
      bigBlind: 2,
    });
    tableB = await createTable(app, admin.token, {
      name: "svc-table-b",
      mode: "CASH",
      smallBlind: 1,
      bigBlind: 2,
    });
  });

  afterAll(async () => {
    for (const id of createdCredentials) {
      await app.prisma.serviceCredential.delete({ where: { id } }).catch(() => undefined);
    }
    for (const userId of serviceUserIds) {
      await app.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    }
    await cleanupTestTable(app, tableA);
    await cleanupTestTable(app, tableB);
    await cleanupTestUser(app, admin.id);
    await cleanupTestUser(app, player.id);
    await app.close();
  });

  it("only an operator wallet can mint service credentials", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${player.token}` },
      payload: { name: "nope", scopes: ["table:observe"] },
    });
    expect(denied.statusCode).toBe(403);

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      payload: { name: "nope", scopes: ["table:observe"] },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("creates a SERVICE identity with null address and hashes the secret", async () => {
    const { statusCode, body } = await createCredential(admin.token, {
      name: "observer",
      scopes: ["table:observe"],
      tableId: tableA,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(statusCode).toBe(201);
    expect(body.token).toMatch(/^ptsvc_[A-Za-z0-9_-]{43}$/);

    const backing = await app.prisma.user.findUniqueOrThrow({ where: { id: body.userId } });
    expect(backing.kind).toBe("SERVICE");
    expect(backing.address).toBeNull();

    const credential = await app.prisma.serviceCredential.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(credential.keyHash).not.toContain(body.token);
    expect(credential.keyHash).toMatch(/^[a-f0-9]{64}$/);
    // Only the hash is stored — the plaintext never appears in the row.
    expect(JSON.stringify(credential)).not.toContain(body.token);
  });

  it("validates strict schemas (unknown fields, seat without table)", async () => {
    const unknownField = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "x", scopes: ["table:observe"], admin: true },
    });
    expect(unknownField.statusCode).toBe(400);

    const seatWithoutTable = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "x", scopes: ["table:act"], seat: 1 },
    });
    expect(seatWithoutTable.statusCode).toBe(400);
  });

  it("enforces table restrictions and masks out-of-scope resources", async () => {
    const { body } = await createCredential(admin.token, {
      name: "table-a-only",
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const allowed = await getTable(body.token, tableA);
    expect(allowed.statusCode).toBe(200);

    // Restricted credential must not observe another table.
    const denied = await getTable(body.token, tableB);
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe("TABLE_RESTRICTED");
  });

  it("prevents scope escalation and blocks admin/finance routes", async () => {
    const { body } = await createCredential(admin.token, {
      name: "observer-only",
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const action = await app.inject({
      method: "POST",
      url: `/tables/${tableA}/action`,
      headers: { authorization: `Bearer ${body.token}` },
      payload: { type: "FOLD" },
    });
    expect(action.statusCode).toBe(403);
    expect(JSON.parse(action.body).error).toBe("SCOPE_MISSING");

    // Canonical finance resources remain categorically denied to SERVICE
    // credentials (the legacy /finance/deposit/* routes were removed, so a
    // regression that only checked those would silently pass).
    const finance = await app.inject({
      method: "GET",
      url: "/finance/balances",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(finance.statusCode).toBe(403);
    expect(JSON.parse(finance.body).error).toBe("SERVICE_SCOPE_FORBIDDEN");

    const mint = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${body.token}` },
      payload: { name: "escalate", scopes: ["table:act"] },
    });
    expect(mint.statusCode).toBe(403);
  });

  it("authorizes scoped SERVICE credentials on observation and chat routes", async () => {
    const { body } = await createCredential(admin.token, {
      name: "observer-chat",
      scopes: ["table:observe", "table:chat"],
      tableId: tableA,
    });

    const observation = await app.inject({
      method: "GET",
      url: `/tables/${tableA}/observation`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(observation.statusCode).toBe(200);
    const seatObservation = JSON.parse(observation.body);
    expect(typeof seatObservation.turnId).toBe("string");
    // The service identity is not seated: it observes as a masked spectator.
    expect(seatObservation.state.viewingPlayerId).toBeNull();
    expect(seatObservation.legalActions).toEqual([]);

    const chat = await app.inject({
      method: "POST",
      url: `/tables/${tableA}/chat`,
      headers: { authorization: `Bearer ${body.token}` },
      payload: { body: "<b>service</b>" },
    });
    expect(chat.statusCode).toBe(200);
    const message = JSON.parse(chat.body);
    expect(message.principalId).toBe(body.userId);
    expect(message.body).toBe("&lt;b&gt;service&lt;/b&gt;");

    // A seat-bound credential has no persisted seat on observation and fails closed.
    const seatBound = await createCredential(admin.token, {
      name: "seat-observation",
      scopes: ["table:observe"],
      tableId: tableA,
      seat: 0,
    });
    const denied = await app.inject({
      method: "GET",
      url: `/tables/${tableA}/observation`,
      headers: { authorization: `Bearer ${seatBound.body.token}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe("SEAT_RESTRICTED");
  });

  it("revokes credentials immediately", async () => {
    const { body } = await createCredential(admin.token, {
      name: "revocable",
      scopes: ["table:observe"],
      tableId: tableA,
    });
    expect((await getTable(body.token, tableA)).statusCode).toBe(200);

    const revoked = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/revoke`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await getTable(body.token, tableA);
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("supports service credentials over the WS jwt.<token> subprotocol", async () => {
    const { body } = await createCredential(admin.token, {
      name: "ws-observer",
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const ws = new WebSocket(`${baseUrl}/ws/play`, ["pokertools", `jwt.${body.token}`]);
    try {
      await once(ws, "open", { signal: AbortSignal.timeout(5000) });
      const observation = waitForFrame(
        ws,
        (frame) => frame.type === "OBSERVATION" && frame.requestId === "ws-1"
      );
      const ack = waitForFrame(ws, (frame) => frame.type === "ACK" && frame.requestId === "ws-1");
      ws.send(JSON.stringify({ type: "JOIN", tableId: tableA, requestId: "ws-1" }));
      const [snapshot] = await Promise.all([observation, ack]);
      // Canonical server-to-client decision boundary is a full OBSERVATION.
      expect(snapshot.type).toBe("OBSERVATION");
      if (snapshot.type !== "OBSERVATION") throw new Error("Expected observation");
      expect(snapshot.observation.tableId).toBe(tableA);

      // A different table is masked from a table-restricted credential.
      const rejected = waitForFrame(
        ws,
        (frame) => frame.type === "ERROR" && frame.requestId === "ws-2"
      );
      ws.send(JSON.stringify({ type: "JOIN", tableId: tableB, requestId: "ws-2" }));
      const error = await rejected;
      expect(error.type).toBe("ERROR");
      if (error.type !== "ERROR") throw new Error("Expected authorization error");
      expect(error.code).toBe("TABLE_RESTRICTED");
    } finally {
      ws.close();
    }
  });

  it("still authenticates wallet sessions with full gameplay scopes", async () => {
    const res = await getTable(player.token, tableA);
    expect(res.statusCode).toBe(200);

    // The wire principal is exactly the shared three-field contract.
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(me.statusCode).toBe(200);
    const body = JSON.parse(me.body);
    expect(body).toEqual({
      id: player.id,
      kind: "WALLET",
      walletAddress: player.address,
    });
  });

  it("blocks service credentials from creating tables/rooms", async () => {
    const { body } = await createCredential(admin.token, {
      name: "no-room-create",
      scopes: ["table:act"],
      tableId: tableA,
    });
    const res = await app.inject({
      method: "POST",
      url: "/tables",
      headers: { authorization: `Bearer ${body.token}` },
      payload: { name: "evil", mode: "CASH", smallBlind: 1, bigBlind: 2 },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("SERVICE_SCOPE_FORBIDDEN");
  });

  it("fails closed for a seat-restricted credential with no persisted seat", async () => {
    // The backing SERVICE identity is not seated anywhere, so the persisted
    // seat cannot be established and private observation must be denied.
    const { body } = await createCredential(admin.token, {
      name: "seat-bound",
      scopes: ["table:observe"],
      tableId: tableA,
      seat: 0,
    });

    const res = await getTable(body.token, tableA);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("SEAT_RESTRICTED");

    const ws = new WebSocket(`${baseUrl}/ws/play`, ["pokertools", `jwt.${body.token}`]);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WS open timeout")), 5000);
      });
      const error = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once("message", (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
        ws.send(JSON.stringify({ type: "JOIN", tableId: tableA, requestId: "ws-seat" }));
        setTimeout(() => reject(new Error("WS error timeout")), 5000);
      });
      expect(error.type).toBe("ERROR");
      expect(error.code).toBe("SEAT_RESTRICTED");
    } finally {
      ws.close();
    }
  });

  it("stops delivery on an open WS when the credential is revoked", async () => {
    const { body } = await createCredential(admin.token, {
      name: "ws-revoke",
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const ws = new WebSocket(`${baseUrl}/ws/play`, ["pokertools", `jwt.${body.token}`]);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WS open timeout")), 5000);
      });
      await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.once("message", (data) =>
          resolve(JSON.parse(data.toString()) as Record<string, unknown>)
        );
        ws.send(JSON.stringify({ type: "JOIN", tableId: tableA, requestId: "ws-pre" }));
        setTimeout(() => reject(new Error("WS message timeout")), 5000);
      });

      const revoked = await app.inject({
        method: "POST",
        url: `/auth/service-credentials/${body.id}/revoke`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(revoked.statusCode).toBe(200);

      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.once("close", (code) => resolve(code));
        // Any subsequent message triggers mandatory revalidation.
        ws.send(JSON.stringify({ type: "PING", requestId: "post-revoke" }));
        setTimeout(() => reject(new Error("WS close timeout")), 5000);
      });
      expect(closeCode).toBe(4001);
    } finally {
      ws.close();
    }
  });

  it("writes durable atomic audit records for create and revoke", async () => {
    const name = `audited-${Date.now()}`;
    const { body } = await createCredential(admin.token, {
      name,
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const createAudit = await app.prisma.auditLog.findFirst({
      where: { action: "SERVICE_CREDENTIAL_CREATE", resource: `service-credential:${body.id}` },
    });
    expect(createAudit).not.toBeNull();
    expect(createAudit?.actorId).toBe(admin.id);
    // The plaintext token never appears in durable audit.
    expect(JSON.stringify(createAudit?.metadata ?? {})).not.toContain(body.token);

    await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/revoke`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const revokeAudit = await app.prisma.auditLog.findFirst({
      where: { action: "SERVICE_CREDENTIAL_REVOKE", resource: `service-credential:${body.id}` },
    });
    expect(revokeAudit).not.toBeNull();
    expect(revokeAudit?.actorId).toBe(admin.id);
  });
});
