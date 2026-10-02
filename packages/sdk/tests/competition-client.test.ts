import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateCompetitionRequest, IssueAgentCredentialRequest } from "@pokertools/types";
import { CompetitionClient } from "../src/competition-client";
import { PokerSDKError } from "../src/types";

/**
 * Typed endpoint contract tests for the generic competition surface.
 *
 * Fixtures mirror the committed canonical schemas in
 * `@pokertools/types/canonical/competition.ts` (strict objects, canonical
 * atomic decimal strings, server-assigned seats). Every mutating body is
 * idempotent on `idempotencyKey`, which is what makes transport retry safe.
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
    const response = {
      success: true,
      competitionId: "comp-1",
      principalId: "wallet-1",
      entryState: "PAID",
      entry: { assetId: ASSET_ID, amountAtomic: "1000000" },
      conversionId: "conv-1",
    };

    it("POSTs only the idempotency body and returns the persisted entry", async () => {
      mockFetch.mockResolvedValueOnce(ok(response));

      await expect(client.optIn("comp-1", { idempotencyKey: "optin-1" })).resolves.toEqual(
        response
      );
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/opt-in",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ idempotencyKey: "optin-1" }),
        })
      );
    });

    it("rejects a body that tries to choose the payer identity", async () => {
      await expect(
        client.optIn("comp-1", { idempotencyKey: "optin-2", principalId: "someone-else" } as never)
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("startCompetition", () => {
    it("POSTs the idempotency body and returns authoritative seat assignments", async () => {
      const response = {
        success: true,
        competitionId: "comp-1",
        tableId: "table-1",
        seats: [
          { principalId: "wallet-1", seat: 0 },
          { principalId: "agent-1", seat: 1 },
        ],
      };
      mockFetch.mockResolvedValueOnce(ok(response));

      await expect(
        client.startCompetition("comp-1", { idempotencyKey: "start-1" })
      ).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ idempotencyKey: "start-1" }),
        })
      );
    });
  });

  describe("settleCompetition", () => {
    it("POSTs the idempotency body and returns placements plus prize disposition", async () => {
      const response = {
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
      mockFetch.mockResolvedValueOnce(ok(response));

      await expect(
        client.settleCompetition("comp-1", { idempotencyKey: "settle-1" })
      ).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/competitions/comp-1/settle",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ idempotencyKey: "settle-1" }),
        })
      );
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

    it("retries an idempotent mutation with identical bytes after a transport failure", async () => {
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

    it("parses the canonical error envelope into a typed error", async () => {
      mockFetch.mockResolvedValueOnce(
        httpError(403, { error: "ORCHESTRATION_REQUIRED", message: "Not an orchestrator" })
      );

      await expect(
        client.startCompetition("comp-1", { idempotencyKey: "start-2" })
      ).rejects.toBeInstanceOf(PokerSDKError);
    });
  });
});
