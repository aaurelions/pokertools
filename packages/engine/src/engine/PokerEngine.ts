import {
  GameState,
  Street,
  TableConfig,
  Action,
  ActionType,
  DealAction,
  SitAction,
  StandAction,
  PublicState,
} from "@pokertools/types";
import { gameReducer } from "./gameReducer";
import { createPublicView } from "../utils/viewMasking";
import { createSnapshot, restoreFromSnapshot, Snapshot } from "../utils/serialization";
import { ConfigError } from "../errors/ConfigError";
import { exportHandHistory, getHandHistory } from "../history/exporter";
import { HandHistory, ExportOptions } from "@pokertools/types";
import { validateChipAmount, validateTimestamp } from "../utils/validation";

/**
 * Event listener callback type
 */
type EventListener = (action: Action, oldState: GameState, newState: GameState) => void;

/**
 * Time provider function type for dependency injection
 */
type TimeProvider = () => number;

/**
 * Main Poker Engine class
 * Wraps the pure reducer with a stateful API
 */
export class PokerEngine {
  private currentState: GameState;
  private listeners: EventListener[] = [];
  private timeProvider: TimeProvider;

  constructor(config: TableConfig, timeProvider: TimeProvider = () => Date.now()) {
    // Validate config
    this.validateConfig(config);

    // Initialize time provider
    this.timeProvider = timeProvider;

    // Initialize state
    this.currentState = this.createInitialState(config);
  }

  /**
   * Add a player to the table
   */
  sit(seat: number, id: string, name: string, stack: number): void {
    // Validate chip amount is a non-negative integer
    validateChipAmount(stack, "Sit stack");

    const action: SitAction = {
      type: ActionType.SIT,
      playerId: id,
      playerName: name,
      seat,
      stack,
      timestamp: this.timeProvider(),
    };

    this.dispatch(action);
  }

  /**
   * Remove a player from the table
   */
  stand(id: string): void {
    const action: StandAction = {
      type: ActionType.STAND,
      playerId: id,
      timestamp: this.timeProvider(),
    };

    this.dispatch(action);
  }

  /**
   * Deal a new hand
   */
  deal(): void {
    const action: DealAction = {
      type: ActionType.DEAL,
      timestamp: this.timeProvider(),
    };

    this.dispatch(action);
  }

  /**
   * Execute an action
   * If action.timestamp is not provided, the engine will automatically set it
   */
  act(action: Action): GameState {
    // Ensure timestamp is set
    const timestamp = action.timestamp ?? this.timeProvider();

    // Validate timestamp if provided by caller
    if (action.timestamp !== undefined) {
      validateTimestamp(timestamp, this.currentState.timestamp);
    }

    // Validate chip amounts for betting actions
    if ("amount" in action && typeof action.amount === "number") {
      validateChipAmount(action.amount, `${action.type} amount`);
    }

    const actionWithTimestamp: Action = {
      ...action,
      timestamp,
    } as Action;

    this.dispatch(actionWithTimestamp);
    return this.currentState;
  }

  /**
   * Validate an action without executing it
   * Useful for UI state (enabling/disabling buttons)
   */
  validate(action: Action): { valid: true } | { valid: false; error: string; code?: string } {
    try {
      // Dry-run the reducer
      // We don't need to deep clone state because reducer is immutable
      // and pure, and we discard the result.
      gameReducer(this.currentState, action);
      return { valid: true };
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? "Invalid action";
      const code = (err as { code?: string })?.code;
      return {
        valid: false,
        error: message,
        code,
      };
    }
  }

  /**
   * Reconcile local state with server state
   * Smoothly merges server updates into client engine
   */
  reconcile(serverState: PublicState | GameState): void {
    // Hydrate PublicState into GameState if needed
    const newState: GameState = {
      ...serverState,
      // Ensure deck exists (empty for client/public state)
      deck: "deck" in serverState ? serverState.deck : [],
      // Ensure players map correctly (PublicPlayer.hand is compatible with Player.hand)
      players: serverState.players as unknown as GameState['players'], // Type assertion needed due to deep readonly/mutable mismatch potential
      // Ensure config carries isClient flag if set locally
      config: {
        ...serverState.config,
        isClient: this.currentState.config.isClient,
      },
    };

    this.currentState = newState;
  }

  /**
   * Optimistically execute an action and return the provisional state
   * Does not modify the engine's actual state
   */
  optimisticAct(action: Action): GameState {
    const timestamp = action.timestamp ?? this.timeProvider();
    const actionWithTimestamp = { ...action, timestamp } as Action;
    return gameReducer(this.currentState, actionWithTimestamp);
  }

  /**
   * Undo last action
   */
  undo(): boolean {
    if (this.currentState.previousStates.length === 0) {
      return false;
    }

    const previousState =
      this.currentState.previousStates[this.currentState.previousStates.length - 1];

    this.currentState = previousState;
    return true;
  }

  /**
   * Get current game state (full, unmasked)
   */
  get state(): GameState {
    return this.currentState;
  }

  /**
   * Get player view (masked)
   */
  view(playerId?: string, version?: number): PublicState {
    return createPublicView(this.currentState, playerId ?? null, version ?? 0);
  }

  /**
   * Get snapshot for serialization
   */
  get snapshot(): Snapshot {
    return createSnapshot(this.currentState);
  }

  /**
   * Restore from snapshot (static factory method)
   */
  static restore(snapshot: Snapshot): PokerEngine {
    const state = restoreFromSnapshot(snapshot);
    const engine = new PokerEngine(state.config);
    engine.currentState = state;
    return engine;
  }

  /**
   * Subscribe to state changes
   */
  on(callback: EventListener): () => void {
    this.listeners.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Advance to next blind level (tournament)
   */
  nextBlindLevel(): void {
    if (!this.currentState.config.blindStructure) {
      return;
    }

    const nextLevel = this.currentState.blindLevel + 1;

    if (nextLevel >= this.currentState.config.blindStructure.length) {
      return; // At max level
    }

    // Dispatch NEXT_BLIND_LEVEL action to notify listeners
    this.dispatch({
      type: ActionType.NEXT_BLIND_LEVEL,
      timestamp: this.timeProvider(),
    });
  }

  /**
   * Export hand history in specified format
   *
   * @param options Export format options
   * @returns Formatted hand history string
   */
  history(options?: ExportOptions): string {
    return exportHandHistory(this.currentState, options);
  }

  /**
   * Get structured hand history object
   *
   * @returns Hand history object
   */
  getHandHistory(): HandHistory {
    return getHandHistory(this.currentState);
  }

  /**
   * Dispatch action through reducer
   */
  private dispatch(action: Action): void {
    const oldState = this.currentState;

    try {
      this.currentState = gameReducer(this.currentState, action);

      // Notify listeners
      for (const listener of this.listeners) {
        listener(action, oldState, this.currentState);
      }
    } catch (error) {
      // Re-throw error but keep old state
      throw error;
    }
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: TableConfig): void {
    if (config.smallBlind <= 0) {
      throw new ConfigError("Small blind must be positive", {
        smallBlind: config.smallBlind,
      });
    }

    if (config.bigBlind <= config.smallBlind) {
      throw new ConfigError("Big blind must be greater than small blind", {
        smallBlind: config.smallBlind,
        bigBlind: config.bigBlind,
      });
    }

    const maxPlayers = config.maxPlayers ?? 9;

    if (maxPlayers < 2 || maxPlayers > 10) {
      throw new ConfigError("Max players must be between 2 and 10", {
        maxPlayers,
      });
    }
  }

  /**
   * Create initial game state
   */
  private createInitialState(config: TableConfig): GameState {
    const maxPlayers = config.maxPlayers ?? 9;
    const players = Array(maxPlayers).fill(null);

    // For tournaments, use blindStructure[0] for initial blinds/ante
    const isTournament = !!config.blindStructure;
    const initialBlinds = isTournament ? config.blindStructure[0] : null;

    return {
      config,
      players,
      maxPlayers,
      handNumber: 0,
      buttonSeat: null,
      deck: [],
      board: [],
      street: Street.PREFLOP,
      pots: [],
      currentBets: new Map(),
      minRaise: initialBlinds?.bigBlind ?? config.bigBlind,
      lastRaiseAmount: 0,
      actionTo: null,
      lastAggressorSeat: null,
      activePlayers: [],
      winners: null,
      rakeThisHand: 0,
      smallBlind: initialBlinds?.smallBlind ?? config.smallBlind,
      bigBlind: initialBlinds?.bigBlind ?? config.bigBlind,
      ante: initialBlinds?.ante ?? config.ante ?? 0,
      blindLevel: 0,
      timeBanks: new Map(),
      timeBankActiveSeat: null,
      actionHistory: [],
      previousStates: [],
      timestamp: Date.now(),
      handId: "initial",
    };
  }
}
