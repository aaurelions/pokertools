import React, { useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const connectMock = vi.fn(() => Promise.resolve(undefined));
  const disconnectMock = vi.fn();
  const joinMock = vi.fn(() => Promise.resolve({ version: 2, players: [] }));
  const leaveMock = vi.fn();
  const pingMock = vi.fn(() => Promise.resolve(42));
  const onMock = vi.fn();
  const offMock = vi.fn();
  const isConnectedMock = vi.fn(() => true);
  const socketInstances: Array<{ emit: (event: string, ...args: unknown[]) => void }> = [];

  class MockPokerSocket {
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    static fromConfig = vi.fn(() => {
      const socket = new MockPokerSocket();
      socketInstances.push(socket);
      return socket;
    });

    on(event: string, listener: (...args: unknown[]) => void) {
      onMock(event, listener);
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
      return () => this.off(event, listener);
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      offMock(event, listener);
      this.listeners.get(event)?.delete(listener);
    }

    async connect() {
      await connectMock();
      this.emit("connect");
    }

    disconnect() {
      disconnectMock();
      this.emit("disconnect", "Client disconnect");
    }

    isConnected() {
      return isConnectedMock();
    }

    join = joinMock;
    leave = leaveMock;
    ping = pingMock;

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  const setTokenMock = vi.fn();
  const getTablesMock = vi.fn(() => Promise.resolve([{ id: "table-1", name: "Test Table" }]));
  const getTournamentsMock = vi.fn(() =>
    Promise.resolve([{ id: "tournament-1", name: "MTT", registeredPlayers: 2 }])
  );
  const getTournamentMock = vi.fn(() =>
    Promise.resolve({ id: "tournament-1", name: "MTT", entries: [], tables: [] })
  );
  const getProfileMock = vi.fn(() =>
    Promise.resolve({ id: "user-1", username: "alice", balances: { MAIN: 100 } })
  );
  const getTableStateMock = vi.fn(() => Promise.resolve({ version: 1, players: [] }));
  const actionMock = vi.fn(() => Promise.resolve({ version: 3, players: [] }));
  const standMock = vi.fn(() => Promise.resolve(undefined));

  class MockPokerClient {
    setToken = setTokenMock;
    getTables = getTablesMock;
    getTournaments = getTournamentsMock;
    getTournament = getTournamentMock;
    getProfile = getProfileMock;
    getTableState = getTableStateMock;
    action = actionMock;
    stand = standMock;
  }

  return {
    connectMock,
    disconnectMock,
    joinMock,
    leaveMock,
    getTablesMock,
    getTournamentsMock,
    getTournamentMock,
    getProfileMock,
    getTableStateMock,
    socketInstances,
    MockPokerSocket,
    MockPokerClient,
  };
});

vi.mock("../src/socket", () => ({ PokerSocket: mocks.MockPokerSocket }));
vi.mock("../src/client", () => ({ PokerClient: mocks.MockPokerClient }));

import {
  PokerProvider,
  usePoker,
  useConnection,
  useTables,
  useTournaments,
  useTournament,
  useUser,
  useTable,
} from "../src/react";

describe("React SDK hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketInstances.length = 0;
  });

  afterEach(() => cleanup());

  it("throws when usePoker is rendered outside PokerProvider", () => {
    function Broken() {
      usePoker();
      return null;
    }

    expect(() => render(<Broken />)).toThrow("usePoker must be used within a PokerProvider");
  });

  it("auto-connects once and does not reconnect for inline config object identity changes", async () => {
    function Status() {
      const { state } = useConnection();
      return <div data-testid="state">{state}</div>;
    }

    const { rerender, unmount } = render(
      <PokerProvider config={{ baseUrl: "http://api.test", token: "token-1" }}>
        <Status />
      </PokerProvider>
    );

    await waitFor(() => expect(mocks.connectMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("state").textContent).toBe("connected");

    rerender(
      <PokerProvider config={{ baseUrl: "http://api.test", token: "token-1" }}>
        <Status />
      </PokerProvider>
    );

    await waitFor(() => expect(mocks.connectMock).toHaveBeenCalledTimes(1));
    expect(mocks.MockPokerSocket.fromConfig).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("useTables fetches table list", async () => {
    function Tables() {
      const { tables, isLoading } = useTables();
      return <div>{isLoading ? "loading" : tables[0]?.name}</div>;
    }

    render(
      <PokerProvider config={{ baseUrl: "http://api.test" }} autoConnect={false}>
        <Tables />
      </PokerProvider>
    );

    await screen.findByText("Test Table");
    expect(mocks.getTablesMock).toHaveBeenCalledTimes(1);
  });

  it("useTournaments fetches tournament list", async () => {
    function Tournaments() {
      const { tournaments, isLoading } = useTournaments();
      return <div>{isLoading ? "loading" : tournaments[0]?.name}</div>;
    }

    render(
      <PokerProvider config={{ baseUrl: "http://api.test" }} autoConnect={false}>
        <Tournaments />
      </PokerProvider>
    );

    await screen.findByText("MTT");
    expect(mocks.getTournamentsMock).toHaveBeenCalledTimes(1);
  });

  it("useTournament fetches tournament details", async () => {
    function Tournament() {
      const { tournament } = useTournament("tournament-1");
      return <div>{tournament?.name ?? "loading"}</div>;
    }

    render(
      <PokerProvider config={{ baseUrl: "http://api.test" }} autoConnect={false}>
        <Tournament />
      </PokerProvider>
    );

    await screen.findByText("MTT");
    expect(mocks.getTournamentMock).toHaveBeenCalledWith("tournament-1");
  });

  it("useUser fetches profile when authenticated and clears without a token", async () => {
    function User() {
      const { profile } = useUser();
      return <div>{profile?.username ?? "anonymous"}</div>;
    }

    const { rerender } = render(
      <PokerProvider config={{ baseUrl: "http://api.test", token: "token-1" }} autoConnect={false}>
        <User />
      </PokerProvider>
    );

    await screen.findByText("alice");

    rerender(
      <PokerProvider config={{ baseUrl: "http://api.test" }} autoConnect={false}>
        <User />
      </PokerProvider>
    );

    await screen.findByText("anonymous");
  });

  it("useTable fetches state, joins, receives snapshots, and leaves on cleanup", async () => {
    function Table() {
      const { state } = useTable("table-1");
      useEffect(() => {
        mocks.socketInstances[0]?.emit("snapshot", "table-1", { version: 4, players: [] });
      }, []);
      return <div data-testid="version">{state?.version ?? "none"}</div>;
    }

    const { unmount } = render(
      <PokerProvider config={{ baseUrl: "http://api.test", token: "token-1" }}>
        <Table />
      </PokerProvider>
    );

    await waitFor(() => expect(mocks.getTableStateMock).toHaveBeenCalledWith("table-1"));
    await waitFor(() => expect(mocks.joinMock).toHaveBeenCalledWith("table-1"));

    unmount();
    expect(mocks.leaveMock).toHaveBeenCalledWith("table-1");
  });
});
