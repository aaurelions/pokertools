import { afterEach, describe, expect, it, vi } from "vitest";
import { PokerClient } from "../src/client";

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

afterEach(() => vi.useRealTimers());

describe("HTTP reliability", () => {
  it("does not replay unprotected game actions after a lost response", async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new Error("Connection lost after server committed"));
    await expect(client.call("t1")).rejects.toThrow(/Connection lost/);
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

  it("cleans up timers after a failed request", async () => {
    vi.useFakeTimers();
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new Error("Offline"));
    await expect(client.call("t1")).rejects.toThrow("Offline");
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
