/**
 * React hooks for PokerTools SDK
 *
 * Provides React-friendly hooks for managing poker game state,
 * WebSocket connections, and authentication.
 */

import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { PublicState } from "@pokertools/types";
import { PokerClient } from "../client";
import { PokerSocket } from "../socket";
import type { PokerSDKConfig, ConnectionState, UserProfile, UserBalances } from "../types";

// ============================================================================
// Context
// ============================================================================

interface PokerContextValue {
  client: PokerClient;
  socket: PokerSocket | null;
  isAuthenticated: boolean;
  connectionState: ConnectionState;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const PokerContext = createContext<PokerContextValue | null>(null);

/**
 * Props for PokerProvider
 */
export interface PokerProviderProps {
  /** SDK configuration */
  config: PokerSDKConfig;
  /** Children to render */
  children: ReactNode;
  /** Auto-connect WebSocket when authenticated (default: true) */
  autoConnect?: boolean;
}

/**
 * PokerProvider - Context provider for PokerTools SDK
 *
 * @example
 * ```tsx
 * import { PokerProvider } from "@pokertools/sdk/react";
 *
 * function App() {
 *   return (
 *     <PokerProvider config={{ baseUrl: "https://api.poker.example.com", token }}>
 *       <Game />
 *     </PokerProvider>
 *   );
 * }
 * ```
 */
export function PokerProvider({ config, children, autoConnect = true }: PokerProviderProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const clientRef = useRef<PokerClient | null>(null);
  const socketRef = useRef<PokerSocket | null>(null);

  // Initialize client
  clientRef.current ??= new PokerClient(config);

  // Update token when config changes
  useEffect(() => {
    if (clientRef.current) {
      clientRef.current.setToken(config.token ?? null);
    }
  }, [config.token]);

  // Initialize socket when authenticated
  useEffect(() => {
    if (config.token && autoConnect && !socketRef.current) {
      socketRef.current = PokerSocket.fromConfig(config);

      socketRef.current.on("connect", () => setConnectionState("connected"));
      socketRef.current.on("disconnect", () => setConnectionState("disconnected"));
      socketRef.current.on("reconnect", () => setConnectionState("reconnecting"));

      void socketRef.current.connect().catch(console.error);
    }

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [config.token, autoConnect, config]);

  const connect = useCallback(async () => {
    if (!config.token) {
      throw new Error("Token required to connect");
    }
    if (!socketRef.current) {
      socketRef.current = PokerSocket.fromConfig(config);
      socketRef.current.on("connect", () => setConnectionState("connected"));
      socketRef.current.on("disconnect", () => setConnectionState("disconnected"));
      socketRef.current.on("reconnect", () => setConnectionState("reconnecting"));
    }
    setConnectionState("connecting");
    await socketRef.current.connect();
  }, [config]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
  }, []);

  const value = useMemo(
    () => ({
      client: clientRef.current!,
      socket: socketRef.current,
      isAuthenticated: !!config.token,
      connectionState,
      connect,
      disconnect,
    }),
    [config.token, connectionState, connect, disconnect]
  );

  return <PokerContext.Provider value={value}>{children}</PokerContext.Provider>;
}

/**
 * Hook to access PokerTools context
 */
export function usePoker(): PokerContextValue {
  const context = useContext(PokerContext);
  if (!context) {
    throw new Error("usePoker must be used within a PokerProvider");
  }
  return context;
}

/**
 * Hook to get the PokerClient instance
 */
export function usePokerClient(): PokerClient {
  return usePoker().client;
}

/**
 * Hook to get the PokerSocket instance
 */
export function usePokerSocket(): PokerSocket | null {
  return usePoker().socket;
}

// ============================================================================
// Table Hook
// ============================================================================

interface UseTableOptions {
  /** Polling interval for state updates (ms, default: disabled) */
  pollInterval?: number;
  /** Auto-join via WebSocket (default: true) */
  autoJoin?: boolean;
}

interface UseTableResult {
  /** Current table state */
  state: PublicState | null;
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Refresh state from server */
  refresh: () => Promise<void>;
  /** Execute an action */
  action: (type: string, amount?: number) => Promise<void>;
  /** Leave the table */
  leave: () => Promise<void>;
}

/**
 * Hook to manage a poker table
 *
 * @example
 * ```tsx
 * function Table({ tableId }: { tableId: string }) {
 *   const { state, isLoading, error, action } = useTable(tableId);
 *
 *   if (isLoading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *   if (!state) return <div>Table not found</div>;
 *
 *   return (
 *     <div>
 *       <div>Pot: {state.pot}</div>
 *       <button onClick={() => action("FOLD")}>Fold</button>
 *       <button onClick={() => action("CALL")}>Call</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useTable(tableId: string, options: UseTableOptions = {}): UseTableResult {
  const { pollInterval, autoJoin = true } = options;
  const { client, socket } = usePoker();

  const [state, setState] = useState<PublicState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const versionRef = useRef<number>(0);

  // Fetch initial state
  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      const newState = await client.getTableState(tableId);
      if (newState) {
        setState(newState);
        versionRef.current = newState.version;
      }
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [client, tableId]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // WebSocket subscription
  useEffect(() => {
    if (!socket || !autoJoin) return;

    const handleStateUpdate = (id: string, newState: PublicState) => {
      if (id === tableId) {
        setState(newState);
        versionRef.current = newState.version;
      }
    };

    const handleSnapshot = (id: string, newState: PublicState) => {
      if (id === tableId) {
        setState(newState);
        versionRef.current = newState.version;
        setIsLoading(false);
      }
    };

    socket.on("stateUpdate", handleStateUpdate);
    socket.on("snapshot", handleSnapshot);

    // Join table if connected
    if (socket.isConnected()) {
      void socket.join(tableId).catch(console.error);
    }

    return () => {
      socket.off("stateUpdate", handleStateUpdate);
      socket.off("snapshot", handleSnapshot);
      socket.leave(tableId);
    };
  }, [socket, tableId, autoJoin]);

  // Polling (if configured)
  useEffect(() => {
    if (!pollInterval) return;

    const interval = setInterval(() => {
      void (async () => {
        const newState = await client.getTableState(tableId, versionRef.current);
        if (newState) {
          setState(newState);
          versionRef.current = newState.version;
        }
      })();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [client, tableId, pollInterval]);

  // Action helper
  const action = useCallback(
    async (type: string, amount?: number) => {
      const newState = await client.action(tableId, { type: type as Parameters<typeof client.action>[1]["type"], amount });
      setState(newState);
      versionRef.current = newState.version;
    },
    [client, tableId]
  );

  // Leave table
  const leave = useCallback(async () => {
    await client.stand(tableId);
    if (socket) {
      socket.leave(tableId);
    }
  }, [client, socket, tableId]);

  return { state, isLoading, error, refresh, action, leave };
}

// ============================================================================
// User Hooks
// ============================================================================

interface UseUserResult {
  /** User profile */
  profile: UserProfile | null;
  /** User balances */
  balances: UserBalances | null;
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Refresh profile */
  refresh: () => Promise<void>;
}

/**
 * Hook to get current user profile and balances
 */
export function useUser(): UseUserResult {
  const { client, isAuthenticated } = usePoker();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoading(true);
      const data = await client.getProfile();
      setProfile(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [client, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      void refresh();
    } else {
      setProfile(null);
    }
  }, [isAuthenticated, refresh]);

  return {
    profile,
    balances: profile?.balances ?? null,
    isLoading,
    error,
    refresh,
  };
}

// ============================================================================
// Tables List Hook
// ============================================================================

interface UseTablesResult {
  /** List of tables */
  tables: Awaited<ReturnType<PokerClient["getTables"]>>;
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Refresh tables list */
  refresh: () => Promise<void>;
}

/**
 * Hook to get list of active tables
 */
export function useTables(): UseTablesResult {
  const { client } = usePoker();
  const [tables, setTables] = useState<Awaited<ReturnType<PokerClient["getTables"]>>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await client.getTables();
      setTables(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tables, isLoading, error, refresh };
}

// ============================================================================
// Connection Hook
// ============================================================================

/**
 * Hook to manage WebSocket connection
 */
export function useConnection() {
  const { socket, connectionState, connect, disconnect } = usePoker();

  const [latency, setLatency] = useState<number | null>(null);

  // Ping for latency measurement
  const ping = useCallback(async () => {
    if (!socket?.isConnected()) return null;
    try {
      const ms = await socket.ping();
      setLatency(ms);
      return ms;
    } catch {
      return null;
    }
  }, [socket]);

  return {
    state: connectionState,
    isConnected: connectionState === "connected",
    isConnecting: connectionState === "connecting",
    isReconnecting: connectionState === "reconnecting",
    latency,
    connect,
    disconnect,
    ping,
  };
}

// ============================================================================
// Export Types
// ============================================================================

export type {
  UseTableOptions,
  UseTableResult,
  UseUserResult,
  UseTablesResult,
  PokerContextValue,
};

