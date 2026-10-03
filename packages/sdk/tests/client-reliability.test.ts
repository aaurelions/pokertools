import { afterEach, describe, expect, it, vi } from "vitest";
import { PokerClient } from "../src/client";
import { PokerHttpTransport } from "../src/transport";

function setup() {
  const fetch = vi.fn();
  const client = new PokerClient({
    baseUrl: "https://example.com",
    fetch,
    retry: { count: 2, delay: 1 },
    timeout: 100,
  });
  return { client, fetch };
}

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
  handId: "h1",
  viewingPlayerId: null,
  version: 1,
};

const receipt = {
  requestId: "req-stable",
  tableId: "t1",
  handId: "h1",
  turnId: "turn-1",
  actionId: "act-fold",
  version: 2,
  eventSeq: 3,
  acceptedAt: 1700000000000,
};

const actionResult = {
  receipt,
  observation: {
    tableId: "t1",
    handId: "h1",
    turnId: "turn-1",
    version: 2,
    eventSeq: 3,
    state: { ...wireState, version: 2 },
    legalActions: [],
  },
};

const actionRequest = {
  requestId: "req-stable",
  turnId: "turn-1",
  expectedVersion: 1,
  actionId: "act-fold",
};

afterEach(() => vi.useRealTimers());

describe("HTTP reliability", () => {
  it("bounds automatic retries for reads", async () => {
    const { client, fetch } = setup();
    fetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tables: [] }) });

    await expect(client.getTables()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not replay an unprotected mutation after a lost response", async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new Error("Connection lost after server committed"));
    await expect(client.saveNote("p1", "hello")).rejects.toThrow(/Connection lost/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a protected write with the same idempotency key", async () => {
    const { client, fetch } = setup();
    fetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    await client.buyIn("t1", { amount: 100, seat: 0, idempotencyKey: "one-operation" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  });

  it("replays an identity-free mutation only when explicitly declared retry-safe", async () => {
    const fetch = vi.fn();
    const transport = new PokerHttpTransport({
      baseUrl: "https://example.com",
      fetch,
      retry: { count: 2, delay: 1 },
      timeout: 100,
    });

    // Without the explicit flag, an empty-body mutation is never replayed.
    fetch.mockRejectedValue(new Error("Connection lost after server committed"));
    await expect(transport.request("POST", "/competitions/comp-1/opt-in", {})).rejects.toThrow(
      /Connection lost/
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    // With the flag, the naturally idempotent operation replays identical bytes.
    fetch.mockReset();
    fetch
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    await expect(
      transport.request("POST", "/competitions/comp-1/opt-in", {}, { retrySafe: true })
    ).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe("{}");
    expect(fetch.mock.calls[1][1].body).toBe("{}");
  });

  it("replays a canonical action with the identical serialized body and requestId", async () => {
    const { client, fetch } = setup();
    fetch
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce({ ok: true, json: async () => actionResult });

    await expect(client.action("t1", actionRequest)).resolves.toEqual(actionResult);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body).requestId).toBe("req-stable");
  });

  it("replays a signed withdrawal by its stable EIP-712 intent identity", async () => {
    const { client, fetch } = setup();
    const submission = {
      intent: {
        intentId: "intent-1",
        principalId: "p1",
        assetId: "eip155:31337/erc20:0x5fbdb2315678afecb367f032d93f642f64180aa3",
        destination: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
        amountAtomic: "1000000",
        nonce: 7,
        deadline: 1893456000,
        chainId: 31337,
      },
      signature: `0x${"ab".repeat(65)}`,
    };
    // A withdrawal record extends the full signed EIP-712 intent with its
    // lifecycle fields; every bound economic field must be present.
    const record = {
      ...submission.intent,
      status: "SIGNED",
      txHash: null,
    };

    fetch
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce({ ok: true, json: async () => record });

    await expect(client.submitWithdrawal(submission)).resolves.toEqual(record);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body).intent.intentId).toBe("intent-1");
  });

  it("returns unchanged state immediately without retrying 304", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue({ status: 304, ok: false });
    await expect(client.getTableState("t1", 4)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty successful response", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue({
      status: 204,
      ok: true,
      json: () => {
        throw new Error("Empty");
      },
    });
    await expect(client.deleteNote("p1")).resolves.toBeUndefined();
  });

  it("cleans up timers after a failed non-retried request", async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new Error("Offline"));
    await expect(client.saveNote("p1", "hello")).rejects.toThrow("Offline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the timeout active while reading the body", async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockImplementation(async (_url, { signal }) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    }));
    const request = expect(client.getTables()).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });
});
