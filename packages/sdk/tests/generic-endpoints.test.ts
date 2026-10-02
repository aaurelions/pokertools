import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateServiceCredentialRequest } from "@pokertools/types";
import { PokerClient } from "../src/client";
import { PokerSDKError } from "../src/types";

/**
 * Regression coverage for generic public API surfaces the SDK previously
 * omitted: identity (`GET /auth/me`), operator service-credential CRUD
 * (`/auth/service-credentials*`), platform readiness (`GET /ready`), and the
 * append-only table streams (`/tables/:id/chat`, `/tables/:id/replay`).
 *
 * Fixtures mirror the exact wire bodies asserted by the API integration tests
 * (`service-auth.test.ts`, `production-readiness.test.ts`,
 * `canonical-protocol.test.ts`) so SDK parsing and API responses cannot drift.
 */

const mockFetch = vi.fn();

const principal = {
  id: "principal-1",
  kind: "WALLET",
  walletAddress: "0x1111111111111111111111111111111111111111",
};

const readiness = {
  status: "not_ready",
  timestamp: 1700000000000,
  checks: [
    { name: "database", state: "READY", mandatory: true, latencyMs: 3, detail: "SELECT 1" },
    { name: "redis", state: "READY", mandatory: true, latencyMs: 1, detail: "PONG" },
    { name: "migrations", state: "DEGRADED", mandatory: false, latencyMs: 0, detail: "not probed" },
  ],
  financial: {
    state: "BLOCKED",
    reasons: ["ASSET_LEDGER_UNVERIFIED"],
    checks: [{ name: "ledger", state: "BLOCKED" }],
  },
};

const createdCredential = {
  id: "abcdef0123456789",
  userId: "svc-user-1",
  name: "bot-1",
  scopes: ["table:observe", "table:chat"],
  tableId: "table-1",
  seat: null,
  expiresAt: null,
  token: "ptsvc_one_time_token",
};

const credentialSummary = {
  id: createdCredential.id,
  userId: createdCredential.userId,
  name: createdCredential.name,
  scopes: createdCredential.scopes,
  tableId: createdCredential.tableId,
  seat: createdCredential.seat,
  revoked: false,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const chatMessage = {
  messageId: "msg-1",
  tableId: "table-1",
  handId: "hand-1",
  eventSeq: 12,
  principalId: "principal-1",
  body: "hello",
  sentAt: 1700000000000,
};

const chatPage = {
  tableId: "table-1",
  messages: [chatMessage],
  nextBeforeSeq: null,
};

const replayFrame = {
  tableId: "table-1",
  fromEventSeq: 1,
  toEventSeq: 1,
  anchorHash: null,
  headEventSeq: 1,
  events: [
    {
      eventId: "event-1",
      tableId: "table-1",
      eventSeq: 1,
      version: 0,
      type: "TABLE_CREATED",
      occurredAt: 1700000000000,
      payload: {},
      previousHash: null,
      hash: "hash-1",
    },
  ],
  chainValid: true,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function httpError(status: number, body: unknown) {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

describe("PokerClient generic public endpoints", () => {
  let client: PokerClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PokerClient({
      baseUrl: "https://api.example.com",
      token: "test-token",
      fetch: mockFetch as unknown as typeof fetch,
      retry: { count: 0 },
    });
  });

  describe("identity", () => {
    it("getPrincipal returns the canonical three-field principal from GET /auth/me", async () => {
      mockFetch.mockResolvedValueOnce(ok(principal));

      await expect(client.getPrincipal()).resolves.toEqual(principal);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/me",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("rejects a principal response carrying authority fields beyond the public contract", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...principal, scopes: ["table:act"] }));

      await expect(client.getPrincipal()).rejects.toThrow();
    });
  });

  describe("service credentials", () => {
    it("createServiceCredential posts the strict operator request and returns the one-time token", async () => {
      mockFetch.mockResolvedValueOnce(ok(createdCredential));
      const request: CreateServiceCredentialRequest = {
        name: "bot-1",
        scopes: ["table:observe", "table:chat"],
        tableId: "table-1",
      };

      await expect(client.createServiceCredential(request)).resolves.toEqual(createdCredential);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/service-credentials",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("createServiceCredential issues for an existing principal with the orchestration scope", async () => {
      const request: CreateServiceCredentialRequest = {
        principalId: "svc-principal-1",
        name: "orchestrator",
        scopes: ["competition:orchestrate"],
      };
      mockFetch.mockResolvedValueOnce(
        ok({ ...createdCredential, name: "orchestrator", scopes: ["competition:orchestrate"] })
      );

      await expect(client.createServiceCredential(request)).resolves.toMatchObject({
        scopes: ["competition:orchestrate"],
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/service-credentials",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("rejects an unsupported scope before any network call", async () => {
      await expect(
        client.createServiceCredential({
          name: "bot-1",
          // The API supports table-scoped scopes only.
          scopes: ["table:admin" as never],
        })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects an unsupported mint attempt (non-admin caller) as a typed PokerSDKError", async () => {
      mockFetch.mockResolvedValueOnce(
        httpError(403, { error: "OPERATOR_REQUIRED", message: "Operator required" })
      );

      await expect(
        client.createServiceCredential({ name: "bot-1", scopes: ["table:observe"] })
      ).rejects.toMatchObject({ statusCode: 403, code: "OPERATOR_REQUIRED" });
    });

    it("listServiceCredentials returns the summary list from GET /auth/service-credentials", async () => {
      mockFetch.mockResolvedValueOnce(ok({ credentials: [credentialSummary] }));

      await expect(client.listServiceCredentials()).resolves.toEqual([credentialSummary]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/service-credentials",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("revokeServiceCredential posts to the revoke path and validates the response", async () => {
      mockFetch.mockResolvedValueOnce(ok({ success: true }));

      await expect(client.revokeServiceCredential(credentialSummary.id)).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.example.com/auth/service-credentials/${credentialSummary.id}/revoke`,
        expect.objectContaining({ method: "POST" })
      );
    });

    it("rejects a malformed credential id before any network call", async () => {
      await expect(client.revokeServiceCredential("not a credential id!")).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a revoke response that does not assert success", async () => {
      mockFetch.mockResolvedValueOnce(ok({ success: false }));

      await expect(client.revokeServiceCredential(credentialSummary.id)).rejects.toThrow();
    });
  });

  describe("service principal administration", () => {
    const provisioned = {
      principalId: "svc-principal-1",
      name: "agent-principal",
      kind: "SERVICE",
      delegatedToPrincipalId: "orchestrator-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    it("provisionServicePrincipal posts the strict request and returns the durable principal", async () => {
      mockFetch.mockResolvedValueOnce(ok(provisioned));
      const request = { name: "agent-principal", delegatedToPrincipalId: "orchestrator-1" };

      await expect(client.provisionServicePrincipal(request)).resolves.toEqual(provisioned);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/service-principals",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("provisionServicePrincipal rejects unknown request fields before any network call", async () => {
      await expect(
        client.provisionServicePrincipal({ name: "agent-principal", isOperator: true } as never)
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("provisionServicePrincipal rejects a projection that is not a SERVICE principal", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...provisioned, kind: "WALLET" }));

      await expect(client.provisionServicePrincipal({ name: "agent-principal" })).rejects.toThrow();
    });

    it("never retries the non-idempotent provision after a transport failure", async () => {
      const retryClient = new PokerClient({
        baseUrl: "https://api.example.com",
        token: "test-token",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { count: 2, delay: 0, backoff: 1 },
      });
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(
        retryClient.provisionServicePrincipal({ name: "agent-principal" })
      ).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("rotateServiceCredential posts optional expiresAt and returns the one-time token", async () => {
      const rotated = { ...createdCredential, token: "ptsvc_rotated_token" };
      mockFetch.mockResolvedValueOnce(ok(rotated));
      const request = { expiresAt: "2027-01-01T00:00:00.000Z" };

      await expect(client.rotateServiceCredential(credentialSummary.id, request)).resolves.toEqual(
        rotated
      );
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.example.com/auth/service-credentials/${credentialSummary.id}/rotate`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("rotateServiceCredential defaults to an empty strict body", async () => {
      mockFetch.mockResolvedValueOnce(ok(createdCredential));

      await expect(client.rotateServiceCredential(credentialSummary.id)).resolves.toEqual(
        createdCredential
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({});
    });

    it("rotateServiceCredential rejects a malformed credential id before any network call", async () => {
      await expect(client.rotateServiceCredential("not a credential id!")).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rotateServiceCredential rejects a malformed rotation body before any network call", async () => {
      await expect(
        client.rotateServiceCredential(credentialSummary.id, { expiresAt: "not-a-date" })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rotateServiceCredential rejects a response that is not the created-credential contract", async () => {
      mockFetch.mockResolvedValueOnce(ok({ success: true }));

      await expect(client.rotateServiceCredential(credentialSummary.id)).rejects.toThrow();
    });

    it("never retries the non-idempotent rotation after a transport failure", async () => {
      const retryClient = new PokerClient({
        baseUrl: "https://api.example.com",
        token: "test-token",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { count: 2, delay: 0, backoff: 1 },
      });
      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(retryClient.rotateServiceCredential(credentialSummary.id)).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("readiness", () => {
    it("getReadiness resolves the canonical not-ready body on HTTP 503", async () => {
      mockFetch.mockResolvedValueOnce(httpError(503, readiness));

      const result = await client.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.financial.state).toBe("BLOCKED");
      expect(result.checks[0].name).toBe("database");
    });

    it("getReadiness resolves the ready body on HTTP 200", async () => {
      const ready = {
        status: "ready",
        timestamp: 1700000000001,
        checks: [{ name: "database", state: "READY", mandatory: true, latencyMs: 2, detail: "ok" }],
        financial: { state: "READY", reasons: [], checks: [] },
      };
      mockFetch.mockResolvedValueOnce(ok(ready));

      await expect(client.getReadiness()).resolves.toEqual(ready);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/ready",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("getReadiness still throws on an unexpected transport failure", async () => {
      mockFetch.mockResolvedValueOnce(
        httpError(500, { error: "INTERNAL_ERROR", message: "Internal server error" })
      );

      await expect(client.getReadiness()).rejects.toBeInstanceOf(PokerSDKError);
    });
  });

  describe("table chat", () => {
    it("getChat returns the validated page and forwards bounded paging", async () => {
      mockFetch.mockResolvedValueOnce(ok(chatPage));

      await expect(client.getChat("table-1", { limit: 50, beforeSeq: 12 })).resolves.toEqual(
        chatPage
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/chat?limit=50&beforeSeq=12",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("getChat without options requests the server default page", async () => {
      mockFetch.mockResolvedValueOnce(ok(chatPage));

      await client.getChat("table-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/chat",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("sendChat posts the escaped server contract body and returns the message", async () => {
      const message = { ...chatMessage, body: "&lt;b&gt;hi&lt;/b&gt;" };
      mockFetch.mockResolvedValueOnce(ok(message));

      await expect(client.sendChat("table-1", "<b>hi</b>")).resolves.toEqual(message);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/chat",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ body: "<b>hi</b>" }),
        })
      );
    });

    it("sendChat rejects a malformed chat message response", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...chatMessage, body: "" }));

      await expect(client.sendChat("table-1", "hi")).rejects.toThrow();
    });
  });

  describe("table replay", () => {
    it("getReplay forwards the event range and returns the validated hash-chained frame", async () => {
      const frame = { ...replayFrame, toEventSeq: 1 };
      mockFetch.mockResolvedValueOnce(ok(frame));

      await expect(client.getReplay("table-1", { fromEventSeq: 1 })).resolves.toEqual(frame);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/replay?fromEventSeq=1",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("getReplay includes toEventSeq when bounded", async () => {
      const secondEvent = {
        ...replayFrame.events[0],
        eventId: "event-2",
        eventSeq: 2,
        version: 1,
        type: "HAND_STARTED",
        previousHash: "hash-1",
        hash: "hash-2",
      };
      mockFetch.mockResolvedValueOnce(
        ok({
          ...replayFrame,
          toEventSeq: 2,
          headEventSeq: 2,
          events: [...replayFrame.events, secondEvent],
        })
      );

      await client.getReplay("table-1", { fromEventSeq: 1, toEventSeq: 2 });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/replay?fromEventSeq=1&toEventSeq=2",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("rejects a non-positive fromEventSeq before any network call", async () => {
      await expect(client.getReplay("table-1", { fromEventSeq: 0 })).rejects.toMatchObject({
        code: "INVALID_REPLAY_RANGE",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a toEventSeq preceding fromEventSeq before any network call", async () => {
      await expect(
        client.getReplay("table-1", { fromEventSeq: 3, toEventSeq: 2 })
      ).rejects.toMatchObject({ code: "INVALID_REPLAY_RANGE" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a malformed replay frame (broken hash chain)", async () => {
      mockFetch.mockResolvedValueOnce(
        ok({
          ...replayFrame,
          events: [{ ...replayFrame.events[0], hash: "" }],
        })
      );

      await expect(client.getReplay("table-1", { fromEventSeq: 1 })).rejects.toThrow();
    });
  });
});
