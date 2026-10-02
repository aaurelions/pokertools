import {
  CompetitionSchema,
  CreateCompetitionRequestSchema,
  CreateCompetitionResponseSchema,
  GetCompetitionResponseSchema,
  IssueAgentCredentialRequestSchema,
  IssuedAgentCredentialSchema,
  OptInCompetitionResponseSchema,
  PositiveAtomicAmountSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionResponseSchema,
} from "../src/canonical/competition";

const ASSET = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPONSOR = "principal-sponsor";
const WALLET_A = "principal-wallet-a";
const WALLET_B = "principal-wallet-b";
const SERVICE_A = "principal-service-a";
const SERVICE_B = "principal-service-b";

const terms = {
  entry: {
    assetId: ASSET,
    amountAtomic: "1000000",
    payers: [{ principalId: WALLET_A }],
  },
  prize: { assetId: ASSET, amountAtomic: "5000000", sponsorPrincipalId: SPONSOR },
};

const entrant = (principalId: string, kind: "WALLET" | "SERVICE", seat: number) => ({
  principalId,
  kind,
  seat,
  entryState: kind === "SERVICE" ? ("NOT_REQUIRED" as const) : ("PAID" as const),
});

describe("competition contracts", () => {
  it("accepts a nonfinancial mixed WALLET/SERVICE competition with no terms", () => {
    const parsed = CreateCompetitionRequestSchema.parse({
      name: "Free mixed table",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      idempotencyKey: "create-free-1",
    });
    expect(parsed.mode).toBe("NONFINANCIAL");
    expect(parsed.terms).toBeUndefined();
  });

  it("accepts an asset competition with a single configured WALLET payer", () => {
    const parsed = CreateCompetitionRequestSchema.parse({
      name: "Asset table",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
        { principalId: SERVICE_B, kind: "SERVICE" },
      ],
      terms,
      idempotencyKey: "create-asset-1",
    });
    expect(parsed.terms).toEqual(terms);
  });

  it("supports multiple WALLET entry payers generically", () => {
    const parsed = CreateCompetitionRequestSchema.parse({
      name: "Multi-payer",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: WALLET_B, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      terms: {
        entry: {
          assetId: ASSET,
          amountAtomic: "1000000",
          payers: [{ principalId: WALLET_A }, { principalId: WALLET_B, amountAtomic: "2000000" }],
        },
        prize: terms.prize,
      },
      idempotencyKey: "create-asset-2",
    });
    expect(parsed.terms?.entry.payers).toHaveLength(2);
  });

  it("rejects asset terms on a nonfinancial competition", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Free",
      mode: "NONFINANCIAL",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      terms,
      idempotencyKey: "create-free-2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an asset competition without explicit terms", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Asset",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      idempotencyKey: "create-asset-3",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a SERVICE entry payer: SERVICE is always zero-entry", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Service payer",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      terms: {
        ...terms,
        entry: {
          ...terms.entry,
          payers: [{ principalId: SERVICE_A }],
        },
      },
      idempotencyKey: "create-asset-4",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry payer that is not a roster entrant", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Unknown payer",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      terms: {
        ...terms,
        entry: { ...terms.entry, payers: [{ principalId: WALLET_B }] },
      },
      idempotencyKey: "create-asset-5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate entrant principals and duplicate payers", () => {
    expect(
      CreateCompetitionRequestSchema.safeParse({
        name: "Dup",
        mode: "NONFINANCIAL",
        entrants: [
          { principalId: SERVICE_A, kind: "SERVICE" },
          { principalId: SERVICE_A, kind: "SERVICE" },
        ],
        idempotencyKey: "create-dup",
      }).success
    ).toBe(false);

    expect(
      CreateCompetitionRequestSchema.safeParse({
        name: "Dup payers",
        mode: "ASSET",
        entrants: [
          { principalId: WALLET_A, kind: "WALLET" },
          { principalId: SERVICE_A, kind: "SERVICE" },
        ],
        terms: {
          ...terms,
          entry: {
            ...terms.entry,
            payers: [{ principalId: WALLET_A }, { principalId: WALLET_A }],
          },
        },
        idempotencyKey: "create-dup-payers",
      }).success
    ).toBe(false);
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

  it("requires canonical asset ids", () => {
    const result = CreateCompetitionRequestSchema.safeParse({
      name: "Bad asset",
      mode: "ASSET",
      entrants: [
        { principalId: WALLET_A, kind: "WALLET" },
        { principalId: SERVICE_A, kind: "SERVICE" },
      ],
      terms: { ...terms, entry: { ...terms.entry, assetId: "USDC" } },
      idempotencyKey: "create-bad-asset",
    });
    expect(result.success).toBe(false);
  });

  it("parses an authoritative competition projection with server-assigned seats", () => {
    const competition = CompetitionSchema.parse({
      id: "comp-1",
      name: "Asset table",
      mode: "ASSET",
      status: "REGISTRATION",
      tableId: "table-1",
      organizerPrincipalId: "principal-orchestrator",
      maxEntrants: 2,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: [entrant(WALLET_A, "WALLET", 0), entrant(SERVICE_A, "SERVICE", 1)],
      terms,
      prizeStatus: "RESERVED",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
    expect(competition.entrants[1].seat).toBe(1);
    expect(competition.entrants[1].entryState).toBe("NOT_REQUIRED");
    // Privacy: no wallet address, username or audit fields leak.
    expect(Object.keys(competition.entrants[0]).sort()).toEqual([
      "entryState",
      "kind",
      "principalId",
      "seat",
    ]);
  });

  it("parses create/get/opt-in/start/settle/agent-credential envelopes", () => {
    const competition = CompetitionSchema.parse({
      id: "comp-1",
      name: "Asset table",
      mode: "ASSET",
      status: "REGISTRATION",
      tableId: "table-1",
      organizerPrincipalId: "principal-orchestrator",
      maxEntrants: 2,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: [entrant(WALLET_A, "WALLET", 0), entrant(SERVICE_A, "SERVICE", 1)],
      terms,
      prizeStatus: "RESERVED",
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
        principalId: WALLET_A,
        entryState: "PAID",
        entry: { assetId: ASSET, amountAtomic: "1000000" },
        conversionId: "conversion-1",
      })
    ).toBeTruthy();
    expect(
      StartCompetitionResponseSchema.parse({
        success: true,
        competitionId: "comp-1",
        tableId: "table-1",
        seats: [
          { principalId: WALLET_A, seat: 0 },
          { principalId: SERVICE_A, seat: 1 },
        ],
      })
    ).toBeTruthy();
    expect(
      SettleCompetitionResponseSchema.parse({
        success: true,
        competitionId: "comp-1",
        winnerPrincipalId: WALLET_A,
        winnerKind: "WALLET",
        prizeStatus: "PAID",
        prize: { assetId: ASSET, amountAtomic: terms.prize.amountAtomic },
        placements: [
          {
            principalId: WALLET_A,
            kind: "WALLET",
            placement: 1,
            prize: { assetId: ASSET, amountAtomic: terms.prize.amountAtomic },
          },
          { principalId: SERVICE_A, kind: "SERVICE", placement: 2, prize: null },
        ],
      })
    ).toBeTruthy();

    const issue = IssueAgentCredentialRequestSchema.parse({
      principalId: SERVICE_A,
      name: "agent-a",
    });
    expect(issue.scopes).toBeUndefined();
    const rotated = IssueAgentCredentialRequestSchema.parse({
      principalId: SERVICE_A,
      name: "agent-a",
      credentialId: "cred-1",
    });
    expect(rotated.credentialId).toBe("cred-1");
    expect(
      IssuedAgentCredentialSchema.parse({
        credentialId: "cred-1",
        principalId: SERVICE_A,
        competitionId: "comp-1",
        tableId: "table-1",
        name: "agent-a",
        scopes: ["table:observe", "table:act", "table:chat"],
        seat: 1,
        expiresAt: null,
        token: "ptsvc_one_time",
        rotated: false,
      })
    ).toBeTruthy();
  });
});
