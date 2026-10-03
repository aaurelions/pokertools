/**
 * Release-contract regression tests (pure unit).
 *
 * These pin the canonical runtime contracts that gate the competition release:
 * strict `POST /competitions` ASSET economics, bounded output seats and
 * lifecycle readiness, truthful prestart-cancellation receipts, service
 * credential REST exclusivity/resource binding, and masked-state redaction of
 * private runtime payload fields across the hand lifecycle.
 *
 * Everything here is schema/adapter unit work: no API, database or SDK state is
 * involved. DTO parsing is asserted against the pure contracts only.
 */

import {
  AgentTableScopeSchema,
  CancelCompetitionResponseSchema,
  CompetitionCancellationEntrySchema,
  CompetitionEntrantSchema,
  CompetitionPlacementSchema,
  CompetitionSchema,
  CompetitionSeatAssignmentSchema,
  CreateCompetitionRequestSchema,
  IssueAgentCredentialRequestSchema,
  IssuedAgentCredentialSchema,
  OptInCompetitionResponseSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionResponseSchema,
} from "../src/canonical/competition";
import {
  CreateServiceCredentialRequestSchema,
  CreatedServiceCredentialSchema,
  ServiceCredentialSummarySchema,
} from "../src/canonical/rest";
import { FinancialIncidentSchema, FinancialReadinessSchema } from "../src/canonical/operations";
import {
  PublicTableConfigSchema,
  PublicWirePlayerSchema,
  PublicWireStateSchema,
  parsePublicWireState,
  serializePublicWireState,
  toPublicTableConfig,
  toPublicWirePlayer,
  toPublicWireState,
} from "../src/canonical/masked-state";
import {
  CanonicalActionResultSchema,
  CanonicalActionReceiptSchema,
  LegalActionSchema,
  SeatObservationSchema,
} from "../src/canonical/table";
import {
  ReplayFrameEventSchema,
  ReplayFrameSchema,
  ReplayRequestSchema,
  isContiguousEventSeq,
} from "../src/canonical/streams";
import {
  AssetStatusSchema,
  DepositProvenanceSchema,
  DepositStatusSchema,
  Eip712DomainSchema,
  Eip712TypedDataSchema,
  TransactionLogRefSchema,
  WithdrawalEip712DomainSchema,
  WithdrawalSignatureSchema,
  WITHDRAWAL_INTENT_EIP712_FIELDS,
} from "../src/canonical/finance";
import { ReadinessResponseSchema } from "../src/api/operations";
import * as canonicalCompetition from "../src/canonical/competition";
import * as apiCompetition from "../src/api/competitions";
import * as canonicalServicePrincipal from "../src/canonical/service-principal";
import * as apiServicePrincipals from "../src/api/service-principals";
import { ActionType } from "../src/action";
import { Street } from "../src/game-state";
import { PlayerStatus, SitInOption } from "../src/player";
import type { PublicPlayer } from "../src/public-state";
import type { PublicState } from "../src/public-state";

const ASSET = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const SPONSOR = "principal-platform-sponsor";
const WALLET_A = "principal-wallet-a";
const WALLET_B = "principal-wallet-b";
const SERVICE_A = "principal-service-a";
const SERVICE_B = "principal-service-b";
const ISO = "2026-01-01T00:00:00.000Z";

interface ParseResultLike {
  success: boolean;
  error?: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> };
}

function issuePaths(result: ParseResultLike): string[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join("."));
}

function expectRejected(result: ParseResultLike, path: string): void {
  expect(result.success).toBe(false);
  expect(issuePaths(result)).toContain(path);
}

// ============================================================================
// POST /competitions: strict ASSET economics
// ============================================================================

const roster = [
  { principalId: WALLET_A, kind: "WALLET" as const },
  { principalId: SERVICE_A, kind: "SERVICE" as const },
];

const entryTerms = {
  assetId: ASSET,
  amountAtomic: "1000000",
  payers: [{ principalId: WALLET_A }],
};
const prizeTerms = { assetId: ASSET, amountAtomic: "5000000", sponsorPrincipalId: SPONSOR };
const assetTerms = { entry: entryTerms, prize: prizeTerms };

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: "Asset table",
    mode: "ASSET",
    entrants: roster,
    terms: assetTerms,
    idempotencyKey: "create-1",
    ...overrides,
  };
}

describe("competition create: ASSET superRefine economics", () => {
  test("requires bigBlind when smallBlind is supplied and accepts explicit blind pairs", () => {
    const missingBigBlind = CreateCompetitionRequestSchema.safeParse(
      createRequest({ mode: "NONFINANCIAL", terms: undefined, smallBlind: 10 })
    );
    expectRejected(missingBigBlind, "bigBlind");

    const bothBlinds = CreateCompetitionRequestSchema.safeParse(
      createRequest({ mode: "NONFINANCIAL", terms: undefined, smallBlind: 10, bigBlind: 20 })
    );
    expect(bothBlinds.success).toBe(true);
    if (bothBlinds.success) {
      expect(bothBlinds.data.smallBlind).toBe(10);
      expect(bothBlinds.data.bigBlind).toBe(20);
    }

    // A lone bigBlind is complete: the server defaults the small blind.
    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ mode: "NONFINANCIAL", terms: undefined, bigBlind: 20 })
      ).success
    ).toBe(true);
    // Blinds are still positive chip amounts.
    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ mode: "NONFINANCIAL", terms: undefined, bigBlind: 0 })
      ).success
    ).toBe(false);
  });

  test("requires explicit ASSET terms and rejects every malformed economics condition", () => {
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(createRequest({ terms: undefined })),
      "terms"
    );
    // NONFINANCIAL may not smuggle asset terms in.
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(createRequest({ mode: "NONFINANCIAL" })),
      "terms"
    );

    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, entry: { ...entryTerms, payers: [] } } })
      ),
      "terms.entry.payers"
    );

    const duplicatePayer = CreateCompetitionRequestSchema.safeParse(
      createRequest({
        terms: {
          ...assetTerms,
          entry: {
            ...entryTerms,
            payers: [{ principalId: WALLET_A }, { principalId: WALLET_A }],
          },
        },
      })
    );
    expectRejected(duplicatePayer, "terms.entry.payers.1.principalId");

    const payerNotInRoster = CreateCompetitionRequestSchema.safeParse(
      createRequest({
        terms: { ...assetTerms, entry: { ...entryTerms, payers: [{ principalId: WALLET_B }] } },
      })
    );
    expectRejected(payerNotInRoster, "terms.entry.payers.0.principalId");

    const servicePayer = CreateCompetitionRequestSchema.safeParse(
      createRequest({
        entrants: [...roster, { principalId: SERVICE_B, kind: "SERVICE" }],
        terms: { ...assetTerms, entry: { ...entryTerms, payers: [{ principalId: SERVICE_B }] } },
      })
    );
    expectRejected(servicePayer, "terms.entry.payers.0.principalId");

    // Amounts must be positive canonical atomic decimal strings.
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, entry: { ...entryTerms, amountAtomic: "0" } } })
      ),
      "terms.entry.amountAtomic"
    );
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, entry: { ...entryTerms, amountAtomic: "01" } } })
      ),
      "terms.entry.amountAtomic"
    );
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({
          terms: {
            ...assetTerms,
            entry: { ...entryTerms, payers: [{ principalId: WALLET_A, amountAtomic: "0" }] },
          },
        })
      ),
      "terms.entry.payers.0.amountAtomic"
    );
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, prize: { ...prizeTerms, amountAtomic: "0" } } })
      ),
      "terms.prize.amountAtomic"
    );

    // Prize sponsor identity is mandatory.
    const { sponsorPrincipalId: _sponsor, ...prizeWithoutSponsor } = prizeTerms;
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, prize: prizeWithoutSponsor } })
      ),
      "terms.prize.sponsorPrincipalId"
    );
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({
          terms: { ...assetTerms, prize: { ...prizeTerms, sponsorPrincipalId: "" } },
        })
      ),
      "terms.prize.sponsorPrincipalId"
    );

    // Asset ids stay canonical on both sides.
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, entry: { ...entryTerms, assetId: "USDC" } } })
      ),
      "terms.entry.assetId"
    );
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, prize: { ...prizeTerms, assetId: "0x1234" } } })
      ),
      "terms.prize.assetId"
    );

    expectRejected(
      CreateCompetitionRequestSchema.safeParse(createRequest({ startingStack: 0 })),
      "startingStack"
    );

    const elevenPayers = Array.from({ length: 11 }, (_, index) => ({
      principalId: `principal-payer-${index}`,
    }));
    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ terms: { ...assetTerms, entry: { ...entryTerms, payers: elevenPayers } } })
      ).success
    ).toBe(false);

    for (const idempotencyKey of ["", "x".repeat(129)]) {
      expect(
        CreateCompetitionRequestSchema.safeParse(createRequest({ idempotencyKey })).success
      ).toBe(false);
    }
    expect(
      CreateCompetitionRequestSchema.safeParse(createRequest({ idempotencyKey: "x".repeat(128) }))
        .success
    ).toBe(true);
  });

  test("accepts an authorized non-roster sponsor and per-payer amount overrides", () => {
    const parsed = CreateCompetitionRequestSchema.parse(
      createRequest({
        entrants: [...roster, { principalId: WALLET_B, kind: "WALLET" }],
        terms: {
          entry: {
            ...entryTerms,
            payers: [{ principalId: WALLET_A }, { principalId: WALLET_B, amountAtomic: "2000000" }],
          },
          // The fixed platform sponsor is resolved by the API as authorized
          // delegation; it is deliberately not required to be a roster entrant.
          prize: { ...prizeTerms, sponsorPrincipalId: "principal-fixed-platform-sponsor" },
        },
      })
    );
    expect(parsed.terms?.prize.sponsorPrincipalId).toBe("principal-fixed-platform-sponsor");
    expect(parsed.terms?.entry.payers[1]).toEqual({
      principalId: WALLET_B,
      amountAtomic: "2000000",
    });
  });

  test("bounds the roster and rejects smuggled seat or credential fields", () => {
    expectRejected(
      CreateCompetitionRequestSchema.safeParse(createRequest({ entrants: [roster[0]] })),
      "entrants"
    );
    const elevenEntrants = Array.from({ length: 11 }, (_, index) => ({
      principalId: `principal-entrant-${index}`,
      kind: "SERVICE",
    }));
    expect(
      CreateCompetitionRequestSchema.safeParse(createRequest({ entrants: elevenEntrants })).success
    ).toBe(false);

    const duplicateEntrant = CreateCompetitionRequestSchema.safeParse(
      createRequest({
        entrants: [WALLET_A, WALLET_A].map((principalId) => ({ principalId, kind: "WALLET" })),
      })
    );
    expectRejected(duplicateEntrant, "entrants.1.principalId");

    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ entrants: [{ principalId: WALLET_A, kind: "BOT" }, roster[1]] })
      ).success
    ).toBe(false);
    // Seats are server-assigned; a client-supplied seat is rejected.
    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({ entrants: [{ principalId: WALLET_A, kind: "WALLET", seat: 0 }, roster[1]] })
      ).success
    ).toBe(false);
    // Credentials are never accepted on a create request.
    expect(
      CreateCompetitionRequestSchema.safeParse(
        createRequest({
          entrants: [{ principalId: WALLET_A, kind: "WALLET", credentialId: "cred-1" }, roster[1]],
        })
      ).success
    ).toBe(false);
  });
});

// ============================================================================
// Competition output projections: seats, readiness and cancellation
// ============================================================================

function competitionProjection() {
  return {
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
    entrants: [
      { principalId: WALLET_A, kind: "WALLET", seat: 0, entryState: "PAID" },
      { principalId: SERVICE_A, kind: "SERVICE", seat: 1, entryState: "NOT_REQUIRED" },
    ],
    terms: assetTerms,
    prizeStatus: "RESERVED",
    settlementReady: false,
    createdAt: ISO,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
  };
}

function cancellationEntries() {
  return [
    {
      principalId: WALLET_A,
      kind: "WALLET",
      entryState: "REFUNDED",
      refunded: true,
      refundJournalId: "competition-entry-refund:comp-1:wallet-a",
    },
    {
      principalId: SERVICE_A,
      kind: "SERVICE",
      entryState: "NOT_REQUIRED",
      refunded: false,
      refundJournalId: null,
    },
  ];
}

describe("competition output projections", () => {
  test("bounds authoritative seats and roster sizes on every output surface", () => {
    for (const seat of [-1, 10, 1.5]) {
      expect(
        CompetitionEntrantSchema.safeParse({
          principalId: SERVICE_A,
          kind: "SERVICE",
          seat,
          entryState: "NOT_REQUIRED",
        }).success
      ).toBe(false);
    }
    for (const seat of [0, 9]) {
      expect(
        CompetitionEntrantSchema.safeParse({
          principalId: SERVICE_A,
          kind: "SERVICE",
          seat,
          entryState: "NOT_REQUIRED",
        }).success
      ).toBe(true);
    }

    expect(
      CompetitionSeatAssignmentSchema.safeParse({ principalId: WALLET_A, seat: 10 }).success
    ).toBe(false);
    expect(
      CompetitionSeatAssignmentSchema.safeParse({ principalId: WALLET_A, seat: 0 }).success
    ).toBe(true);

    const seats = (count: number) =>
      Array.from({ length: count }, (_, seat) => ({ principalId: `principal-seat-${seat}`, seat }));
    const startResponse = (count: number) => ({
      success: true,
      competitionId: "comp-1",
      tableId: "table-1",
      seats: seats(count),
    });
    expect(StartCompetitionResponseSchema.safeParse(startResponse(1)).success).toBe(false);
    expect(StartCompetitionResponseSchema.safeParse(startResponse(11)).success).toBe(false);
    expect(StartCompetitionResponseSchema.safeParse(startResponse(2)).success).toBe(true);

    expect(
      CompetitionPlacementSchema.safeParse({
        principalId: WALLET_A,
        kind: "WALLET",
        placement: 0,
        prize: null,
      }).success
    ).toBe(false);

    for (const maxEntrants of [1, 11]) {
      expect(CompetitionSchema.safeParse({ ...competitionProjection(), maxEntrants }).success).toBe(
        false
      );
    }
    for (const count of [1, 11]) {
      const entrants = seats(count).map((entry) => ({
        principalId: entry.principalId,
        kind: "SERVICE",
        seat: entry.seat,
        entryState: "NOT_REQUIRED",
      }));
      expect(CompetitionSchema.safeParse({ ...competitionProjection(), entrants }).success).toBe(
        false
      );
    }
  });

  test("requires lifecycle readiness fields and rejects leaked private projection fields", () => {
    const { settlementReady: _settlementReady, ...withoutSettlementReady } =
      competitionProjection();
    expect(CompetitionSchema.safeParse(withoutSettlementReady).success).toBe(false);

    const { cancelledAt: _cancelledAt, ...withoutCancelledAt } = competitionProjection();
    expect(CompetitionSchema.safeParse(withoutCancelledAt).success).toBe(false);

    const finished = CompetitionSchema.parse({
      ...competitionProjection(),
      status: "FINISHED",
      settlementReady: true,
      finishedAt: ISO,
      prizeStatus: "PAID",
    });
    expect(finished.settlementReady).toBe(true);

    const cancelled = CompetitionSchema.parse({
      ...competitionProjection(),
      status: "CANCELLED",
      cancelledAt: ISO,
      prizeStatus: "RELEASED",
    });
    expect(cancelled.cancelledAt).toBe(ISO);

    const free = CompetitionSchema.parse({
      ...competitionProjection(),
      mode: "NONFINANCIAL",
      terms: null,
      prizeStatus: "NOT_APPLICABLE",
    });
    expect(free.terms).toBeNull();

    // Projections are privacy-preserving: wallet addresses and internal audit
    // fields are structurally impossible on entrants and the competition.
    const projection = competitionProjection();
    expect(
      CompetitionSchema.safeParse({
        ...projection,
        entrants: [{ ...projection.entrants[0], walletAddress: ADDRESS_A }, projection.entrants[1]],
      }).success
    ).toBe(false);
    expect(
      CompetitionSchema.safeParse({ ...projection, organizerAddress: ADDRESS_A }).success
    ).toBe(false);
  });

  test("opt-in receipt is immutable and truthful across a prestart cancellation", () => {
    const base = {
      success: true,
      competitionId: "comp-1",
      principalId: WALLET_A,
      entry: { assetId: ASSET, amountAtomic: "1000000" },
      journalRequestId: "competition-entry-reserve:comp-1:wallet-a",
    };
    for (const entryState of ["PAID", "REFUNDED"]) {
      expect(OptInCompetitionResponseSchema.safeParse({ ...base, entryState }).success).toBe(true);
    }
    for (const entryState of ["PENDING", "NOT_REQUIRED"]) {
      expect(OptInCompetitionResponseSchema.safeParse({ ...base, entryState }).success).toBe(false);
    }
    // The exact reserve-credit journal is required; legacy conversion ids and
    // zero entries are rejected.
    expect(
      OptInCompetitionResponseSchema.safeParse({
        ...base,
        entryState: "PAID",
        journalRequestId: undefined,
      }).success
    ).toBe(false);
    expect(
      OptInCompetitionResponseSchema.safeParse({
        ...base,
        entryState: "PAID",
        conversionId: "conversion-legacy",
      }).success
    ).toBe(false);
    expect(
      OptInCompetitionResponseSchema.safeParse({
        ...base,
        entryState: "PAID",
        entry: { assetId: ASSET, amountAtomic: "0" },
      }).success
    ).toBe(false);
  });

  test("cancellation entries cannot misreport refunds", () => {
    const walletEntry = { principalId: WALLET_A, kind: "WALLET" as const };
    const serviceEntry = { principalId: SERVICE_A, kind: "SERVICE" as const };

    for (const entry of [
      { ...walletEntry, entryState: "REFUNDED", refunded: true, refundJournalId: "refund-1" },
      { ...serviceEntry, entryState: "NOT_REQUIRED", refunded: false, refundJournalId: null },
      { ...walletEntry, entryState: "PENDING", refunded: false, refundJournalId: null },
    ]) {
      expect(CompetitionCancellationEntrySchema.safeParse(entry).success).toBe(true);
    }

    for (const entry of [
      // A successful cancellation never reports a PAID entry.
      { ...walletEntry, entryState: "PAID", refunded: false, refundJournalId: null },
      // refunded must match the REFUNDED state...
      { ...walletEntry, entryState: "REFUNDED", refunded: false, refundJournalId: "refund-1" },
      { ...serviceEntry, entryState: "NOT_REQUIRED", refunded: true, refundJournalId: "refund-1" },
      // ...and must be backed by the exact refund journal.
      { ...walletEntry, entryState: "REFUNDED", refunded: true, refundJournalId: null },
      { ...serviceEntry, entryState: "NOT_REQUIRED", refunded: false, refundJournalId: "refund-1" },
    ]) {
      expect(CompetitionCancellationEntrySchema.safeParse(entry).success).toBe(false);
    }
  });

  test("parses the durable cancellation envelope and bounds its entries", () => {
    const response = {
      success: true,
      competitionId: "comp-1",
      status: "CANCELLED",
      cancelledAt: ISO,
      prizeStatus: "RELEASED",
      prize: null,
      entries: cancellationEntries(),
    };
    const parsed = CancelCompetitionResponseSchema.parse(response);
    expect(parsed.status).toBe("CANCELLED");
    expect(parsed.prize).toBeNull();
    expect(parsed.entries[0].refunded).toBe(true);

    expect(
      CancelCompetitionResponseSchema.safeParse({ ...response, status: "RUNNING" }).success
    ).toBe(false);
    expect(
      CancelCompetitionResponseSchema.safeParse({ ...response, entries: [response.entries[0]] })
        .success
    ).toBe(false);

    const nonfinancial = CancelCompetitionResponseSchema.parse({
      ...response,
      prizeStatus: "NOT_APPLICABLE",
      prize: null,
    });
    expect(nonfinancial.prizeStatus).toBe("NOT_APPLICABLE");
  });

  test("settlement envelopes keep prize movement truthful and bounded", () => {
    const placements = [
      {
        principalId: WALLET_A,
        kind: "WALLET",
        placement: 1,
        prize: { assetId: ASSET, amountAtomic: "5000000" },
      },
      { principalId: SERVICE_A, kind: "SERVICE", placement: 2, prize: null },
    ];
    const released = {
      success: true,
      competitionId: "comp-1",
      winnerPrincipalId: SERVICE_A,
      winnerKind: "SERVICE",
      prizeStatus: "RELEASED",
      prize: null,
      placements,
    };
    expect(SettleCompetitionResponseSchema.safeParse(released).success).toBe(true);
    expect(
      SettleCompetitionResponseSchema.safeParse({
        ...released,
        prizeStatus: "PAID",
        prize: { assetId: ASSET, amountAtomic: "5000000" },
      }).success
    ).toBe(true);
    expect(
      SettleCompetitionResponseSchema.safeParse({ ...released, placements: [placements[0]] })
        .success
    ).toBe(false);
    expect(
      SettleCompetitionResponseSchema.safeParse({
        ...released,
        prize: { assetId: ASSET, amountAtomic: "0" },
      }).success
    ).toBe(false);
  });

  test("agent credential requests stay table-scoped and seat-bounded", () => {
    expect(
      IssueAgentCredentialRequestSchema.safeParse({ principalId: SERVICE_A, name: "agent-a" })
        .success
    ).toBe(true);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        scopes: [],
      }).success
    ).toBe(false);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        scopes: ["competition:orchestrate"],
      }).success
    ).toBe(false);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        scopes: ["table:observe", "table:act", "table:chat", "table:observe"],
      }).success
    ).toBe(false);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        scopes: ["table:act"],
        seat: 10,
      }).success
    ).toBe(false);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        scopes: ["table:act"],
        seat: 9,
      }).success
    ).toBe(true);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        expiresAt: "tomorrow",
      }).success
    ).toBe(false);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        credentialId: "cred-1",
      }).success
    ).toBe(true);
    expect(
      IssueAgentCredentialRequestSchema.safeParse({
        principalId: SERVICE_A,
        name: "agent-a",
        isOperator: true,
      }).success
    ).toBe(false);
    expect(AgentTableScopeSchema.safeParse("table:admin").success).toBe(false);

    const issued = {
      credentialId: "cred-1",
      principalId: SERVICE_A,
      competitionId: "comp-1",
      tableId: "table-1",
      name: "agent-a",
      scopes: ["table:observe"],
      seat: null,
      expiresAt: null,
      token: "ptsvc_one_time",
      rotated: false,
    };
    expect(IssuedAgentCredentialSchema.safeParse(issued).success).toBe(true);
    expect(IssuedAgentCredentialSchema.safeParse({ ...issued, token: "" }).success).toBe(false);
    expect(IssuedAgentCredentialSchema.safeParse({ ...issued, scopes: [] }).success).toBe(false);
    expect(IssuedAgentCredentialSchema.safeParse({ ...issued, seat: 10 }).success).toBe(false);
  });
});

// ============================================================================
// Service credentials: orchestration exclusivity and resource binding
// ============================================================================

describe("service credentials: REST exclusivity and resource binding", () => {
  test("CreateServiceCredentialRequest keeps orchestration exclusive", () => {
    const orchestrate = { name: "orchestrator", scopes: ["competition:orchestrate"] };
    expect(CreateServiceCredentialRequestSchema.safeParse(orchestrate).success).toBe(true);
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({ ...orchestrate, tableId: "table-1" }),
      "scopes"
    );
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({
        ...orchestrate,
        tableId: "table-1",
        seat: 0,
      }),
      "scopes"
    );
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({
        ...orchestrate,
        scopes: ["competition:orchestrate", "table:observe"],
      }),
      "scopes"
    );
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({
        ...orchestrate,
        scopes: ["competition:orchestrate", "table:act"],
        tableId: "table-1",
      }),
      "scopes"
    );
  });

  test("table grants are always resource-bound", () => {
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
      }).success
    ).toBe(true);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
        seat: 3,
      }).success
    ).toBe(true);
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({ name: "bot", scopes: ["table:act"] }),
      "tableId"
    );
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        seat: 3,
      }),
      "seat"
    );
    expectRejected(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:observe"],
        tableId: "table-1",
        seat: 10,
      }),
      "seat"
    );
  });

  test("bounds scopes, expiry and strict operator fields", () => {
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: [],
        tableId: "table-1",
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:observe", "table:act", "table:chat", "table:observe", "table:act"],
        tableId: "table-1",
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
        expiresAt: ISO,
      }).success
    ).toBe(true);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
        expiresAt: "not-a-date",
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bad$name",
        scopes: ["table:act"],
        tableId: "table-1",
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
        isOperator: true,
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot",
        scopes: ["table:act"],
        tableId: "table-1",
        principalId: "principal-svc-1",
      }).success
    ).toBe(true);
  });

  test("CreatedServiceCredentialSchema binds the created response shape", () => {
    const created = {
      id: "abcdef0123456789",
      userId: "svc-user",
      name: "bot-1",
      scopes: ["table:act"],
      tableId: "table-1",
      seat: 3,
      expiresAt: ISO,
      token: "ptsvc_one_time",
    };
    expect(CreatedServiceCredentialSchema.safeParse(created).success).toBe(true);

    // An orchestration credential is exactly one scope and no resource binding.
    const orchestration = {
      ...created,
      scopes: ["competition:orchestrate"],
      tableId: null,
      seat: null,
    };
    expect(CreatedServiceCredentialSchema.safeParse(orchestration).success).toBe(true);
    expectRejected(
      CreatedServiceCredentialSchema.safeParse({ ...orchestration, tableId: "table-1" }),
      "tableId"
    );
    expectRejected(CreatedServiceCredentialSchema.safeParse({ ...orchestration, seat: 0 }), "seat");
    expectRejected(
      CreatedServiceCredentialSchema.safeParse({
        ...orchestration,
        scopes: ["competition:orchestrate", "table:observe"],
      }),
      "scopes"
    );

    // A table credential is always resource-bound.
    expectRejected(
      CreatedServiceCredentialSchema.safeParse({ ...created, tableId: null }),
      "tableId"
    );
    // The one-time token is required and never empty; nothing else leaks in.
    expect(CreatedServiceCredentialSchema.safeParse({ ...created, token: "" }).success).toBe(false);
    expect(CreatedServiceCredentialSchema.safeParse({ ...created, plaintext: true }).success).toBe(
      false
    );
  });

  test("ServiceCredentialSummarySchema carries the same conditional bindings", () => {
    const summary = {
      id: "abcdef0123456789",
      userId: "svc-user",
      name: "bot-1",
      scopes: ["table:observe", "table:act"],
      tableId: "table-1",
      seat: null,
      revoked: false,
      expiresAt: ISO,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: ISO,
    };
    expect(ServiceCredentialSummarySchema.safeParse(summary).success).toBe(true);

    const orchestration = { ...summary, scopes: ["competition:orchestrate"], tableId: null };
    expect(ServiceCredentialSummarySchema.safeParse(orchestration).success).toBe(true);
    expectRejected(
      ServiceCredentialSummarySchema.safeParse({ ...orchestration, tableId: "table-1" }),
      "tableId"
    );
    expectRejected(ServiceCredentialSummarySchema.safeParse({ ...orchestration, seat: 2 }), "seat");
    expectRejected(
      ServiceCredentialSummarySchema.safeParse({
        ...orchestration,
        scopes: ["competition:orchestrate", "table:act"],
      }),
      "scopes"
    );
    expectRejected(
      ServiceCredentialSummarySchema.safeParse({ ...summary, tableId: null }),
      "tableId"
    );
    // A summary must never leak the plaintext token.
    expect(
      ServiceCredentialSummarySchema.safeParse({ ...summary, token: "ptsvc_leak" }).success
    ).toBe(false);
  });
});

// ============================================================================
// Masked state: redaction and private runtime payload fields
// ============================================================================

function makePublicPlayer(
  overrides: Partial<PublicPlayer> & { id: string; seat: number }
): PublicPlayer {
  return {
    name: overrides.id,
    stack: 1000,
    hand: null,
    shownCards: null,
    status: PlayerStatus.ACTIVE,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: null,
    pendingStand: false,
    ...overrides,
  };
}

/** Engine-shaped masked state; `randomProvider`/`previousStates` must drop. */
function makePublicState(overrides: Partial<PublicState> = {}): PublicState {
  return {
    config: { smallBlind: 1, bigBlind: 2, maxPlayers: 2, randomProvider: () => 0.5 },
    players: [
      makePublicPlayer({ id: "viewer", seat: 0, hand: ["As", "Kd"], betThisStreet: 2 }),
      makePublicPlayer({ id: "opponent", seat: 1, betThisStreet: 2 }),
    ],
    maxPlayers: 2,
    handNumber: 1,
    buttonSeat: 0,
    bigBlindSeat: 1,
    deck: [],
    board: [],
    street: Street.PREFLOP,
    pots: [{ amount: 4, eligibleSeats: [0, 1], type: "MAIN", capPerPlayer: 2 }],
    currentBets: new Map([
      [0, 2],
      [1, 2],
    ]),
    minRaise: 2,
    lastRaiseAmount: 2,
    actionTo: 0,
    lastAggressorSeat: 1,
    activePlayers: [0, 1],
    winners: null,
    rakeThisHand: 0,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    blindLevel: 0,
    timeBanks: new Map([
      [0, 30],
      [1, 30],
    ]),
    timeBankActiveSeat: null,
    actionHistory: [
      {
        action: { type: ActionType.CHECK, playerId: "viewer" },
        seat: 0,
        resultingPot: 4,
        resultingStack: 998,
        street: "PREFLOP",
      },
    ],
    previousStates: [],
    timestamp: 1700000000000,
    handId: "hand-1",
    viewingPlayerId: "viewer",
    version: 1,
    ...overrides,
  };
}

const validWireState = toPublicWireState(makePublicState());

describe("masked state: redaction and private runtime payload fields", () => {
  test("toPublicTableConfig copies every serializable option and drops private hooks", () => {
    const fullConfig: PublicState["config"] = {
      smallBlind: 5,
      bigBlind: 10,
      ante: 1,
      maxPlayers: 6,
      initialStack: 1500,
      blindStructure: [
        { smallBlind: 5, bigBlind: 10, ante: 1 },
        { smallBlind: 10, bigBlind: 20, ante: 2 },
      ],
      timeBankSeconds: 30,
      timeBankDeductionSeconds: 10,
      actionTimeoutSeconds: 45,
      allowSpectators: true,
      randomProvider: () => 0.5,
      rakePercent: 5,
      rakeCap: 3,
      noFlopNoDrop: false,
      validateIntegrity: true,
      isClient: false,
    };
    const projected = toPublicTableConfig(fullConfig);
    expect(projected).toEqual({
      smallBlind: 5,
      bigBlind: 10,
      ante: 1,
      maxPlayers: 6,
      initialStack: 1500,
      blindStructure: [
        { smallBlind: 5, bigBlind: 10, ante: 1 },
        { smallBlind: 10, bigBlind: 20, ante: 2 },
      ],
      timeBankSeconds: 30,
      timeBankDeductionSeconds: 10,
      actionTimeoutSeconds: 45,
      allowSpectators: true,
      rakePercent: 5,
      rakeCap: 3,
      noFlopNoDrop: false,
      validateIntegrity: true,
      isClient: false,
    });
    expect(Object.keys(projected)).not.toContain("randomProvider");
    expect(PublicTableConfigSchema.safeParse(projected).success).toBe(true);

    const minimal = toPublicTableConfig({ smallBlind: 1, bigBlind: 2 });
    expect(minimal).toEqual({ smallBlind: 1, bigBlind: 2 });
  });

  test("toPublicWirePlayer maps the full player projection and copies card arrays", () => {
    const player = makePublicPlayer({
      id: "player-3",
      seat: 3,
      stack: 500,
      hand: ["As", "Kd"],
      shownCards: [0],
      status: PlayerStatus.FOLDED,
      betThisStreet: 10,
      totalInvestedThisHand: 20,
      isSittingOut: true,
      timeBank: 12,
      pendingAddOn: 5,
      sitInOption: SitInOption.WAIT_FOR_BB,
      reservationExpiry: 123,
      pendingStand: true,
    });
    const projected = toPublicWirePlayer({
      ...player,
      // Private runtime fields on the engine object are never projected.
      walletAddress: ADDRESS_A,
    } as PublicPlayer);
    expect(projected).toEqual({
      id: "player-3",
      name: "player-3",
      seat: 3,
      stack: 500,
      hand: ["As", "Kd"],
      shownCards: [0],
      status: PlayerStatus.FOLDED,
      betThisStreet: 10,
      totalInvestedThisHand: 20,
      isSittingOut: true,
      timeBank: 12,
      pendingAddOn: 5,
      sitInOption: SitInOption.WAIT_FOR_BB,
      reservationExpiry: 123,
      pendingStand: true,
    });
    expect("walletAddress" in projected).toBe(false);
    expect(projected.hand).not.toBe(player.hand);
    expect(projected.shownCards).not.toBe(player.shownCards);
    expect(PublicWirePlayerSchema.safeParse(projected).success).toBe(true);
  });

  test("toPublicWireState sanitizes in-flight and completed runtime payloads", () => {
    const inFlight = toPublicWireState(makePublicState());
    expect(PublicWireStateSchema.safeParse(inFlight).success).toBe(true);
    expect(inFlight.currentBets).toEqual({ "0": 2, "1": 2 });
    expect(inFlight.timeBanks).toEqual({ "0": 30, "1": 30 });
    expect("randomProvider" in inFlight.config).toBe(false);
    expect("previousStates" in inFlight).toBe(false);
    expect(inFlight.deck).toEqual([]);
    expect(inFlight.actionHistory).toEqual([
      { type: ActionType.CHECK, seat: 0, resultingPot: 4, resultingStack: 998, street: "PREFLOP" },
    ]);
    expect("initialChips" in inFlight).toBe(false);
    expect(parsePublicWireState(serializePublicWireState(inFlight))).toEqual(inFlight);

    const opponent = makePublicPlayer({
      id: "opponent",
      seat: 1,
      hand: ["Qh", "Qs"],
      shownCards: [0, 1],
    });
    const completeState = makePublicState({
      street: Street.SHOWDOWN,
      actionTo: null,
      players: [makePublicPlayer({ id: "viewer", seat: 0, hand: ["As", "Kd"] }), opponent],
      winners: [{ seat: 0, amount: 4, hand: ["As", "Kd"], handRank: "Pair of Aces" }],
      initialChips: 2000,
    });
    const complete = toPublicWireState(completeState);
    expect(PublicWireStateSchema.safeParse(complete).success).toBe(true);
    expect(complete.winners).toEqual([
      { seat: 0, amount: 4, hand: ["As", "Kd"], handRank: "Pair of Aces" },
    ]);
    // Projected arrays are copies, never engine references.
    expect(complete.winners?.[0].hand).not.toBe(completeState.winners?.[0].hand);
    expect(complete.players[1]?.shownCards).not.toBe(completeState.players[1]?.shownCards);
    expect(complete.initialChips).toBe(2000);

    // An uncontested winner has no revealed hand or rank.
    const uncontested = toPublicWireState(
      makePublicState({
        street: Street.SHOWDOWN,
        actionTo: null,
        winners: [{ seat: 0, amount: 4, hand: null, handRank: null }],
      })
    );
    expect(uncontested.winners).toEqual([{ seat: 0, amount: 4, hand: null, handRank: null }]);
    expect(PublicWireStateSchema.safeParse(uncontested).success).toBe(true);

    const withNullSeat = toPublicWireState(
      makePublicState({
        players: [makePublicPlayer({ id: "viewer", seat: 0, hand: ["As", "Kd"] }), null],
      })
    );
    expect(withNullSeat.players[1]).toBeNull();

    const spectator = toPublicWireState(
      makePublicState({
        viewingPlayerId: "not-seated",
        players: [
          makePublicPlayer({ id: "viewer", seat: 0 }),
          makePublicPlayer({ id: "opponent", seat: 1 }),
        ],
      })
    );
    expect(spectator.viewingPlayerId).toBeNull();
  });

  test("PublicWireStateSchema rejects redaction violations across the hand lifecycle", () => {
    // players must be a full seat array.
    expect(
      PublicWireStateSchema.safeParse({
        ...validWireState,
        players: validWireState.players.slice(0, 1),
      }).success
    ).toBe(false);
    // a player must sit at its own array index.
    const misseated = structuredClone(validWireState);
    misseated.players[1]!.seat = 0;
    expect(PublicWireStateSchema.safeParse(misseated).success).toBe(false);
    // an unmasked deck is never wire state.
    expect(PublicWireStateSchema.safeParse({ ...validWireState, deck: [1, 2, 3] }).success).toBe(
      false
    );
    // viewingPlayerId must reference a seated player.
    expect(
      PublicWireStateSchema.safeParse({ ...validWireState, viewingPlayerId: "ghost" }).success
    ).toBe(false);

    // In-flight opponent cards stay masked.
    const opponentLeak = structuredClone(validWireState);
    opponentLeak.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(opponentLeak).success).toBe(false);

    // A showdown reveal must expose a positional hand array.
    const missingHand = structuredClone(validWireState);
    missingHand.street = "SHOWDOWN";
    missingHand.actionTo = null;
    missingHand.players[1]!.shownCards = [0, 1];
    expect(PublicWireStateSchema.safeParse(missingHand).success).toBe(false);

    // A legitimate complete reveal passes, including a positional placeholder.
    const reveal = structuredClone(validWireState);
    reveal.street = "SHOWDOWN";
    reveal.actionTo = null;
    reveal.players[1]!.shownCards = [0];
    reveal.players[1]!.hand = ["Qh", null];
    expect(PublicWireStateSchema.safeParse(reveal).success).toBe(true);

    // Viewer lifecycle: showdown with a mucked hand is still a viewer state...
    const muckedViewer = structuredClone(validWireState);
    muckedViewer.street = "SHOWDOWN";
    muckedViewer.actionTo = null;
    muckedViewer.players[0]!.hand = null;
    expect(PublicWireStateSchema.safeParse(muckedViewer).success).toBe(true);
    // ...as is a partial positional hand at any street.
    const partialViewer = structuredClone(validWireState);
    partialViewer.players[0]!.hand = ["As", null];
    expect(PublicWireStateSchema.safeParse(partialViewer).success).toBe(true);
    // Fully masked viewer hands carry no visible cards.
    const maskedViewer = structuredClone(validWireState);
    maskedViewer.players[0]!.hand = [null, null];
    expect(PublicWireStateSchema.safeParse(maskedViewer).success).toBe(true);

    // Spectators never see unmasked cards.
    const spectatorLeak = structuredClone(validWireState);
    spectatorLeak.viewingPlayerId = null;
    expect(PublicWireStateSchema.safeParse(spectatorLeak).success).toBe(false);
  });
});

// ============================================================================
// Turn / replay / operations contract regressions
// ============================================================================

const chainedEvent = (seq: number, overrides: Record<string, unknown> = {}) => ({
  eventId: `event-${seq}`,
  tableId: "table-1",
  eventSeq: seq,
  version: seq,
  type: "ACTION_APPLIED",
  occurredAt: 1700000000000 + seq,
  payload: { actionId: "action-1" },
  previousHash: seq === 1 ? null : `hash-${seq - 1}`,
  hash: `hash-${seq}`,
  ...overrides,
});

describe("turn and replay contract regressions", () => {
  test("LegalActionSchema bounds chip amounts for betting families", () => {
    expect(
      LegalActionSchema.safeParse({
        actionId: "action-1",
        family: "BET",
        minAmount: 40,
        maxAmount: 100,
      }).success
    ).toBe(true);
    expectRejected(
      LegalActionSchema.safeParse({
        actionId: "action-1",
        family: "BET",
        minAmount: 40,
        maxAmount: 100,
        amount: 20,
      }),
      "amount"
    );
    expect(
      LegalActionSchema.safeParse({ actionId: "action-1", family: "CALL", amount: 20 }).success
    ).toBe(true);
    expect(
      LegalActionSchema.safeParse({ actionId: "action-1", family: "FOLD", amount: 1 }).success
    ).toBe(false);
    expect(LegalActionSchema.safeParse({ actionId: "action-1", family: "RAISE" }).success).toBe(
      false
    );
  });

  test("SeatObservation ties identity/version to its masked state", () => {
    const legalActions = [
      { actionId: "action-1", family: "FOLD" },
      { actionId: "action-2", family: "CALL", amount: 20 },
    ];
    const observation = {
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-1",
      version: 4,
      eventSeq: 12,
      state: { ...validWireState, version: 4 },
      legalActions,
    };
    expect(SeatObservationSchema.safeParse(observation).success).toBe(true);
    expect(
      SeatObservationSchema.safeParse({
        ...observation,
        state: { ...validWireState, version: 5 },
      }).success
    ).toBe(false);
    expect(
      SeatObservationSchema.safeParse({
        ...observation,
        legalActions: [
          { actionId: "action-1", family: "FOLD" },
          { actionId: "action-1", family: "CALL", amount: 20 },
        ],
      }).success
    ).toBe(false);
  });

  test("CanonicalActionResult receipt must identify its resulting observation", () => {
    const receipt = {
      requestId: "request-1",
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-1",
      actionId: "action-1",
      version: 5,
      eventSeq: 13,
      acceptedAt: 1700000000000,
    };
    expect(CanonicalActionReceiptSchema.safeParse(receipt).success).toBe(true);
    const observation = {
      tableId: "table-1",
      handId: "hand-1",
      turnId: "turn-2",
      version: 5,
      eventSeq: 13,
      state: { ...validWireState, version: 5 },
      legalActions: [{ actionId: "action-2", family: "CALL", amount: 20 }],
    };
    expect(CanonicalActionResultSchema.safeParse({ receipt, observation }).success).toBe(true);
    expect(
      CanonicalActionResultSchema.safeParse({
        receipt: { ...receipt, eventSeq: 14 },
        observation,
      }).success
    ).toBe(false);
  });

  test("isContiguousEventSeq enforces +1 steps", () => {
    expect(isContiguousEventSeq([])).toBe(true);
    expect(isContiguousEventSeq([{ eventSeq: 5 }])).toBe(true);
    expect(isContiguousEventSeq([{ eventSeq: 1 }, { eventSeq: 2 }, { eventSeq: 3 }])).toBe(true);
    expect(isContiguousEventSeq([{ eventSeq: 1 }, { eventSeq: 3 }])).toBe(false);
    expect(isContiguousEventSeq([{ eventSeq: 2 }, { eventSeq: 1 }])).toBe(false);
  });

  test("ReplayFrameSchema refuses reordered, cross-table and falsely-valid frames", () => {
    const valid = {
      tableId: "table-1",
      fromEventSeq: 1,
      toEventSeq: 2,
      anchorHash: null,
      headEventSeq: 2,
      events: [chainedEvent(1), chainedEvent(2)],
      chainValid: true,
    };
    expect(ReplayFrameSchema.safeParse(valid).success).toBe(true);

    expectRejected(
      ReplayFrameSchema.safeParse({
        ...valid,
        fromEventSeq: 2,
        toEventSeq: 1,
        events: [chainedEvent(2)],
      }),
      "toEventSeq"
    );
    expectRejected(
      ReplayFrameSchema.safeParse({
        ...valid,
        events: [chainedEvent(1, { tableId: "other-table" }), chainedEvent(2)],
      }),
      "events.0.tableId"
    );
    // An empty frame inside the log cannot claim a valid chain.
    expectRejected(
      ReplayFrameSchema.safeParse({
        tableId: "table-1",
        fromEventSeq: 1,
        toEventSeq: 2,
        anchorHash: null,
        headEventSeq: 2,
        events: [],
        chainValid: true,
      }),
      "chainValid"
    );
    // An empty slice requested beyond the log head is not a false chain claim:
    // the emptiness guard only applies within the authoritative log.
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "table-1",
        fromEventSeq: 5,
        toEventSeq: 5,
        anchorHash: null,
        headEventSeq: 3,
        events: [],
        chainValid: true,
      }).success
    ).toBe(true);
    // A gap is never a contiguous chain.
    expectRejected(
      ReplayFrameSchema.safeParse({
        ...valid,
        toEventSeq: 3,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(3)],
        chainValid: false,
      }),
      "events"
    );
    // A non-contiguous frame cannot claim a valid chain.
    expectRejected(
      ReplayFrameSchema.safeParse({
        ...valid,
        toEventSeq: 3,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(3)],
        chainValid: true,
      }),
      "chainValid"
    );
    // A truncated slice cannot claim a complete chain.
    expectRejected(
      ReplayFrameSchema.safeParse({
        ...valid,
        toEventSeq: 3,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(2)],
        chainValid: true,
      }),
      "chainValid"
    );
  });

  test("ReplayFrameEvent carries optional action correlation without leaking internals", () => {
    const event = chainedEvent(1);
    expect(ReplayFrameEventSchema.safeParse(event).success).toBe(true);
    expect(
      ReplayFrameEventSchema.safeParse({
        ...event,
        turnId: null,
        requestId: "request-1",
        actionId: "action-1",
      }).success
    ).toBe(true);
    expect(ReplayFrameEventSchema.safeParse({ ...event, playerId: "leak" }).success).toBe(false);
    expect(
      ReplayRequestSchema.safeParse({ tableId: "table-1", fromEventSeq: 1, includeState: true })
        .success
    ).toBe(true);
  });
});

describe("operational contract regressions", () => {
  const openIncident = () => ({
    id: "incident-1",
    kind: "RPC_QUORUM_FAILURE",
    severity: "CRITICAL",
    status: "OPEN",
    assetId: null,
    chainId: null,
    affectedId: null,
    evidence: {},
    createdAt: 1700000000000,
    resolvedAt: null,
    operatorId: null,
    operatorEvidence: null,
  });

  test("open incidents cannot carry resolution audit fields", () => {
    expect(FinancialIncidentSchema.safeParse(openIncident()).success).toBe(true);
    expectRejected(
      FinancialIncidentSchema.safeParse({ ...openIncident(), operatorId: "operator-1" }),
      "operatorId"
    );
    expectRejected(
      FinancialIncidentSchema.safeParse({
        ...openIncident(),
        operatorEvidence: { note: "rechecked" },
      }),
      "operatorEvidence"
    );
    expectRejected(
      FinancialIncidentSchema.safeParse({
        ...openIncident(),
        status: "RESOLVED",
        resolvedAt: 1700000001000,
        operatorId: "operator-1",
      }),
      "operatorEvidence"
    );
    expect(
      FinancialIncidentSchema.safeParse({
        ...openIncident(),
        status: "RESOLVED",
        resolvedAt: 1700000001000,
        operatorId: "operator-1",
        operatorEvidence: { note: "rechecked" },
      }).success
    ).toBe(true);
  });

  test("readiness responses never claim ready while blocked", () => {
    const blocked = { state: "BLOCKED", reasons: ["RPC_QUORUM_UNVERIFIED"], checks: [] };
    const readyCheck = { name: "rpc", state: "READY", mandatory: true, latencyMs: 1, detail: "ok" };
    expect(
      ReadinessResponseSchema.safeParse({
        status: "not_ready",
        timestamp: 1,
        checks: [{ ...readyCheck, state: "NOT_READY", detail: "down" }],
        financial: blocked,
      }).success
    ).toBe(true);
    expect(
      ReadinessResponseSchema.safeParse({
        status: "ready",
        timestamp: 1,
        checks: [readyCheck],
        financial: { state: "READY", reasons: [], checks: [] },
      }).success
    ).toBe(true);
    expect(
      ReadinessResponseSchema.safeParse({
        status: "ready",
        timestamp: 1,
        checks: [{ ...readyCheck, state: "NOT_READY" }],
        financial: blocked,
      }).success
    ).toBe(false);
    expect(
      FinancialReadinessSchema.safeParse({ state: "DEGRADED", reasons: [], checks: [] }).success
    ).toBe(true);
  });
});

// ============================================================================
// Public DTO alias surface and remaining canonical finance contracts
// ============================================================================

describe("public DTO alias surface", () => {
  test("api/competitions re-exports the canonical competition schemas", () => {
    const names = [
      "AgentTableScopeSchema",
      "CancelCompetitionRequestSchema",
      "CancelCompetitionResponseSchema",
      "CompetitionAssetAmountSchema",
      "CompetitionCancellationEntrySchema",
      "CompetitionEntrantSchema",
      "CompetitionEntrantSpecSchema",
      "CompetitionEntryPayerSchema",
      "CompetitionEntryStateSchema",
      "CompetitionEntryTermsSchema",
      "CompetitionModeSchema",
      "CompetitionPlacementSchema",
      "CompetitionPrizeStatusSchema",
      "CompetitionPrizeTermsSchema",
      "CompetitionSchema",
      "CompetitionSeatAssignmentSchema",
      "CompetitionStatusSchema",
      "CompetitionTermsSchema",
      "CreateCompetitionRequestSchema",
      "CreateCompetitionResponseSchema",
      "GetCompetitionResponseSchema",
      "IssueAgentCredentialRequestSchema",
      "IssuedAgentCredentialSchema",
      "OptInCompetitionRequestSchema",
      "OptInCompetitionResponseSchema",
      "PositiveAtomicAmountSchema",
      "SettleCompetitionRequestSchema",
      "SettleCompetitionResponseSchema",
      "StartCompetitionRequestSchema",
      "StartCompetitionResponseSchema",
    ] as const;
    for (const name of names) {
      expect(apiCompetition[name]).toBe(canonicalCompetition[name]);
    }
    expect(apiCompetition.CreateCompetitionRequestSchema.safeParse(createRequest()).success).toBe(
      true
    );
  });

  test("api/service-principals re-exports the canonical service-principal schemas", () => {
    const names = [
      "ProvisionServicePrincipalRequestSchema",
      "ProvisionedServicePrincipalSchema",
      "RevokeServicePrincipalDelegationRequestSchema",
      "RevokeServicePrincipalDelegationResponseSchema",
      "RotateServiceCredentialRequestSchema",
      "ServiceCredentialRefSchema",
      "ServicePrincipalDelegationSchema",
    ] as const;
    for (const name of names) {
      expect(apiServicePrincipals[name]).toBe(canonicalServicePrincipal[name]);
    }
    expect(
      apiServicePrincipals.ProvisionServicePrincipalRequestSchema.safeParse({ name: "agent-1" })
        .success
    ).toBe(true);
  });
});

describe("finance contract surfaces", () => {
  test("asset/deposit vocabularies stay closed", () => {
    for (const status of ["ACTIVE", "DEGRADED", "FROZEN"]) {
      expect(AssetStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(AssetStatusSchema.safeParse("PAUSED").success).toBe(false);
    for (const status of ["OBSERVED", "CONFIRMED", "CREDITED", "ORPHANED", "FAILED"]) {
      expect(DepositStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(DepositStatusSchema.safeParse("DONE").success).toBe(false);
    // Only the direct treasury rail is a real writer; unsupported rail states
    // (sweep/migration) are not canonical wire values.
    expect(DepositProvenanceSchema.safeParse("DIRECT_TREASURY").success).toBe(true);
    expect(DepositProvenanceSchema.safeParse("SWEEP").success).toBe(false);
    expect(DepositProvenanceSchema.safeParse("MIGRATION").success).toBe(false);
    expect(DepositProvenanceSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  test("exact on-chain log identity and withdrawal signature shape", () => {
    const txHash = `0x${"a".repeat(64)}`;
    const blockHash = `0x${"b".repeat(64)}`;
    const logRef = { txHash, logIndex: 3, blockNumber: 10, blockHash };
    expect(TransactionLogRefSchema.safeParse(logRef).success).toBe(true);
    expect(TransactionLogRefSchema.safeParse({ ...logRef, logIndex: -1 }).success).toBe(false);
    expect(TransactionLogRefSchema.safeParse({ ...logRef, extra: true }).success).toBe(false);
    expect(
      TransactionLogRefSchema.safeParse({ ...logRef, txHash: `0x${"A".repeat(64)}` }).success
    ).toBe(false);
    expect(WithdrawalSignatureSchema.safeParse(`0x${"a".repeat(130)}`).success).toBe(true);
    expect(WithdrawalSignatureSchema.safeParse("0x1234").success).toBe(false);
  });

  test("EIP-712 withdrawal domain is fixed and typed data is strict", () => {
    const domain = {
      name: "PokerTools Withdrawal",
      version: "1",
      chainId: 1,
      verifyingContract: ADDRESS_A,
    };
    expect(Eip712DomainSchema.safeParse(domain).success).toBe(true);
    expect(Eip712DomainSchema.safeParse({ ...domain, name: "" }).success).toBe(false);
    expect(Eip712DomainSchema.safeParse({ ...domain, extra: 1 }).success).toBe(false);
    expect(WithdrawalEip712DomainSchema.safeParse(domain).success).toBe(true);
    expect(WithdrawalEip712DomainSchema.safeParse({ ...domain, name: "Evil" }).success).toBe(false);
    expect(WithdrawalEip712DomainSchema.safeParse({ ...domain, version: "2" }).success).toBe(false);

    const typedData = {
      types: { WithdrawalIntent: [{ name: "intentId", type: "string" }] },
      primaryType: "WithdrawalIntent",
      domain,
      message: { intentId: "withdrawal-1" },
    };
    expect(Eip712TypedDataSchema.safeParse(typedData).success).toBe(true);
    expect(
      Eip712TypedDataSchema.safeParse({ ...typedData, domain: { ...domain, name: "Evil" } }).success
    ).toBe(false);
    expect(Eip712TypedDataSchema.safeParse({ ...typedData, extra: true }).success).toBe(false);

    expect(WITHDRAWAL_INTENT_EIP712_FIELDS.map((field) => field.name)).toEqual([
      "intentId",
      "principalId",
      "assetId",
      "destination",
      "amountAtomic",
      "nonce",
      "deadline",
      "chainId",
    ]);
    expect(
      WITHDRAWAL_INTENT_EIP712_FIELDS.find((field) => field.name === "amountAtomic")?.type
    ).toBe("uint256");
    expect(
      WITHDRAWAL_INTENT_EIP712_FIELDS.find((field) => field.name === "destination")?.type
    ).toBe("address");
  });
});
