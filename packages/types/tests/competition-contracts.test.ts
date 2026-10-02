import {
  CompetitionSchema,
  CreateCompetitionRequestSchema,
  CreateCompetitionResponseSchema,
  GetCompetitionResponseSchema,
  OptInCompetitionResponseSchema,
  PositiveAtomicAmountSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionResponseSchema,
} from "../src/canonical/competition";

const ASSET = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPONSOR = "principal-sponsor";
const WALLET = "principal-wallet";
const SERVICE_A = "principal-service-a";
const SERVICE_B = "principal-service-b";

const paidTerms = {
  entry: { assetId: ASSET, amountAtomic: "1000000" },
  prize: { assetId: ASSET, amountAtomic: "5000000" },
  sponsorPrincipalId: SPONSOR,
};

describe("competition contracts", () => {
  it("accepts a nonfinancial mixed WALLET/SERVICE competition with no paid terms", () => {
    const parsed = CreateCompetitionRequestSchema.parse({
      name: "Free mixed table",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      idempotencyKey: "create-free-1",
    });
    expect(parsed.mode).toBe("NONFINANCIAL");
    expect(parsed.paidTerms).toBeUndefined();
  });

  it("accepts a sponsored competition with exactly one WALLET and zero-entry SERVICE entrants", () => {
    const parsed = CreateCompetitionRequestSchema.parse({
      name: "Sponsored table",
      mode: "SPONSORED",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
        { principalId: SERVICE_B, kind: "SERVICE" },
      ],
      paidTerms,
      idempotencyKey: "create-paid-1",
    });
    expect(parsed.paidTerms).toEqual(paidTerms);
  });

  it("rejects paid terms on a nonfinancial competition", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Free",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      paidTerms,
      idempotencyKey: "create-free-2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sponsored competition without explicit paid terms", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Paid",
      mode: "SPONSORED",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      idempotencyKey: "create-paid-2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sponsored competition with more than one WALLET entrant", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Paid",
      mode: "SPONSORED",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "WALLET" },
      ],
      paidTerms,
      idempotencyKey: "create-paid-3",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sponsored competition with no zero-entry SERVICE entrant", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Paid",
      mode: "SPONSORED",
      entrants: [{ principalId: WALLET, kind: "WALLET" }],
      paidTerms,
      idempotencyKey: "create-paid-4",
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate entrant principals", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Dup",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: SERVICE_A, kind: "SERVICE" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      idempotencyKey: "create-dup",
    });
    expect(result.success).toBe(false);
  });

  it("rejects client-supplied seats", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Seats",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: SERVICE_A, kind: "SERVICE", seat: 0 },
        { principalId: SERVICE_B, kind: "SERVICE" },
      ],
      idempotencyKey: "create-seat",
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero and non-canonical atomic amounts", () => {
    expect(PositiveAtomicAmountSchema.safeParse("0").success).toBe(false);
    expect(PositiveAtomicAmountSchema.safeParse("01").success).toBe(false);
    expect(PositiveAtomicAmountSchema.safeParse("1").success).toBe(true);
  });

  it("requires entry and prize assets to be canonical asset ids", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Bad asset",
      mode: "SPONSORED",
      entrants: [
        { principalId: WALLET, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      paidTerms: {
        ...paidTerms,
        entry: { assetId: "USDC", amountAtomic: "1" },
      },
      idempotencyKey: "create-bad-asset",
    });
    expect(result.success).toBe(false);
  });

  it("parses an authoritative competition projection with server-assigned seats", () => {
    const competition = CompetitionSchema.parse({
      id: "comp-1",
      name: "Sponsored table",
      mode: "SPONSORED",
      status: "REGISTRATION",
      tableId: "table-1",
      organizerPrincipalId: "principal-orchestrator",
      maxEntrants: 2,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: [
        { principalId: WALLET, kind: "WALLET", seat: 0, entryState: "PROVISIONED" },
        { principalId: SERVICE_A, kind: "SERVICE", seat: 1, entryState: "PROVISIONED" },
      ],
      paidTerms,
      prizeStatus: "PENDING",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
    expect(competition.entrants[1].seat).toBe(1);
  });

  it("parses create/get/opt-in/start/settle response envelopes", () => {
    const competition = CompetitionSchema.parse({
      id: "comp-1",
      name: "Sponsored table",
      mode: "SPONSORED",
      status: "REGISTRATION",
      tableId: "table-1",
      organizerPrincipalId: "principal-orchestrator",
      maxEntrants: 2,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: [
        { principalId: WALLET, kind: "WALLET", seat: 0, entryState: "OPTED_IN" },
        { principalId: SERVICE_A, kind: "SERVICE", seat: 1, entryState: "PROVISIONED" },
      ],
      paidTerms,
      prizeStatus: "PENDING",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });

    expect(
      CreateCompetitionResponseSchema.parse({ success: true, competition, replayed: false })
    ).toBeTruthy();
    expect(GetCompetitionResponseSchema.parse({ competition })).toBeTruthy();
    expect(
      OptInCompetitionResponseSchema.parse({
        success: true,
        competitionId: "comp-1",
        principalId: WALLET,
        entryState: "OPTED_IN",
        entry: paidTerms.entry,
        conversionId: "conversion-1",
      })
    ).toBeTruthy();
    expect(
      StartCompetitionResponseSchema.parse({
        success: true,
        competitionId: "comp-1",
        tableId: "table-1",
        seats: [
          { principalId: WALLET, seat: 0 },
          { principalId: SERVICE_A, seat: 1 },
        ],
      })
    ).toBeTruthy();
    expect(
      SettleCompetitionResponseSchema.parse({
        success: true,
        competitionId: "comp-1",
        winnerPrincipalId: WALLET,
        winnerKind: "WALLET",
        prizeStatus: "PAID",
        prize: paidTerms.prize,
        placements: [
          { principalId: WALLET, kind: "WALLET", placement: 1, prize: paidTerms.prize },
          { principalId: SERVICE_A, kind: "SERVICE", placement: 2, prize: null },
        ],
      })
    ).toBeTruthy();
  });
});
