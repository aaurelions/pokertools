import { expectTypeOf, describe, it } from "vitest";
import type {
  AssetBalance,
  CanonicalActionRequest,
  CanonicalActionResult,
  DepositClaimRequest,
  HandHistoryEntry,
  LegalAction,
  PlayerNote,
  PublicWireState,
  SeatObservation,
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
