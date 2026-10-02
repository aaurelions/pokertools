import { expectTypeOf, describe, it } from "vitest";
import type {
  AssetBalance,
  CanonicalActionRequest,
  CanonicalActionResult,
  ChatMessage,
  ChatPage,
  CreatedServiceCredential,
  DepositClaimRequest,
  HandHistoryEntry,
  LegalAction,
  PlayerNote,
  Principal,
  PublicWireState,
  ReadinessResponse,
  ReplayFrame,
  SeatObservation,
  ServiceCredentialSummary,
  UserBalances,
  UserProfile,
  WithdrawalIntent,
} from "../src";

describe("SDK canonical type surface", () => {
  it("binds withdrawal intents to atomic decimal strings", () => {
    expectTypeOf<WithdrawalIntent>().toMatchTypeOf<{
      intentId: string;
      principalId: string;
      assetId: string;
      destination: string;
      amountAtomic: string;
      nonce: number;
      deadline: number;
      chainId: number;
    }>();
  });

  it("exposes strict canonical action requests", () => {
    expectTypeOf<CanonicalActionRequest>().toMatchTypeOf<{
      requestId: string;
      turnId: string;
      expectedVersion: number;
      actionId: string;
      amount?: number;
    }>();
  });

  it("exposes the canonical action result receipt + observation", () => {
    expectTypeOf<CanonicalActionResult>().toMatchTypeOf<{
      receipt: { requestId: string; version: number; eventSeq: number };
      observation: SeatObservation;
    }>();
  });

  it("exposes seat observations carrying server-issued legal actions", () => {
    expectTypeOf<SeatObservation["legalActions"]>().toEqualTypeOf<LegalAction[]>();
    expectTypeOf<SeatObservation["state"]>().toEqualTypeOf<PublicWireState>();
  });

  it("serializes canonical wire state with plain chip records, not Maps", () => {
    expectTypeOf<PublicWireState["currentBets"]>().toEqualTypeOf<Record<string, number>>();
    expectTypeOf<PublicWireState["timeBanks"]>().toEqualTypeOf<Record<string, number>>();
  });

  it("exposes a distinct deposit claim request identity", () => {
    expectTypeOf<DepositClaimRequest>().toMatchTypeOf<{
      assetId: string;
      txHash: string;
      logIndex: number;
    }>();
  });

  it("exposes per-asset balances with atomic decimal strings", () => {
    expectTypeOf<AssetBalance>().toMatchTypeOf<{
      principalId: string;
      assetId: string;
      availableAtomic: string;
      inPlayAtomic: string;
      pendingWithdrawalAtomic: string;
    }>();
  });
});

describe("SDK generic endpoint type surface", () => {
  it("exposes the three-field public principal for GET /auth/me", () => {
    expectTypeOf<Principal>().toMatchTypeOf<{
      id: string;
      kind: "WALLET" | "SERVICE";
      walletAddress: string | null;
    }>();
  });

  it("exposes readiness as a discriminated-ready platform report", () => {
    expectTypeOf<ReadinessResponse>().toMatchTypeOf<{
      status: "ready" | "not_ready";
      timestamp: number;
      checks: Array<{ name: string; state: string; mandatory: boolean }>;
      financial: { state: string; reasons: string[] };
    }>();
  });

  it("exposes append-only chat and replay frames", () => {
    expectTypeOf<ChatMessage>().toMatchTypeOf<{
      messageId: string;
      tableId: string;
      handId: string;
      eventSeq: number;
      principalId: string;
      body: string;
      sentAt: number;
    }>();
    expectTypeOf<ChatPage>().toMatchTypeOf<{
      tableId: string;
      messages: ChatMessage[];
      nextBeforeSeq: number | null;
    }>();
    expectTypeOf<ReplayFrame>().toMatchTypeOf<{
      tableId: string;
      fromEventSeq: number;
      toEventSeq: number;
      anchorHash: string | null;
      headEventSeq: number;
      events: Array<{ eventSeq: number; hash: string; previousHash: string | null }>;
      chainValid: boolean;
    }>();
  });

  it("keeps the one-time credential token out of list summaries", () => {
    expectTypeOf<CreatedServiceCredential>().toMatchTypeOf<{
      id: string;
      userId: string;
      name: string;
      scopes: Array<"table:observe" | "table:act" | "table:chat">;
      tableId: string | null;
      seat: number | null;
      expiresAt: string | null;
      token: string;
    }>();
    expectTypeOf<ServiceCredentialSummary>().toMatchTypeOf<{
      id: string;
      userId: string;
      name: string;
      revoked: boolean;
      lastUsedAt: string | null;
      createdAt: string;
    }>();
    expectTypeOf<ServiceCredentialSummary>().not.toHaveProperty("token");
  });
});

describe("SDK user/profile/history/note type surface", () => {
  it("profiles expose decimal chip balances and per-asset balances, not legacy cents", () => {
    expectTypeOf<UserProfile>().toMatchTypeOf<{
      id: string;
      username: string;
      address: string | null;
      role: "PLAYER" | "ADMIN";
      createdAt: string;
      chipBalances: UserBalances;
      assetBalances: AssetBalance[];
    }>();
    expectTypeOf<UserBalances>().toMatchTypeOf<{
      available: string;
      inPlay: string;
      tournament: string;
      totalInPlay: string;
      pendingWithdrawal: string;
    }>();
    expectTypeOf<UserProfile>().not.toHaveProperty("balances");
  });

  it("hand history keeps integer chip amounts and an ISO timestamp", () => {
    expectTypeOf<HandHistoryEntry>().toMatchTypeOf<{
      id: string;
      amount: number;
      type: "HAND_WIN" | "HAND_LOSS";
      referenceId: string | null;
      createdAt: string;
    }>();
  });

  it("notes carry an author id and never a legacy cents amount", () => {
    expectTypeOf<PlayerNote>().toMatchTypeOf<{
      id: string;
      authorId: string;
      targetId: string;
      content: string;
      label: string | null;
      createdAt: string;
      updatedAt: string;
    }>();
    expectTypeOf<PlayerNote>().not.toHaveProperty("amount");
  });
});
