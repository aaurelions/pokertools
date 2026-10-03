/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { once } from "node:events";
import { ServerMessageSchema, type ServerMessage } from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import { generateServiceToken, hashServiceToken } from "../../src/services/principal-manager.js";
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

  it("keeps the global table collection closed to bound SERVICE credentials", async () => {
    const { body } = await createCredential(admin.token, {
      name: `collection-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });
    const collection = await app.inject({
      method: "GET",
      url: "/tables",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(collection.statusCode).toBe(403);
    expect(JSON.parse(collection.body).error).toBe("SERVICE_SCOPE_FORBIDDEN");

    // Its own bound room stays reachable directly; other rooms do not.
    expect((await getTable(body.token, tableA)).statusCode).toBe(200);
    expect((await getTable(body.token, tableB)).statusCode).toBe(403);
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

  // -------------------------------------------------------------------------
  // Rotation / expiry / revocation race policy.
  // -------------------------------------------------------------------------

  it("rejects born-expired credential inputs before any mutation", async () => {
    const name = `expired-${Date.now()}`;
    const past = new Date(Date.now() - 60_000).toISOString();

    const created = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name, scopes: ["table:observe"], tableId: tableA, expiresAt: past },
    });
    expect(created.statusCode).toBe(400);
    expect(JSON.parse(created.body).error).toBe("SERVICE_CREDENTIAL_EXPIRY_INVALID");
    expect(await app.prisma.serviceCredential.count({ where: { name } })).toBe(0);

    // A rejected rotation must not invalidate the existing secret.
    const { body } = await createCredential(admin.token, {
      name,
      scopes: ["table:observe"],
      tableId: tableA,
    });
    const rotated = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/rotate`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { expiresAt: past },
    });
    expect(rotated.statusCode).toBe(400);
    expect(JSON.parse(rotated.body).error).toBe("SERVICE_CREDENTIAL_EXPIRY_INVALID");
    expect((await getTable(body.token, tableA)).statusCode).toBe(200);
  });

  it("rotates in place preserving identity and restrictions; old secret dies", async () => {
    const { body } = await createCredential(admin.token, {
      name: `preserve-${Date.now()}`,
      scopes: ["table:observe", "table:chat"],
      tableId: tableA,
      seat: 0,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
    const rotated = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/rotate`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { expiresAt },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = JSON.parse(rotated.body) as {
      id: string;
      userId: string;
      scopes: string[];
      tableId: string | null;
      seat: number | null;
      expiresAt: string | null;
      token: string;
    };
    expect(rotatedBody.id).toBe(body.id);
    expect(rotatedBody.userId).toBe(body.userId);
    expect(rotatedBody.scopes).toEqual(["table:observe", "table:chat"]);
    expect(rotatedBody.tableId).toBe(tableA);
    expect(rotatedBody.seat).toBe(0);
    expect(rotatedBody.expiresAt).toBe(expiresAt);

    const row = await app.prisma.serviceCredential.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.keyHash).toBe(hashServiceToken(rotatedBody.token));
    expect(row.revoked).toBe(false);

    // The previous secret stops working immediately; the new one authenticates.
    expect((await getTable(body.token, tableA)).statusCode).toBe(401);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${rotatedBody.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("fails closed for expired credentials and requires a future expiry to rotate", async () => {
    const { body } = await createCredential(admin.token, {
      name: `expires-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });
    await app.prisma.serviceCredential.update({
      where: { id: body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await getTable(body.token, tableA)).statusCode).toBe(401);
    expect(await app.principalManager.authenticateServiceToken(body.token)).toBeNull();

    // Rotation without a new future expiry cannot produce a dead-on-arrival
    // secret: it is rejected before the row is touched.
    const omitted = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/rotate`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(omitted.statusCode).toBe(409);
    expect(JSON.parse(omitted.body).error).toBe("SERVICE_CREDENTIAL_EXPIRED");

    // Explicit renewal is allowed and yields a working secret.
    const renewed = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/rotate`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(renewed.statusCode).toBe(200);
    const renewedToken = (JSON.parse(renewed.body) as { token: string }).token;
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${renewedToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("enforces revocation and expiry at every request boundary", async () => {
    const { body } = await createCredential(admin.token, {
      name: `boundary-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });

    // A resolution completed before revocation stays authoritative for that
    // in-flight operation; revocation is never retroactive to work already
    // authenticated. Every subsequent request re-resolves and fails closed.
    const inFlight = await app.principalManager.authenticateServiceToken(body.token);
    expect(inFlight).not.toBeNull();

    const revoked = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/revoke`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(await app.principalManager.authenticateServiceToken(body.token)).toBeNull();
    expect((await getTable(body.token, tableA)).statusCode).toBe(401);

    // A revoked credential can never be rotated back to life.
    const rotated = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${body.id}/rotate`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(rotated.statusCode).toBe(409);
    expect(JSON.parse(rotated.body).error).toBe("SERVICE_CREDENTIAL_REVOKED");
  });

  it("cannot revive a credential when rotate races revoke", async () => {
    const { body } = await createCredential(admin.token, {
      name: `race-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const [rotated, revoked] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/auth/service-credentials/${body.id}/rotate`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/auth/service-credentials/${body.id}/revoke`,
        headers: { authorization: `Bearer ${admin.token}` },
      }),
    ]);
    expect(revoked.statusCode).toBe(200);

    const row = await app.prisma.serviceCredential.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.revoked).toBe(true);
    expect(row.revokedAt).not.toBeNull();

    // Whichever order the race resolved in, the revoked row is terminal:
    // a successful rotation's fresh secret is dead, and a losing rotation
    // reports the revocation instead of resurrecting the credential.
    expect((await getTable(body.token, tableA)).statusCode).toBe(401);
    if (rotated.statusCode === 200) {
      const rotatedToken = (JSON.parse(rotated.body) as { token: string }).token;
      expect((await getTable(rotatedToken, tableA)).statusCode).toBe(401);
      expect(await app.principalManager.authenticateServiceToken(rotatedToken)).toBeNull();
    } else {
      expect(rotated.statusCode).toBe(409);
      expect(JSON.parse(rotated.body).error).toBe("SERVICE_CREDENTIAL_REVOKED");
    }
  });

  it("concurrent rotations leave exactly the final secret valid", async () => {
    const { body } = await createCredential(admin.token, {
      name: `double-rotate-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/auth/service-credentials/${body.id}/rotate`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/auth/service-credentials/${body.id}/rotate`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {},
      }),
    ]);
    for (const response of [first, second]) {
      expect([200, 409]).toContain(response.statusCode);
    }

    const successes = [first, second].filter((response) => response.statusCode === 200);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const tokens = successes.map(
      (response) => (JSON.parse(response.body) as { token: string }).token
    );

    // Only the secret persisted last may authenticate; every earlier one is
    // invalidated by the winning rotation.
    const row = await app.prisma.serviceCredential.findUniqueOrThrow({ where: { id: body.id } });
    expect(tokens.map(hashServiceToken)).toContain(row.keyHash);
    for (const token of tokens) {
      const expected = hashServiceToken(token) === row.keyHash;
      expect((await getTable(token, tableA)).statusCode).toBe(expected ? 200 : 401);
    }
    expect((await getTable(body.token, tableA)).statusCode).toBe(401);
  });

  it("maps a duplicate service-principal name race to 409", async () => {
    const name = `svc-name-race-${Date.now()}`;
    const provision = () =>
      app.inject({
        method: "POST",
        url: "/auth/service-principals",
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name },
      });

    const [first, second] = await Promise.all([provision(), provision()]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    expect(JSON.parse(conflict.body).error).toBe("SERVICE_PRINCIPAL_NAME_TAKEN");
    const winner = first.statusCode === 201 ? first : second;
    serviceUserIds.push((JSON.parse(winner.body) as { principalId: string }).principalId);

    // Sequential duplicate is the same stable conflict, never a 500.
    const third = await provision();
    expect(third.statusCode).toBe(409);
    expect(JSON.parse(third.body).error).toBe("SERVICE_PRINCIPAL_NAME_TAKEN");
  });

  it("revokes a service-principal delegation durably and idempotently without touching issued credentials", async () => {
    const name = `delegated-${Date.now()}`;
    const provisioned = await app.inject({
      method: "POST",
      url: "/auth/service-principals",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name, delegatedToPrincipalId: admin.id },
    });
    expect(provisioned.statusCode).toBe(201);
    const principalId = (JSON.parse(provisioned.body) as { principalId: string }).principalId;
    serviceUserIds.push(principalId);

    expect(await app.principalManager.isServicePrincipalDelegatedTo(principalId, admin.id)).toBe(
      true
    );

    // A room credential issued while delegated keeps working after revocation:
    // the explicit policy is that delegation revocation is not an implicit
    // gameplay-credential revocation.
    const { body: credential } = await createCredential(admin.token, {
      name: `delegated-room-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
      principalId,
    });
    expect(credential.userId).toBe(principalId);
    expect((await getTable(credential.token, tableA)).statusCode).toBe(200);

    const revokeUrl = `/auth/service-principals/${principalId}/delegation/revoke`;
    const first = await app.inject({
      method: "POST",
      url: revokeUrl,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body) as {
      success: boolean;
      servicePrincipalId: string;
      delegatePrincipalId: string;
      revokedAt: string;
    };
    expect(firstBody).toEqual({
      success: true,
      servicePrincipalId: principalId,
      delegatePrincipalId: admin.id,
      revokedAt: expect.any(String),
    });
    // The durable gate consumed by roster/credential issuance now fails closed.
    expect(await app.principalManager.isServicePrincipalDelegatedTo(principalId, admin.id)).toBe(
      false
    );

    // Idempotent: same revocation time, exactly one durable audit transition.
    const second = await app.inject({
      method: "POST",
      url: revokeUrl,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(second.statusCode).toBe(200);
    expect((JSON.parse(second.body) as { revokedAt: string }).revokedAt).toBe(firstBody.revokedAt);
    expect(
      await app.prisma.auditLog.count({
        where: {
          action: "SERVICE_PRINCIPAL_DELEGATION_REVOKE",
          resource: `service-principal:${principalId}`,
        },
      })
    ).toBe(1);

    // The already-issued room credential is deliberately untouched.
    expect((await getTable(credential.token, tableA)).statusCode).toBe(200);
  });

  it("restricts delegation revocation to operator wallets with a strict contract", async () => {
    const revokeUrl = `/auth/service-principals/${admin.id}/delegation/revoke`;

    const denied = await app.inject({
      method: "POST",
      url: revokeUrl,
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe("OPERATOR_REQUIRED");

    const { body: serviceCredential } = await createCredential(admin.token, {
      name: `delegation-boundary-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });
    const serviceDenied = await app.inject({
      method: "POST",
      url: revokeUrl,
      headers: { authorization: `Bearer ${serviceCredential.token}` },
    });
    expect(serviceDenied.statusCode).toBe(403);
    // requireOperator runs in onRequest, before the global SERVICE boundary, so
    // machine credentials are rejected as non-operators.
    expect(JSON.parse(serviceDenied.body).error).toBe("OPERATOR_REQUIRED");

    const missing = await app.inject({
      method: "POST",
      url: "/auth/service-principals/no-such-principal/delegation/revoke",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error).toBe("SERVICE_PRINCIPAL_DELEGATION_NOT_FOUND");

    const unknownBody = await app.inject({
      method: "POST",
      url: revokeUrl,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { force: true },
    });
    expect(unknownBody.statusCode).toBe(400);
  });

  it("rejects unbound table credentials at the boundary", async () => {
    const name = `unbound-${Date.now()}`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name, scopes: ["table:observe", "table:act"] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Validation failed");
    expect(await app.prisma.serviceCredential.count({ where: { name } })).toBe(0);
  });

  it("fails a legacy unbound credential closed, including action replay", async () => {
    const { body: backing } = await createCredential(admin.token, {
      name: `legacy-backing-${Date.now()}`,
      scopes: ["table:observe"],
      tableId: tableA,
    });
    const token = generateServiceToken();
    const legacy = await app.prisma.serviceCredential.create({
      data: {
        userId: backing.userId,
        name: `legacy-unbound-${Date.now()}`,
        keyHash: hashServiceToken(token),
        scopes: ["table:observe"],
        tableId: null,
        seat: null,
      },
    });
    createdCredentials.push(legacy.id);

    // Runtime authentication rejects the unbound grant outright, so no request
    // (including an action replay) ever reaches the replay-authorization path.
    expect(await app.principalManager.authenticateServiceToken(token)).toBeNull();
    expect((await getTable(token, tableA)).statusCode).toBe(401);
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
    const replay = await app.inject({
      method: "POST",
      url: `/tables/${tableA}/action`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        requestId: "legacy-replay",
        turnId: "turn-legacy",
        expectedVersion: 1,
        actionId: "action-legacy",
      },
    });
    expect(replay.statusCode).toBe(401);

    // Historical revoked metadata may keep the unbound tableId; authority is
    // gone regardless (and the migration persists this revocation).
    const revoked = await app.inject({
      method: "POST",
      url: `/auth/service-credentials/${legacy.id}/revoke`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(revoked.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(listed.statusCode).toBe(200);
    const row = (
      JSON.parse(listed.body) as {
        credentials: Array<{ id: string; tableId: string | null; revoked: boolean }>;
      }
    ).credentials.find((credential) => credential.id === legacy.id);
    expect(row?.revoked).toBe(true);
    expect(row?.tableId).toBeNull();
    expect((await getTable(token, tableA)).statusCode).toBe(401);
  });

  it("keeps orchestration credentials valid without a resource binding", async () => {
    const { body } = await createCredential(admin.token, {
      name: `orchestrator-${Date.now()}`,
      scopes: ["competition:orchestrate"],
    });
    expect(body.tableId).toBeNull();
    expect(body.seat).toBeNull();

    const principal = await app.principalManager.authenticateServiceToken(body.token);
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual(["competition:orchestrate"]);
    expect(app.principalManager.authorizeOrchestration(principal)).toEqual({
      allowed: true,
      reason: "OK",
    });

    // Mixing or binding orchestration is rejected at the boundary.
    const mixed = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "mixed", scopes: ["competition:orchestrate", "table:act"] },
    });
    expect(mixed.statusCode).toBe(400);
    const bound = await app.inject({
      method: "POST",
      url: "/auth/service-credentials",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "bound-orch", scopes: ["competition:orchestrate"], tableId: tableA },
    });
    expect(bound.statusCode).toBe(400);
  });

  it("sanitizes unexpected Prisma failures without leaking or logging the raw error", async () => {
    // Simulated driver failure carrying database credentials and a code that
    // must never surface in the response or the logs.
    const simulatedSecret = "postgresql://poker:sup3r-s3cret@db.internal:5432/poker";
    const rawError = Object.assign(
      new Error(`driver failure while connecting to ${simulatedSecret}`),
      { code: "P2010", meta: { driverAdapterError: simulatedSecret } }
    );
    const logSpy = vi.spyOn(app.log, "error").mockImplementation(() => undefined);
    const failureSpy = vi
      .spyOn(app.principalManager, "listServiceCredentials")
      .mockRejectedValue(rawError);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/auth/service-credentials",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({
        error: "INTERNAL_ERROR",
        message: "Internal server error",
      });
      expect(res.body).not.toContain(simulatedSecret);
      expect(res.body).not.toContain("P2010");
      expect(res.body).not.toContain("driver failure");

      // Only a request id and a stable message are logged; the raw error object
      // (which may embed credentials) is never passed to the logger.
      expect(logSpy).toHaveBeenCalled();
      const serializedLogs = JSON.stringify(logSpy.mock.calls);
      expect(serializedLogs).not.toContain(simulatedSecret);
      expect(serializedLogs).not.toContain("P2010");
      expect(serializedLogs).not.toContain("driver failure");
      for (const call of logSpy.mock.calls) {
        expect(call[0]).not.toBe(rawError);
      }
    } finally {
      failureSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
