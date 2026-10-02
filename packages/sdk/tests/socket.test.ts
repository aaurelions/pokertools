import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SeatObservation } from "@pokertools/types";
import { PokerSocket } from "../src/socket";
import { PokerSDKError } from "../src/types";

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  protocols?: string | string[];
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

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;

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

function makeWireState(version = 1, handId = "hand-1") {
  return {
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
    handId,
    viewingPlayerId: null,
    version,
  };
}

function makeObservation(overrides: Partial<SeatObservation> = {}): SeatObservation {
  const { state, ...rest } = overrides;
  const observation = {
    tableId: "table-1",
    handId: "hand-1",
    turnId: "turn-1",
    version: 1,
    eventSeq: 1,
    legalActions: [],
    ...rest,
  };
  // The seat observation schema requires the state projection to carry the
  // same hand identity and version as the observation envelope. Derive the
  // state from the resolved observation args so fixtures stay consistent.
  return {
    ...observation,
    state: state ?? makeWireState(observation.version, observation.handId),
  } as SeatObservation;
}

function observationFrame(observation: SeatObservation, requestId?: string) {
  return JSON.stringify({
    type: "OBSERVATION",
    tableId: observation.tableId,
    observation,
    timestamp: Date.now(),
    ...(requestId ? { requestId } : {}),
  });
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
    it("initializes without putting the token in the URL", async () => {
      expect(socket.getState()).toBe("disconnected");
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      expect(ws.url).toBe("ws://test.com/");
      expect(ws.url).not.toContain("test-token");
      expect(ws.protocols).toEqual(["pokertools", "jwt.test-token"]);
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
    it("ignores delayed close and private messages from a replaced socket", async () => {
      await socket.connect();
      const oldSocket = (socket as any).ws as MockWebSocket;
      socket.disconnect();
      await socket.connect();
      oldSocket.onclose?.({ code: 1000, reason: "late close" });
      oldSocket.onmessage?.({
        data: observationFrame(makeObservation({ tableId: "old-private-table" })),
      });
      expect(socket.isConnected()).toBe(true);
      expect(socket.getCachedObservation("old-private-table")).toBeUndefined();
    });

    it("rejects a connection attempt cancelled before open", async () => {
      const attempt = socket.connect();
      const rejected = expect(attempt).rejects.toThrow("Connection closed");
      socket.disconnect();
      await rejected;
    });

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
    it("sends JOIN and resolves with the first canonical observation", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;

      ws.send.mockImplementationOnce((data) => {
        const msg = JSON.parse(data);
        if (msg.type === "JOIN") {
          setTimeout(() => {
            ws.onmessage?.({
              data: observationFrame(makeObservation({ version: 4, eventSeq: 9 }), msg.requestId),
            });
          }, 10);
        }
      });

      const observation = await socket.join("table-1");
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"JOIN"'));
      expect(observation.version).toBe(4);
      expect(observation.eventSeq).toBe(9);
      expect(socket.getJoinedTables()).toContain("table-1");
    });

    it("throws if not connected", async () => {
      await expect(socket.join("table-1")).rejects.toThrow("Not connected");
    });

    it("times out if no observation received", async () => {
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
    it("sends LEAVE message and drops the cached observation", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      ws.onmessage?.({ data: observationFrame(makeObservation()) });
      expect(socket.getCachedObservation("table-1")).toBeDefined();

      socket.leave("table-1");

      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"LEAVE"'));
      expect(socket.getJoinedTables()).not.toContain("table-1");
      expect(socket.getCachedObservation("table-1")).toBeUndefined();
    });
  });

  describe("observations", () => {
    it("emits observation, snapshot and exposes the canonical view state", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;

      const onObservation = vi.fn();
      const onSnapshot = vi.fn();
      socket.on("observation", onObservation);
      socket.on("snapshot", onSnapshot);

      const first = makeObservation({ version: 1, eventSeq: 1 });
      ws.onmessage?.({ data: observationFrame(first) });

      expect(onObservation).toHaveBeenCalledWith("table-1", first);
      expect(onSnapshot).toHaveBeenCalledWith("table-1", first.state);
      expect(socket.getCachedObservation("table-1")).toEqual(first);
      expect(socket.getCachedState("table-1")).toEqual(first.state);
      expect(socket.getTableVersion("table-1")).toBe(1);
      expect(socket.getTableEventSeq("table-1")).toBe(1);
    });

    it("emits stateUpdate with the full wire state for a newer observation", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      socket.on("observation", () => undefined);

      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 1, eventSeq: 1 })) });

      const onStateUpdate = vi.fn();
      socket.on("stateUpdate", onStateUpdate);

      const newer = makeObservation({ version: 2, eventSeq: 2, state: makeWireState(2) });
      ws.onmessage?.({ data: observationFrame(newer) });

      expect(onStateUpdate).toHaveBeenCalledWith("table-1", newer.state);
      expect(socket.getTableVersion("table-1")).toBe(2);
    });

    it("rejects lower and equal (version, eventSeq) observations", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onObservation = vi.fn();
      socket.on("observation", onObservation);

      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 5, eventSeq: 5 })) });
      expect(onObservation).toHaveBeenCalledTimes(1);

      // Reordered older notification with a full stale projection
      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 4, eventSeq: 9 })) });
      // Duplicate of the latest boundary
      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 5, eventSeq: 5 })) });
      expect(onObservation).toHaveBeenCalledTimes(1);
      expect(socket.getTableVersion("table-1")).toBe(5);

      // Same version but a new event sequence is newer and must be accepted
      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 5, eventSeq: 6 })) });
      expect(onObservation).toHaveBeenCalledTimes(2);
      expect(socket.getTableEventSeq("table-1")).toBe(6);
    });

    it("never resets table-global versions for a different hand", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      socket.on("observation", () => undefined);

      ws.onmessage?.({ data: observationFrame(makeObservation({ version: 9, eventSeq: 20 })) });

      const newHand = makeObservation({
        handId: "hand-2",
        version: 1,
        eventSeq: 1,
        state: { ...makeWireState(1), handId: "hand-2" },
      });
      ws.onmessage?.({ data: observationFrame(newHand) });

      expect(socket.getCachedObservation("table-1")?.handId).toBe("hand-1");
      expect(socket.getTableVersion("table-1")).toBe(9);

      ws.onmessage?.({
        data: observationFrame(
          makeObservation({
            handId: "hand-2",
            version: 10,
            eventSeq: 21,
            state: { ...makeWireState(10), handId: "hand-2" },
          })
        ),
      });
      expect(socket.getCachedObservation("table-1")?.handId).toBe("hand-2");
      expect(socket.getTableVersion("table-1")).toBe(10);
    });

    it("strictly rejects notification-only and malformed server frames", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onObservation = vi.fn();
      socket.on("observation", onObservation);
      socket.on("stateUpdate", () => undefined);

      ws.onmessage?.({ data: JSON.stringify({ type: "SNAPSHOT", tableId: "table-1", state: {} }) });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "STATE_UPDATE",
          tableId: "table-1",
          version: 3,
          timestamp: 1,
        }),
      });
      // Valid type but invalid observation payload
      ws.onmessage?.({
        data: JSON.stringify({
          type: "OBSERVATION",
          tableId: "table-1",
          observation: { ...makeObservation(), legalActions: [{ family: "FOLD" }] },
          timestamp: 1,
        }),
      });

      expect(onObservation).not.toHaveBeenCalled();
      expect(socket.getCachedObservation("table-1")).toBeUndefined();
    });

    it("emits action", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onAction = vi.fn();
      socket.on("action", onAction);

      ws.onmessage?.({
        data: JSON.stringify({
          type: "ACTION",
          tableId: "table-1",
          playerId: "p1",
          actionType: "BET",
          amount: 100,
          timestamp: Date.now(),
        }),
      });

      expect(onAction).toHaveBeenCalledWith("table-1", "p1", "BET", 100);
    });

    it("emits error on server error", async () => {
      await socket.connect();
      const ws = (socket as any).ws as MockWebSocket;
      const onError = vi.fn();
      socket.on("error", onError);

      ws.onmessage?.({
        data: JSON.stringify({
          type: "ERROR",
          code: "TEST_ERROR",
          message: "Something went wrong",
        }),
      });

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
      const joinSpy = vi.spyOn(socket, "join").mockResolvedValue(makeObservation());

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
            ws.onmessage?.({
              data: JSON.stringify({
                type: "PONG",
                requestId: msg.requestId,
                timestamp: Date.now(),
              }),
            });
          }, 5);
        }
      });

      const latency = await socket.ping();
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });
});
