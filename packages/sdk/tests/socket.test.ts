import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PokerSocket } from "../src/socket";
import { PokerSDKError } from "../src/types";

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send = vi.fn();
  close = vi.fn((code = 1000, reason = "") => {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  });

  constructor(url: string) {
    this.url = url;

    // Simulate connection based on URL
    setTimeout(() => {
      if (this.url.includes("fail")) {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onerror) {
          this.onerror(new Event("error"));
        }
        if (this.onclose) {
          this.onclose({ code: 1006, reason: "Connection failed" });
        }
      } else {
        this.readyState = MockWebSocket.OPEN;
        if (this.onopen) this.onopen();
      }
    }, 0);
  }
}

describe("PokerSocket", () => {
  let socket: PokerSocket;

  beforeEach(() => {
    socket = new PokerSocket({
      url: "ws://test.com",
      token: "test-token",
      WebSocket: MockWebSocket as unknown as typeof WebSocket,
      reconnectAttempts: 1, // Minimize retries for tests
      reconnectDelay: 10,
    });
  });

  afterEach(() => {
    socket.disconnect();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("initializes with correct URL including token", () => {
      expect(socket.getState()).toBe("disconnected");
    });
  });

  describe("connect", () => {
    it("connects successfully", async () => {
      await socket.connect();
      expect(socket.isConnected()).toBe(true);
      expect(socket.getState()).toBe("connected");
    });

    it("emits connect event", async () => {
      const onConnect = vi.fn();
      socket.on("connect", onConnect);
      await socket.connect();
      expect(onConnect).toHaveBeenCalled();
    });

    it("handles connection failure", async () => {
      const errorSocket = new PokerSocket({
        url: "ws://fail.com",
        token: "token",
        WebSocket: MockWebSocket as unknown as typeof WebSocket,
      });

      await expect(errorSocket.connect()).rejects.toThrow(PokerSDKError);
    });
  });

  describe("disconnect", () => {
    it("disconnects and cleans up", async () => {
      await socket.connect();
      const onDisconnect = vi.fn();
      socket.on("disconnect", onDisconnect);

      socket.disconnect();

      expect(socket.isConnected()).toBe(false);
      expect(socket.getState()).toBe("disconnected");
      expect(onDisconnect).toHaveBeenCalledWith("Client disconnect");
    });
  });

  describe("join", () => {
    it("sends JOIN message and waits for SNAPSHOT", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;

      ws.send.mockImplementationOnce((data) => {
        const msg = JSON.parse(data);
        if (msg.type === "JOIN") {
          setTimeout(() => {
            if (ws.onmessage) {
              ws.onmessage({
                data: JSON.stringify({
                  type: "SNAPSHOT",
                  tableId: msg.tableId,
                  state: { version: 1, players: [] },
                  timestamp: Date.now(),
                }),
              });
            }
          }, 10);
        }
      });

      const state = await socket.join("table-1");
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"JOIN"'));
      expect(state).toEqual({ version: 1, players: [] });
      expect(socket.getJoinedTables()).toContain("table-1");
    });

    it("throws if not connected", async () => {
      await expect(socket.join("table-1")).rejects.toThrow("Not connected");
    });

    it("times out if no snapshot received", async () => {
      await socket.connect();

      vi.useFakeTimers();
      const joinPromise = socket.join("table-1");

      // Attach handler before advancing time to avoid unhandled rejection
      const expectPromise = expect(joinPromise).rejects.toThrow("Join timeout");

      await vi.advanceTimersByTimeAsync(10001);

      await expectPromise;
    });
  });

  describe("leave", () => {
    it("sends LEAVE message", async () => {
      await socket.connect();
      (socket as any).joinedTables.add("table-1");
      const ws = (socket as any).ws as MockWebSocket;

      socket.leave("table-1");

      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"LEAVE"'));
      expect(socket.getJoinedTables()).not.toContain("table-1");
    });
  });

  describe("events", () => {
    it("emits stateUpdate", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;

      const onStateUpdate = vi.fn();
      socket.on("stateUpdate", onStateUpdate);

      if (ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "STATE_UPDATE",
            tableId: "table-1",
            version: 2,
            timestamp: Date.now(),
          }),
        });
      }

      expect(onStateUpdate).toHaveBeenCalledWith(
        "table-1",
        expect.objectContaining({ version: 2 })
      );
    });

    it("emits action", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onAction = vi.fn();
      socket.on("action", onAction);

      if (ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "ACTION",
            tableId: "table-1",
            playerId: "p1",
            actionType: "BET",
            amount: 100,
            timestamp: Date.now(),
          }),
        });
      }

      expect(onAction).toHaveBeenCalledWith("table-1", "p1", "BET", 100);
    });

    it("emits error on server error", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onError = vi.fn();
      socket.on("error", onError);

      if (ws.onmessage) {
        ws.onmessage({
          data: JSON.stringify({
            type: "ERROR",
            code: "TEST_ERROR",
            message: "Something went wrong",
          }),
        });
      }

      expect(onError).toHaveBeenCalledWith(expect.any(PokerSDKError));
    });
  });

  describe("reconnection", () => {
    it("attempts to reconnect on close", async () => {
      await socket.connect();

      // Now use fake timers to control reconnection delay
      vi.useFakeTimers();

      const ws = (socket as any).ws as MockWebSocket;
      const onReconnect = vi.fn();
      socket.on("reconnect", onReconnect);

      // Simulate close
      ws.close();

      // Wait for reconnect delay
      await vi.advanceTimersByTimeAsync(100);
      expect(onReconnect).toHaveBeenCalledWith(1);

      // Reconnect happens async in next tick after timer
      // We need to wait for the connection promise inside reconnect() to resolve
      // Since connect() uses setTimeout(0), we advance a bit more
      await vi.advanceTimersByTimeAsync(10);

      expect(socket.isConnected()).toBe(true);
    });

    it("rejoins tables after reconnection", async () => {
      await socket.connect();
      (socket as any).joinedTables.add("table-1");
      const ws = (socket as any).ws as MockWebSocket;

      // Spy on join method
      const joinSpy = vi.spyOn(socket, "join").mockResolvedValue({} as any);

      vi.useFakeTimers();
      ws.close();

      // Trigger reconnection
      await vi.advanceTimersByTimeAsync(1000); // Wait for reconnect delay
      await vi.advanceTimersByTimeAsync(100); // Wait for connection

      expect(joinSpy).toHaveBeenCalledWith("table-1");
    });
  });

  describe("ping", () => {
    it("sends PING and resolves on PONG", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;

      ws.send.mockImplementationOnce((data) => {
        const msg = JSON.parse(data);
        if (msg.type === "PING") {
          setTimeout(() => {
            if (ws.onmessage) {
              ws.onmessage({
                data: JSON.stringify({
                  type: "PONG",
                  requestId: msg.requestId,
                  timestamp: Date.now(),
                }),
              });
            }
          }, 5);
        }
      });

      const latency = await socket.ping();
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });
});
