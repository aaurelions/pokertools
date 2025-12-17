import { describe, it, expect, vi, beforeEach } from "vitest";
import { PokerClient } from "../src/client";
import { PokerSDKError } from "../src/types";

// Mock fetch
const mockFetch = vi.fn();

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
        expect.objectContaining({ method: "POST" })
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
        signature: "0x123",
      });

      expect(response.token).toBe("new-jwt");
      expect(client.getToken()).toBe("new-jwt");
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
      const tables = [{ id: "t1", name: "Table 1", config: {}, status: "ACTIVE" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tables }),
      });

      const result = await client.getTables();
      expect(result).toEqual(tables);
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
      const state = { pot: 100, players: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state }),
      });

      const result = await client.getTableState("table-1");
      expect(result).toEqual(state);
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

    it("action returns updated state", async () => {
      const state = { pot: 150, players: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state }),
      });

      const result = await client.action("table-1", { type: "CALL" });
      expect(result).toEqual(state);
    });

    it("convenience methods work", async () => {
      const state = { pot: 100, players: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ state }),
      });

      await client.fold("table-1");
      await client.check("table-1");
      await client.call("table-1");
      await client.bet("table-1", 50);
      await client.raise("table-1", 100);

      expect(mockFetch).toHaveBeenCalledTimes(5);
    });
  });

  describe("user", () => {
    it("getProfile returns user data", async () => {
      const profile = { id: "user1", username: "test", balances: { main: 1000, inPlay: 0 } };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(profile),
      });

      const result = await client.getProfile();
      expect(result).toEqual(profile);
    });

    it("getHandHistory returns history", async () => {
      const history = [{ id: "e1", amount: 50, type: "HAND_WIN" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ history }),
      });

      const result = await client.getHandHistory();
      expect(result).toEqual(history);
    });
  });

  describe("finance", () => {
    it("getChains returns blockchain list", async () => {
      const chains = [{ id: "eth", name: "Ethereum", tokens: [] }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(chains),
      });

      const result = await client.getChains();
      expect(result).toEqual(chains);
    });

    it("startDeposit returns session", async () => {
      const session = { address: "0x123", expiresAt: "2024-01-01" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(session),
      });

      const result = await client.startDeposit();
      expect(result).toEqual(session);
    });
  });

  describe("notes", () => {
    it("getNotes returns note list", async () => {
      const notes = [{ id: "n1", targetId: "user2", content: "test" }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notes }),
      });

      const result = await client.getNotes();
      expect(result).toEqual(notes);
    });

    it("saveNote creates/updates note", async () => {
      const note = { id: "n1", targetId: "user2", content: "updated" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ note }),
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
