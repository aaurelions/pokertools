import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateCompetitionRequest, IssueAgentCredentialRequest } from "@pokertools/types";
import { CompetitionClient } from "../src/competition-client";
import { PokerSDKError } from "../src/types";

/**
 * Typed endpoint contract tests for the generic competition surface.
 *
 * Fixtures mirror the committed canonical schemas in
 * `@pokertools/types/canonical/competition.ts` (strict objects, canonical
 * atomic decimal strings, server-assigned seats). `createCompetition` is
 * idempotent on `idempotencyKey`; the lifecycle mutations (`optIn`, `start`,
 * `settle`, `cancel`) have strict empty-object bodies and are naturally
 * idempotent from durable server state, so the transport retries them only
 * because the client explicitly declares them retry-safe.
 */

const mockFetch = vi.fn();

const ASSET_ID = "eip155:8453/erc20:0x1111111111111111111111111111111111111111";

const competition = {
  id: "comp-1",
  name: "Asset table",
  mode: "ASSET",
  status: "REGISTRATION",
  tableId: "table-1",
  organizerPrincipalId: "org-1",
  maxEntrants: 2,
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  entrants: [
    { principalId: "wallet-1", kind: "WALLET", seat: 0, entryState: "PAID" },
    { principalId: "agent-1", kind: "SERVICE", seat: 1, entryState: "NOT_REQUIRED" },
  ],
  terms: {
    entry: {
      assetId: ASSET_ID,
      amountAtomic: "1000000",
      payers: [{ principalId: "wallet-1", amountAtomic: "1000000" }],
    },
    prize: {
      assetId: ASSET_ID,
      amountAtomic: "5000000",
      sponsorPrincipalId: "sponsor-1",
    },
  },
  prizeStatus: "RESERVED",
  settlementReady: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
};

const createRequest: CreateCompetitionRequest = {
  name: "Asset table",
  mode: "ASSET",
  entrants: [
    { principalId: "wallet-1", kind: "WALLET" },
    { principalId: "agent-1", kind: "SERVICE" },
  ],
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  terms: {
    entry: {
      assetId: ASSET_ID,
      amountAtomic: "1000000",
      payers: [{ principalId: "wallet-1", amountAtomic: "1000000" }],
    },
    prize: {
      assetId: ASSET_ID,
      amountAtomic: "5000000",
      sponsorPrincipalId: "sponsor-1",
    },
  },
  idempotencyKey: "create-1",
};

const optInResponse = {
  success: true,
  competitionId: "comp-1",
  principalId: "wallet-1",
  entryState: "PAID",
  entry: { assetId: ASSET_ID, amountAtomic: "1000000" },
  journalRequestId: "journal-1",
};

const startResponse = {
  success: true,
  competitionId: "comp-1",
  tableId: "table-1",
  seats: [
    { principalId: "wallet-1", seat: 0 },
    { principalId: "agent-1", seat: 1 },
  ],
};

const settleResponse = {
  success: true,
  competitionId: "comp-1",
  winnerPrincipalId: "wallet-1",
  winnerKind: "WALLET",
  prizeStatus: "PAID",
  prize: { assetId: ASSET_ID, amountAtomic: "5000000" },
  placements: [
    {
      principalId: "wallet-1",
      kind: "WALLET",
      placement: 1,
      prize: { assetId: ASSET_ID, amountAtomic: "5000000" },
    },
    { principalId: "agent-1", kind: "SERVICE", placement: 2, prize: null },
  ],
};

const cancelResponse = {
  success: true,
  competitionId: "comp-1",
  status: "CANCELLED",
  cancelledAt: "2026-01-01T00:00:05.000Z",
  prizeStatus: "RELEASED",
  prize: { assetId: ASSET_ID, amountAtomic: "5000000" },
  entries: [
    {
      principalId: "wallet-1",
      kind: "WALLET",
      entryState: "REFUNDED",
      refunded: true,
      refundJournalId: "journal-1",
    },
    {
      principalId: "agent-1",
      kind: "SERVICE",
      entryState: "NOT_REQUIRED",
      refunded: false,
      refundJournalId: null,
    },
  ],
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function httpError(status: number, body: unknown) {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

describe("CompetitionClient", () => {
  let client: CompetitionClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new CompetitionClient({
      baseUrl: "https://api.example.com",
      token: "orchestrator-token",
      fetch: mockFetch as unknown as typeof fetch,
      retry: { count: 0 },
    });
  });

  describe("configuration", () => {
    it("manages the orchestration token like PokerClient", () => {
      expect(client.isAuthenticated()).toBe(true);
      expect(client.getToken()).toBe("orchestrator-token");
      client.setToken(null);
      expect(client.isAuthenticated()).toBe(false);
    });

    it("does not log the bearer token when debug is enabled", async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
      const debugClient = new CompetitionClient({
        baseUrl: "https://api.example.com",
        token: "super-secret-orchestrator-token",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { count: 0 },
        debug: true,
      });
      mockFetch.mockResolvedValueOnce(ok({ competition }));
      try {
        await debugClient.getCompetition("comp-1");
        expect(logSpy).toHaveBeenCalled();
        expect(logs.join("\n")).not.toContain("super-secret-orchestrator-token");
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("createCompetition", () => {
    it("POSTs the strict canonical body and returns the validated response", async () => {
      const response = { success: true, competition, replayed: false };
      mockFetch.mockResolvedValueOnce(ok(response));

      await expect(client.createCompetition(createRequest)).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(createRequest),
          headers: expect.objectContaining({
            Authorization: "Bearer orchestrator-token",
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("surfaces an idempotent replay flag from the server", async () => {
      mockFetch.mockResolvedValueOnce(ok({ success: true, competition, replayed: true }));

      const result = await client.createCompetition(createRequest);
      expect(result.replayed).toBe(true);
    });

    it("rejects ASSET terms smuggled into NONFINANCIAL before any network call", async () => {
      await expect(
        client.createCompetition({
          ...createRequest,
          mode: "NONFINANCIAL",
        })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects missing ASSET terms before any network call", async () => {
      await expect(
        client.createCompetition({
          name: "Asset table",
          mode: "ASSET",
          entrants: createRequest.entrants,
          idempotencyKey: "create-2",
        })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a duplicate roster before any network call", async () => {
      await expect(
        client.createCompetition({
          name: "Dupes",
          mode: "NONFINANCIAL",
          entrants: [
            { principalId: "wallet-1", kind: "WALLET" },
            { principalId: "wallet-1", kind: "WALLET" },
          ],
          idempotencyKey: "create-3",
        })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a malformed server projection", async () => {
      mockFetch.mockResolvedValueOnce(
        ok({ success: true, competition: { ...competition, entrants: [] }, replayed: false })
      );

      await expect(client.createCompetition(createRequest)).rejects.toThrow();
    });
  });

  describe("getCompetition", () => {
    it("GETs the encoded id path and returns the validated competition", async () => {
      mockFetch.mockResolvedValueOnce(ok({ competition }));

      await expect(client.getCompetition("comp/1 x")).resolves.toEqual(competition);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp%2F1%20x",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("rejects a projection leaking fields outside the public contract", async () => {
      mockFetch.mockResolvedValueOnce(
        ok({ competition: { ...competition, walletAddress: "0x1" } })
      );

      await expect(client.getCompetition("comp-1")).rejects.toThrow();
    });
  });

  describe("optIn", () => {
    it("POSTs the strict empty body and returns the persisted entry", async () => {
      mockFetch.mockResolvedValueOnce(ok(optInResponse));

      await expect(client.optIn("comp-1")).resolves.toEqual(optInResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/opt-in",
        expect.objectContaining({
          method: "POST",
          body: "{}",
        })
      );
    });

    it("returns the immutable journal receipt with live REFUNDED state after cancellation", async () => {
      const refunded = { ...optInResponse, entryState: "REFUNDED" };
      mockFetch.mockResolvedValueOnce(ok(refunded));

      await expect(client.optIn("comp-1")).resolves.toEqual(refunded);
    });

    it("rejects the removed conversionId receipt field (no alias)", async () => {
      const legacy: Record<string, unknown> = { ...optInResponse };
      delete legacy.journalRequestId;
      legacy.conversionId = "conv-1";
      mockFetch.mockResolvedValueOnce(ok(legacy));

      await expect(client.optIn("comp-1")).rejects.toThrow();
    });

    it("rejects a response that does not match the canonical entry contract", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...optInResponse, entryState: "PENDING" }));

      await expect(client.optIn("comp-1")).rejects.toThrow();
    });
  });

  describe("start", () => {
    it("POSTs the strict empty body and returns authoritative seat assignments", async () => {
      mockFetch.mockResolvedValueOnce(ok(startResponse));

      await expect(client.start("comp-1")).resolves.toEqual(startResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/start",
        expect.objectContaining({
          method: "POST",
          body: "{}",
        })
      );
    });
  });

  describe("settle", () => {
    it("POSTs the strict empty body and returns placements plus prize disposition", async () => {
      mockFetch.mockResolvedValueOnce(ok(settleResponse));

      await expect(client.settle("comp-1")).resolves.toEqual(settleResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/settle",
        expect.objectContaining({
          method: "POST",
          body: "{}",
        })
      );
    });
  });

  describe("cancel", () => {
    it("POSTs the strict empty body and returns durable refund facts", async () => {
      mockFetch.mockResolvedValueOnce(ok(cancelResponse));

      await expect(client.cancel("comp-1")).resolves.toEqual(cancelResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/cancel",
        expect.objectContaining({
          method: "POST",
          body: "{}",
        })
      );
    });

    it("rejects a cancellation response outside the canonical contract", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...cancelResponse, entries: [] }));

      await expect(client.cancel("comp-1")).rejects.toThrow();
    });
  });

  describe("issueAgentCredential", () => {
    const response = {
      credentialId: "cred-1",
      principalId: "agent-1",
      competitionId: "comp-1",
      tableId: "table-1",
      name: "agent-1",
      scopes: ["table:observe", "table:act"],
      seat: 1,
      expiresAt: null,
      token: "ptsvc_one_time_token",
      rotated: false,
    };

    it("POSTs the strict issuance body and returns the one-time token", async () => {
      const request: IssueAgentCredentialRequest = {
        principalId: "agent-1",
        name: "agent-1",
        scopes: ["table:observe", "table:act"],
      };
      mockFetch.mockResolvedValueOnce(ok(response));

      await expect(client.issueAgentCredential("comp-1", request)).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/agent-credentials",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("supports in-place rotation by credentialId", async () => {
      mockFetch.mockResolvedValueOnce(ok({ ...response, rotated: true }));

      const result = await client.issueAgentCredential("comp-1", {
        principalId: "agent-1",
        name: "agent-1",
        credentialId: "cred-1",
      });
      expect(result.rotated).toBe(true);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).credentialId).toBe("cred-1");
    });

    it("rejects an issuance body requesting orchestration authority", async () => {
      await expect(
        client.issueAgentCredential("comp-1", {
          principalId: "agent-1",
          name: "agent-1",
          scopes: ["competition:orchestrate"],
        } as never)
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("never retries the non-idempotent mint after a transport failure", async () => {
      const retryClient = new CompetitionClient({
        baseUrl: "https://api.example.com",
        token: "orchestrator-token",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { count: 2, delay: 0, backoff: 1 },
      });
      mockFetch.mockRejectedValue(new Error("Connection lost after server committed"));

      await expect(
        retryClient.issueAgentCredential("comp-1", { principalId: "agent-1", name: "agent-1" })
      ).rejects.toThrow(/Connection lost/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("error and retry semantics", () => {
    it("throws a typed PokerSDKError on a mutation 503 instead of accepting the body", async () => {
      mockFetch.mockResolvedValueOnce(
        httpError(503, { error: "NOT_READY", message: "Platform not ready" })
      );

      await expect(client.createCompetition(createRequest)).rejects.toMatchObject({
        statusCode: 503,
        code: "NOT_READY",
      });
    });

    it("retries an idempotent create with identical bytes after a transport failure", async () => {
      const retryClient = new CompetitionClient({
        baseUrl: "https://api.example.com",
        token: "orchestrator-token",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { count: 1, delay: 0, backoff: 1 },
      });
      mockFetch
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce(ok({ success: true, competition, replayed: false }));

      await expect(retryClient.createCompetition(createRequest)).resolves.toMatchObject({
        success: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1].body).toBe(mockFetch.mock.calls[1][1].body);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).idempotencyKey).toBe("create-1");
    });

    it("does not retry a rejected create with a missing idempotency key", async () => {
      // The schema rejects before transport, so no request is attempted or retried.
      await expect(
        client.createCompetition({ ...createRequest, idempotencyKey: "" })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    const retrySafeOperations = [
      { name: "optIn", call: (c: CompetitionClient) => c.optIn("comp-1"), response: optInResponse },
      { name: "start", call: (c: CompetitionClient) => c.start("comp-1"), response: startResponse },
      {
        name: "settle",
        call: (c: CompetitionClient) => c.settle("comp-1"),
        response: settleResponse,
      },
      {
        name: "cancel",
        call: (c: CompetitionClient) => c.cancel("comp-1"),
        response: cancelResponse,
      },
    ];

    it.each(retrySafeOperations)(
      "retries $name with identical empty bytes after a transport failure",
      async ({ call, response }) => {
        const retryClient = new CompetitionClient({
          baseUrl: "https://api.example.com",
          token: "orchestrator-token",
          fetch: mockFetch as unknown as typeof fetch,
          retry: { count: 1, delay: 0, backoff: 1 },
        });
        mockFetch
          .mockRejectedValueOnce(new Error("ECONNRESET"))
          .mockResolvedValueOnce(ok(response));

        await expect(call(retryClient)).resolves.toEqual(response);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[0][1].body).toBe("{}");
        expect(mockFetch.mock.calls[1][1].body).toBe("{}");
      }
    );

    it("parses the canonical error envelope into a typed error", async () => {
      mockFetch.mockResolvedValueOnce(
        httpError(403, { error: "ORCHESTRATION_REQUIRED", message: "Not an orchestrator" })
      );

      await expect(client.start("comp-1")).rejects.toBeInstanceOf(PokerSDKError);
    });
  });
});
