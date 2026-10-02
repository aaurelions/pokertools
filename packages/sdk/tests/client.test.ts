import { describe, it, expect, vi, beforeEach } from "vitest";
import { PokerClient } from "../src/client";
import { PokerSDKError } from "../src/types";

// Mock fetch
const mockFetch = vi.fn();

const wireState = {
  config: { smallBlind: 5, bigBlind: 10, maxPlayers: 2 },
  players: [null, null],
  maxPlayers: 2,
  handNumber: 1,
  buttonSeat: null,
  bigBlindSeat: null,
  deck: [],
  board: [],
  street: "PREFLOP",
  pots: [],
  currentBets: {},
  minRaise: 10,
  lastRaiseAmount: 0,
  actionTo: null,
  lastAggressorSeat: null,
  activePlayers: [],
  winners: null,
  rakeThisHand: 0,
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  blindLevel: 0,
  timeBanks: {},
  timeBankActiveSeat: null,
  actionHistory: [],
  timestamp: 1700000000000,
  handId: "hand-1",
  viewingPlayerId: null,
  version: 5,
};

describe("PokerClient", () => {
  let client: PokerClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PokerClient({
      baseUrl: "https://api.example.com",
      token: "test-token",
      fetch: mockFetch as unknown as typeof fetch,
      retry: { count: 0 }, // Disable retries for tests
    });
  });

  describe("constructor", () => {
    it("initializes with config", () => {
      expect(client.isAuthenticated()).toBe(true);
      expect(client.getToken()).toBe("test-token");
    });

    it("removes trailing slash from baseUrl", () => {
      const c = new PokerClient({
        baseUrl: "https://api.example.com/",
        fetch: mockFetch as unknown as typeof fetch,
      });
      expect(c.isAuthenticated()).toBe(false);
    });
  });

  describe("setToken", () => {
    it("updates the token", () => {
      client.setToken("new-token");
      expect(client.getToken()).toBe("new-token");
    });

    it("can clear the token", () => {
      client.setToken(null);
      expect(client.isAuthenticated()).toBe(false);
    });
  });

  describe("authentication", () => {
    it("getNonce returns nonce", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ nonce: "abc123" }),
      });

      const nonce = await client.getNonce();
      expect(nonce).toBe("abc123");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/auth/nonce",
        expect.objectContaining({
          method: "POST",
          body: undefined,
          headers: { Accept: "application/json", Authorization: "Bearer test-token" },
        })
      );
    });

    it("login sets token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            token: "new-jwt",
            user: { id: "user1", username: "test" },
          }),
      });

      const response = await client.login({
        message: "test message",
        signature: `0x${"a".repeat(130)}`,
      });

      expect(response.token).toBe("new-jwt");
      expect(client.getToken()).toBe("new-jwt");
      expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
    });

    it("logout clears token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await client.logout();
      expect(client.getToken()).toBeNull();
    });
  });

  describe("tables", () => {
    it("getTables returns table list", async () => {
      const tables = [
        {
          id: "t1",
          name: "Table 1",
          config: { name: "Table 1", mode: "CASH", smallBlind: 5, bigBlind: 10, minBuyIn: 100 },
          status: "ACTIVE",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tables }),
      });

      const result = await client.getTables();
      expect(result).toEqual(tables);
    });

    it("rejects table lists that do not match the public schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            tables: [
              {
                id: "t1",
                name: "Table",
                config: { smallBlind: 5, bigBlind: 10, privateKey: "unexpected" },
                status: "ACTIVE",
              },
            ],
          }),
      });
      await expect(client.getTables()).rejects.toThrow();
    });

    it("createTable returns tableId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tableId: "new-table" }),
      });

      const tableId = await client.createTable({
        name: "My Table",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 6,
      });

      expect(tableId).toBe("new-table");
    });

    it("getTableState returns state", async () => {
      const state = { ...wireState, timeBanks: { "0": 90 } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state }),
      });

      const result = await client.getTableState("table-1");
      expect(result).toEqual(state);
    });

    it("rejects table views containing undo history", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state: { ...wireState, previousStates: [] } }),
      });
      await expect(client.getTableState("table-1")).rejects.toThrow();
    });

    it("getTableState returns null on 304", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 304,
        json: () => Promise.reject(new Error("No body")),
      });

      const result = await client.getTableState("table-1", 5);
      expect(result).toBeNull();
    });
  });

  describe("actions", () => {
    const observation = {
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-1",
      version: 5,
      eventSeq: 10,
      state: wireState,
      legalActions: [
        { actionId: "act-fold", family: "FOLD" },
        { actionId: "act-call", family: "CALL", amount: 50 },
        { actionId: "act-bet", family: "BET", minAmount: 100, maxAmount: 500 },
      ],
    };
    // The action receipt must identify its resulting observation: the same
    // table/hand identity and the new (version, eventSeq).
    const resultWireState = { ...wireState, version: 6 };
    const resultObservation = {
      ...observation,
      version: 6,
      eventSeq: 11,
      state: resultWireState,
    };
    const receipt = {
      requestId: "req-1",
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-1",
      actionId: "act-fold",
      version: 6,
      eventSeq: 11,
      acceptedAt: 1700000000000,
    };
    const actionResult = { receipt, observation: resultObservation };

    it("buyIn sends correct request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await client.buyIn("table-1", {
        amount: 500,
        seat: 3,
        idempotencyKey: "key-123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/buy-in",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ amount: 500, seat: 3, idempotencyKey: "key-123" }),
        })
      );
    });

    it("getObservation returns the validated seat observation", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(observation),
      });

      await expect(client.getObservation("table-1")).resolves.toEqual(observation);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/observation",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("rejects a response that is not a valid seat observation", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ...observation, legalActions: [{ family: "FOLD" }] }),
      });

      await expect(client.getObservation("table-1")).rejects.toThrow();
    });

    it("action submits a strict canonical request and returns the stored result", async () => {
      const request = {
        requestId: "req-1",
        turnId: "turn-1",
        expectedVersion: 5,
        actionId: "act-fold",
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(actionResult),
      });

      await expect(client.action("table-1", request)).resolves.toEqual(actionResult);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tables/table-1/action",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(request),
        })
      );
    });

    it("action rejects a request carrying actor identity", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(actionResult) });
      await expect(
        client.action("table-1", {
          requestId: "req-1",
          turnId: "turn-1",
          expectedVersion: 5,
          actionId: "act-fold",
          playerId: "spoofed",
        } as unknown as Parameters<typeof client.action>[1])
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("convenience fold returns the canonical wire state from the result", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(observation) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(actionResult) });

      await expect(client.fold("table-1")).resolves.toEqual(resultWireState);

      const actionCall = mockFetch.mock.calls[1];
      expect(actionCall[0]).toBe("https://api.example.com/tables/table-1/action");
      const body = JSON.parse(actionCall[1].body);
      expect(body).toMatchObject({
        turnId: "turn-1",
        expectedVersion: 5,
        actionId: "act-fold",
      });
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId.length).toBeGreaterThan(0);
    });

    it("bet uses a caller amount bounded by server min/max", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(observation) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(actionResult) });

      await client.bet("table-1", 200);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).amount).toBe(200);
    });

    it("bet rejects an amount outside the server bounds before mutating", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(observation) });
      await expect(client.bet("table-1", 50)).rejects.toMatchObject({ code: "AMOUNT_BELOW_MIN" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws when the server does not offer the requested family", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(observation) });
      await expect(client.check("table-1")).rejects.toMatchObject({ code: "ILLEGAL_ACTION" });
    });
  });

  describe("user", () => {
    it("getProfile returns user data", async () => {
      const profile = {
        id: "user1",
        username: "test",
        address: null,
        role: "PLAYER",
        createdAt: "2026-01-01T00:00:00.000Z",
        chipBalances: {
          available: "1000",
          inPlay: "0",
          tournament: "0",
          totalInPlay: "0",
          pendingWithdrawal: "0",
        },
        assetBalances: [],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(profile),
      });

      const result = await client.getProfile();
      expect(result).toEqual(profile);
    });

    it("getHandHistory returns history", async () => {
      const history = [
        {
          id: "e1",
          amount: 50,
          type: "HAND_WIN",
          referenceId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ history }),
      });

      const result = await client.getHandHistory();
      expect(result).toEqual(history);
    });
  });

  describe("tournaments", () => {
    it("getTournaments returns tournament lobbies", async () => {
      const tournaments = [
        {
          id: "mtt-1",
          name: "Daily MTT",
          status: "REGISTRATION",
          tableId: "table-1",
          buyIn: 1000,
          fee: 100,
          startingStack: 5000,
          maxPlayers: 100,
          tableMaxPlayers: 10,
          balancingTolerance: 2,
          registeredPlayers: 12,
          prizePool: 12000,
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tournaments }),
      });

      await expect(client.getTournaments()).resolves.toEqual(tournaments);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tournaments",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("createTournament posts configuration and returns ids", async () => {
      const response = { tournamentId: "mtt-1", tableId: "table-1" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(
        client.createTournament({
          name: "Daily MTT",
          buyIn: 1000,
          fee: 100,
          startingStack: 5000,
          smallBlind: 25,
          bigBlind: 50,
          maxPlayers: 100,
          tableMaxPlayers: 10,
          balancingTolerance: 2,
          payoutPercentages: [70, 20, 10],
        })
      ).resolves.toEqual(response);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tournaments",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"payoutPercentages":[70,20,10]'),
        })
      );
    });

    it("getTournament returns tournament details", async () => {
      const tournament = {
        id: "mtt-1",
        name: "Daily MTT",
        status: "RUNNING",
        tableId: "table-1",
        buyIn: 1000,
        fee: 100,
        startingStack: 5000,
        maxPlayers: 100,
        tableMaxPlayers: 10,
        balancingTolerance: 2,
        registeredPlayers: 12,
        prizePool: 12000,
        blindStructure: [{ smallBlind: 25, bigBlind: 50, ante: 0 }],
        payoutPercentages: [100],
        tables: [{ id: "table-1", status: "ACTIVE", playerCount: 10 }],
        entries: [],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tournament }),
      });

      await expect(client.getTournament("mtt-1")).resolves.toEqual(tournament);
    });

    it("registerTournament sends seat and idempotency key", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await expect(
        client.registerTournament("mtt-1", { seat: 3, idempotencyKey: "idem-1" })
      ).resolves.toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tournaments/mtt-1/register",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ seat: 3, idempotencyKey: "idem-1" }),
        })
      );
    });

    it("startTournament returns all table ids and distribution", async () => {
      const response = { success: true, tableIds: ["t1", "t2"], distribution: [6, 6] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(client.startTournament("mtt-1")).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tournaments/mtt-1/start",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("reconcileTournament returns updated entries and tables", async () => {
      const response = { success: true, tables: [], entries: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(client.reconcileTournament("mtt-1")).resolves.toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/tournaments/mtt-1/reconcile",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("advanceTournamentBlinds returns per-table results", async () => {
      const response = { results: { t1: { blindLevel: 2 } } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(client.advanceTournamentBlinds("mtt-1")).resolves.toEqual(response);
    });

    it("settleTournament returns payout distribution", async () => {
      const response = {
        success: true,
        winnerUserId: "u1",
        prize: 700,
        payouts: [
          { userId: "u1", placement: 1, amount: 700 },
          { userId: "u2", placement: 2, amount: 300 },
        ],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(client.settleTournament("mtt-1")).resolves.toEqual(response);
    });
  });

  describe("finance", () => {
    const assetId = "eip155:31337/erc20:0x5fbdb2315678afecb367f032d93f642f64180aa3";
    const asset = {
      assetId,
      chainId: 31337,
      tokenAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      decimals: 6,
      symbol: "USDC",
      status: "ACTIVE",
      confirmations: 12,
      deepFinality: 64,
    };
    const balance = {
      principalId: "p1",
      assetId,
      availableAtomic: "1000000",
      inPlayAtomic: "250000",
      pendingWithdrawalAtomic: "0",
    };
    const deposit = {
      id: "dep-1",
      assetId,
      txHash: `0x${"ab".repeat(32)}`,
      logIndex: 3,
      principalId: "p1",
      amountAtomic: "1000000",
      status: "CREDITED",
      provenance: "DIRECT_TREASURY",
    };
    const intent = {
      intentId: "intent-1",
      principalId: "p1",
      assetId,
      destination: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      amountAtomic: "1000000",
      nonce: 7,
      deadline: 1893456000,
      chainId: 31337,
    };
    const submission = { intent, signature: `0x${"ab".repeat(65)}` };
    // A withdrawal record is the full signed intent plus its lifecycle fields;
    // it must retain every EIP-712-bound economic field.
    const withdrawal = {
      ...intent,
      status: "SIGNED",
      txHash: null,
    };

    it("getAssets returns the canonical asset registry", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ assets: [asset] }),
      });

      await expect(client.getAssets()).resolves.toEqual([asset]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/finance/assets",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("getBalances returns atomic decimal-string balances", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ balances: [balance] }),
      });

      // The parsed balance materializes the schema defaults for the reserve
      // and obligation buckets, which may be omitted on the wire.
      await expect(client.getBalances()).resolves.toEqual([
        { ...balance, tournamentReserveAtomic: "0", incidentObligationAtomic: "0" },
      ]);
    });

    it("claimDeposit posts exact log identity", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deposit),
      });

      await expect(
        client.claimDeposit({ assetId, txHash: deposit.txHash, logIndex: 3 })
      ).resolves.toEqual(deposit);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/finance/deposits/claim",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ assetId, txHash: deposit.txHash, logIndex: 3 }),
        })
      );
    });

    it("getDeposit fetches by id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(deposit) });
      await expect(client.getDeposit("dep-1")).resolves.toEqual(deposit);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/finance/deposits/dep-1",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("submitWithdrawal posts the signed canonical intent", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(withdrawal) });
      await expect(client.submitWithdrawal(submission)).resolves.toEqual(withdrawal);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/finance/withdrawals/intents",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(submission),
        })
      );
    });

    it("submitWithdrawal rejects non-canonical atomic amounts before mutating", async () => {
      await expect(
        client.submitWithdrawal({
          ...submission,
          intent: { ...intent, amountAtomic: "1.5" },
        })
      ).rejects.toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("getWithdrawal fetches by intent id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(withdrawal) });
      await expect(client.getWithdrawal("intent-1")).resolves.toEqual(withdrawal);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/finance/withdrawals/intent-1",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("notes", () => {
    const wireNote = {
      id: "n1",
      authorId: "user1",
      targetId: "user2",
      content: "test",
      label: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("getNotes returns note list", async () => {
      const notes = [wireNote];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notes }),
      });

      const result = await client.getNotes();
      expect(result).toEqual(notes);
    });

    it("saveNote creates/updates note", async () => {
      const note = { ...wireNote, content: "updated" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, note }),
      });

      const result = await client.saveNote("user2", "updated", "TAG");
      expect(result).toEqual(note);
    });

    it("deleteNote removes note", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      await client.deleteNote("user2");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/notes/user2",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("error handling", () => {
    it("throws PokerSDKError on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "BAD_REQUEST", message: "Invalid" }),
      });

      await expect(client.getTables()).rejects.toThrow(PokerSDKError);
    });

    it("includes error details", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: "FORBIDDEN", message: "Not allowed" }),
      });

      try {
        await client.getTables();
        expect.fail("Should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(PokerSDKError);
        expect((error as PokerSDKError).code).toBe("FORBIDDEN");
        expect((error as PokerSDKError).statusCode).toBe(403);
      }
    });

    it("handles timeout", async () => {
      mockFetch.mockImplementationOnce(() => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      });

      await expect(client.getTables()).rejects.toThrow("Request timeout");
    });
  });

  describe("authorization header", () => {
    it("includes auth header when token set", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tables: [] }),
      });

      await client.getTables();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        })
      );
    });

    it("omits auth header when no token", async () => {
      client.setToken(null);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ nonce: "abc" }),
      });

      await client.getNonce();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
