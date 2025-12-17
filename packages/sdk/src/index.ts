/**
 * @pokertools/sdk
 *
 * TypeScript SDK for PokerTools API - Real-time poker client for browser and Node.js
 *
 * @packageDocumentation
 */

// Main exports
export { PokerClient } from "./client";
export { PokerSocket } from "./socket";

// Auth helpers
export {
  createSiweMessage,
  parseSiweMessage,
  isSiweExpired,
  createWithdrawalMessage,
  generateIdempotencyKey,
} from "./auth";
export type { SiweMessageParams } from "./auth";

// Utilities
export {
  formatChips,
  parseChips,
  getActivePlayer,
  getPlayerById,
  getPlayerSeat,
  isPlayerTurn,
  getCallAmount,
  getMinRaise,
  canCheck,
  canBet,
  getTotalPot,
  getActivePlayers,
  getPlayersInHand,
  suitToEmoji,
  formatCard,
  formatCards,
  getStreetName,
  isShowdown,
  isHandComplete,
  getPotOdds,
  abbreviateNumber,
} from "./utils";

// Types
export type {
  PokerSDKConfig,
  AuthState,
  UserBalances,
  UserProfile,
  BlockchainInfo,
  TokenInfo,
  DepositSession,
  DepositRecord,
  WithdrawalRequest,
  WithdrawalRecord,
  HandHistoryEntry,
  PlayerNote,
  ConnectionState,
  PokerSocketEvents,
  EventListener,
} from "./types";

export { PokerSDKError } from "./types";

// Re-export commonly used types from @pokertools/types
export type {
  PublicState,
  PublicPlayer,
  GameState,
  Player,
  Action,
  ActionType,
  TableConfig,
  ServerMessage,
  ClientMessage,
  SnapshotMessage,
  StateUpdateMessage,
  ErrorMessage,
  JoinTableMessage,
  LeaveTableMessage,
  CreateTableRequest,
  BuyInRequest,
  AddChipsRequest,
  GameActionRequest,
  LoginRequest,
  LoginResponse,
  NonceResponse,
  TableListItem,
} from "@pokertools/types";
