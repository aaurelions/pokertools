import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { SeatObservation } from "@pokertools/types";
import { PokerSocket } from "../src/socket";

/**
 * Real Node-level WebSocket loopback (no API app, no browser). Proves the SDK
 * speaks the canonical strict OBSERVATION protocol over an actual socket:
 *  - JWT is offered as the `jwt.<token>` subprotocol, not in the URL
 *  - JOIN is strict and resolves with the full canonical observation
 *  - opponent hole cards stay masked for the viewing principal
 *  - reordered/stale observations and non-OBSERVATION frames are ignored
 */

function wirePlayer(id: string, seat: number, hand: string[] | null) {
  return {
    id,
    name: id,
    seat,
    stack: 1000,
    hand,
    shownCards: null,
    status: "ACTIVE",
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: "IMMEDIATE",
    reservationExpiry: null,
    pendingStand: false,
  };
}

function wireState(
  version: number,
  viewingPlayerId: string | null,
  handId = "hand-1"
): Record<string, unknown> {
  return {
    config: { smallBlind: 5, bigBlind: 10, maxPlayers: 2 },
    players: [
      wirePlayer("p0", 0, viewingPlayerId === "p0" ? ["As", "Ks"] : null),
      wirePlayer("p1", 1, viewingPlayerId === "p1" ? ["Qh", "Qd"] : null),
    ],
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
    viewingPlayerId,
    version,
  };
}

function makeObservation(
  tableId: string,
  version: number,
  eventSeq: number,
  opts: { handId?: string; viewingPlayerId?: string | null } = {}
): SeatObservation {
  const handId = opts.handId ?? "hand-1";
  return {
    tableId,
    handId,
    turnId: "turn-1",
    version,
    eventSeq,
    state: wireState(version, opts.viewingPlayerId ?? "p0", handId),
    legalActions: [],
  } as unknown as SeatObservation;
}

function observationFrame(observation: SeatObservation, requestId?: string): string {
  return JSON.stringify({
    type: "OBSERVATION",
    tableId: observation.tableId,
    observation,
    timestamp: Date.now(),
    ...(requestId ? { requestId } : {}),
  });
}

function listen(server: WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    server.on("listening", () => resolve((server.address() as AddressInfo).port));
  });
}

const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("PokerSocket canonical loopback", () => {
  it("round-trips a masked observation and the jwt subprotocol", async () => {
    const server = new WebSocketServer({ port: 0, handleProtocols: () => "pokertools" });
    servers.push(server);
    const port = await listen(server);

    let received: { type?: string; tableId?: string } | null = null;
    let protocolHeader: string | undefined;
    server.on("connection", (ws, request) => {
      protocolHeader = request.headers["sec-websocket-protocol"];
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        received = msg;
        if (msg.type === "JOIN") {
          ws.send(observationFrame(makeObservation(msg.tableId, 1, 1), msg.requestId));
        }
      });
    });

    const socket = new PokerSocket({
      url: `ws://127.0.0.1:${port}`,
      token: "service-token",
      WebSocket: NodeWebSocket as unknown as typeof WebSocket,
      reconnectAttempts: 0,
    });

    try {
      await socket.connect();
      const observation = await socket.join("t1");

      expect(received).toMatchObject({ type: "JOIN", tableId: "t1" });
      expect(protocolHeader).toContain("jwt.service-token");
      expect(observation.version).toBe(1);
      expect(socket.getCachedObservation("t1")).toEqual(observation);
      expect(socket.getCachedState("t1")).toEqual(observation.state);

      const players = (
        socket.getCachedState("t1") as { players: Array<{ id: string; hand: unknown }> }
      ).players;
      expect(players[0].hand).toEqual(["As", "Ks"]);
      expect(players[1].hand).toBeNull();
    } finally {
      socket.disconnect();
    }
  });

  it("ignores reordered stale observations and non-observation frames", async () => {
    const server = new WebSocketServer({ port: 0, handleProtocols: () => "pokertools" });
    servers.push(server);
    const port = await listen(server);

    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "JOIN") return;
        // Newest first, then stale/duplicate, then a notification-only frame.
        ws.send(observationFrame(makeObservation(msg.tableId, 5, 5)));
        ws.send(observationFrame(makeObservation(msg.tableId, 4, 9)));
        ws.send(observationFrame(makeObservation(msg.tableId, 5, 5)));
        ws.send(
          JSON.stringify({
            type: "STATE_UPDATE",
            tableId: msg.tableId,
            version: 6,
            timestamp: Date.now(),
          })
        );
        // Same version, newer event sequence must still be accepted.
        ws.send(observationFrame(makeObservation(msg.tableId, 5, 6)));
      });
    });

    const socket = new PokerSocket({
      url: `ws://127.0.0.1:${port}`,
      token: "wallet-token",
      WebSocket: NodeWebSocket as unknown as typeof WebSocket,
      reconnectAttempts: 0,
    });

    const observed: number[] = [];
    socket.on("observation", (_tableId, observation) => {
      observed.push(observation.eventSeq);
    });

    try {
      await socket.connect();
      await socket.join("t2");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 5/5 accepted, 4/9 stale drop, 5/5 duplicate drop, STATE_UPDATE rejected,
      // 5/6 accepted.
      expect(observed).toEqual([5, 6]);
      expect(socket.getTableVersion("t2")).toBe(5);
      expect(socket.getTableEventSeq("t2")).toBe(6);
    } finally {
      socket.disconnect();
    }
  });
});
