import {
  // primitives
  AtomicAmountSchema,
  MAX_ATOMIC_AMOUNT,
  MAX_UINT256,
  atomicAmountToBigInt,
  bigIntToAtomicAmount,
  // principal / auth
  PrincipalSchema,
  ServiceScopeSchema,
  // public wire state + adapter
  PublicWireStateSchema,
  MaskedPublicStateSchema,
  toPublicWireState,
  serializePublicWireState,
  parsePublicWireState,
  // table / turn / action
  LegalActionSchema,
  SeatObservationSchema,
  CanonicalActionRequestSchema,
  CanonicalActionReceiptSchema,
  CanonicalActionResultSchema,
  // streams
  TableEventSchema,
  isAppendOnlyEventStream,
  ChatMessageSchema,
  ReplayRequestSchema,
  ReplayFrameSchema,
  // finance
  AssetSchema,
  AssetIdSchema,
  BalanceSchema,
  DepositClaimRequestSchema,
  DepositClaimSchema,
  WithdrawalIntentSchema,
  WithdrawalSubmissionSchema,
  WithdrawalRecordSchema,
  WithdrawalStatusSchema,
  withdrawalIntentTypedData,
  createWithdrawalDomain,
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
  WITHDRAWAL_INTENT_PRIMARY_TYPE,
  // operations
  FinancialIncidentSchema,
  IncidentKindSchema,
  FinancialReadinessSchema,
  // tournament
  TournamentSeatAssignmentSchema,
  TournamentPayoutSettlementSchema,
  TournamentEventSchema,
  // rest
  ErrorResponseSchema,
  LoginRequestSchema,
  NonceResponseSchema,
  TableListItemSchema,
  GetTablesResponseSchema,
  TournamentListItemSchema,
  TournamentDetailsSchema,
  StartTournamentResponseSchema,
  SettleTournamentResponseSchema,
  type PublicState,
  type PublicPlayer,
  Street,
  ActionType,
  PlayerStatus,
  SitInOption,
} from "../src";

const ASSET_A = "eip155:1/erc20:0x1111111111111111111111111111111111111111";
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;

const validAsset = {
  assetId: ASSET_A,
  chainId: 1,
  tokenAddress: ADDRESS_A,
  decimals: 6,
  symbol: "USDC",
  status: "ACTIVE" as const,
  confirmations: 12,
  deepFinality: 64,
};

function makePlayer(overrides: Partial<PublicPlayer> & { id: string; seat: number }): PublicPlayer {
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

/** Engine-shaped masked public state; `randomProvider` proves private hooks drop. */
function makePublicState(overrides: Partial<PublicState> = {}): PublicState {
  return {
    config: { smallBlind: 1, bigBlind: 2, maxPlayers: 3, randomProvider: () => 0.5 },
    players: [
      makePlayer({
        id: "p1",
        seat: 0,
        hand: ["As", "Kd"],
        betThisStreet: 2,
        totalInvestedThisHand: 2,
      }),
      makePlayer({ id: "p2", seat: 1, betThisStreet: 2, totalInvestedThisHand: 2 }),
      null,
    ],
    maxPlayers: 3,
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
        action: { type: ActionType.CHECK, playerId: "p1" },
        seat: 0,
        resultingPot: 4,
        resultingStack: 998,
        street: Street.PREFLOP,
      },
    ],
    previousStates: [],
    timestamp: 1700000000000,
    handId: "hand-1",
    viewingPlayerId: "p1",
    version: 1,
    ...overrides,
  };
}

const wireState = toPublicWireState(makePublicState());

describe("canonical primitives: atomic amounts", () => {
  test.each(["0", "1", "10", "9007199254740993", MAX_ATOMIC_AMOUNT])(
    "accepts canonical amount %s",
    (value) => {
      expect(AtomicAmountSchema.safeParse(value).success).toBe(true);
    }
  );

  test.each(["", "00", "01", "-1", "+1", "1.0", "1e18", " 1", "1 ", "0x1", "abc", "1_000"])(
    "rejects non-canonical amount %p",
    (value) => {
      expect(AtomicAmountSchema.safeParse(value).success).toBe(false);
    }
  );

  test("enforces the uint256 boundary with bigint precision", () => {
    expect(AtomicAmountSchema.safeParse((MAX_UINT256 + 1n).toString()).success).toBe(false);
    expect(AtomicAmountSchema.safeParse((2n ** 300n).toString()).success).toBe(false);
    const beyondSafe = (BigInt(Number.MAX_SAFE_INTEGER) + 10n).toString();
    expect(AtomicAmountSchema.safeParse(beyondSafe).success).toBe(true);
  });

  test("converts to/from bigint without precision loss", () => {
    const beyondSafe = "9007199254740993";
    expect(atomicAmountToBigInt(beyondSafe)).toBe(9007199254740993n);
    expect(atomicAmountToBigInt(beyondSafe) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(bigIntToAtomicAmount(0n)).toBe("0");
    expect(bigIntToAtomicAmount(MAX_UINT256)).toBe(MAX_ATOMIC_AMOUNT);
    expect(() => bigIntToAtomicAmount(-1n)).toThrow(RangeError);
    expect(() => bigIntToAtomicAmount(MAX_UINT256 + 1n)).toThrow(RangeError);
  });
});

describe("canonical principal contracts", () => {
  test("public principal is exactly three fields", () => {
    expect(
      PrincipalSchema.safeParse({ id: "u1", kind: "WALLET", walletAddress: ADDRESS_A }).success
    ).toBe(true);
    // richer internal context is rejected on the public shape
    expect(
      PrincipalSchema.safeParse({
        id: "u1",
        kind: "WALLET",
        walletAddress: ADDRESS_A,
        role: "ADMIN",
        scopes: ["table:act"],
      }).success
    ).toBe(false);
  });

  test("enforces kind/wallet consistency", () => {
    expect(
      PrincipalSchema.safeParse({ id: "u1", kind: "WALLET", walletAddress: null }).success
    ).toBe(false);
    expect(
      PrincipalSchema.safeParse({ id: "svc", kind: "SERVICE", walletAddress: ADDRESS_A }).success
    ).toBe(false);
  });

  test("service scopes stay closed", () => {
    for (const scope of ["table:observe", "table:act", "table:chat", "competition:orchestrate"]) {
      expect(ServiceScopeSchema.safeParse(scope).success).toBe(true);
    }
    expect(ServiceScopeSchema.safeParse("table:admin").success).toBe(false);
  });
});

describe("canonical public wire state + adapter", () => {
  test("adapter output validates and JSON round-trips", () => {
    const parsed = PublicWireStateSchema.safeParse(wireState);
    expect(parsed.success).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(wireState));
    expect(PublicWireStateSchema.safeParse(roundTripped).success).toBe(true);
    expect(MaskedPublicStateSchema).toBe(PublicWireStateSchema);
  });

  test("serializes Maps to string-keyed records and drops private hooks", () => {
    expect(wireState.currentBets).toEqual({ "0": 2, "1": 2 });
    expect(wireState.timeBanks).toEqual({ "0": 30, "1": 30 });
    expect((wireState.config as Record<string, unknown>).randomProvider).toBeUndefined();
    expect((wireState as Record<string, unknown>).previousStates).toBeUndefined();
  });

  test("sanitizes action history (no original Action payload)", () => {
    expect(wireState.actionHistory).toEqual([
      { type: ActionType.CHECK, seat: 0, resultingPot: 4, resultingStack: 998, street: "PREFLOP" },
    ]);
    expect(PublicWireStateSchema.safeParse({ ...wireState, previousStates: [{}] }).success).toBe(
      false
    );
  });

  test("accepts a correctly masked viewer state", () => {
    expect(PublicWireStateSchema.safeParse(wireState).success).toBe(true);
  });

  test("projects an authenticated non-seated observer as a spectator", () => {
    const state = makePublicState();
    const observer = {
      ...state,
      viewingPlayerId: "observer",
      players: state.players.map((player) => (player === null ? null : { ...player, hand: null })),
    };
    const projected = PublicWireStateSchema.parse(toPublicWireState(observer));
    expect(projected.viewingPlayerId).toBeNull();
    expect(projected.players.every((player) => player === null || player.hand === null)).toBe(true);
  });

  test("rejects an unmasked deck and non-seated viewer", () => {
    expect(PublicWireStateSchema.safeParse({ ...wireState, deck: [1, 2, 3] }).success).toBe(false);
    expect(
      PublicWireStateSchema.safeParse({ ...wireState, viewingPlayerId: "ghost" }).success
    ).toBe(false);
  });

  test("rejects visible opponent cards outside a legitimate showdown reveal", () => {
    const leaked = structuredClone(wireState);
    leaked.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(leaked).success).toBe(false);
  });

  test("accepts a legitimate showdown reveal via shownCards", () => {
    const showdown = structuredClone(wireState);
    showdown.street = "SHOWDOWN";
    showdown.actionTo = null;
    showdown.players[1]!.status = "ACTIVE";
    showdown.players[1]!.shownCards = [0, 1];
    showdown.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(showdown).success).toBe(true);

    // partial reveal: index 1 hidden must be null
    const partial = structuredClone(showdown);
    partial.players[1]!.shownCards = [0];
    partial.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(partial).success).toBe(false);
    const partialOk = structuredClone(showdown);
    partialOk.players[1]!.shownCards = [0];
    partialOk.players[1]!.hand = ["Qh", null];
    expect(PublicWireStateSchema.safeParse(partialOk).success).toBe(true);
  });

  test("rejects a showdown reveal for a folded player or before showdown", () => {
    const folded = structuredClone(wireState);
    folded.street = "SHOWDOWN";
    folded.players[1]!.status = "FOLDED";
    folded.players[1]!.shownCards = [0, 1];
    folded.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(folded).success).toBe(false);

    const preflop = structuredClone(wireState);
    preflop.players[1]!.shownCards = [0, 1];
    preflop.players[1]!.hand = ["Qh", "Qs"];
    expect(PublicWireStateSchema.safeParse(preflop).success).toBe(false);
  });

  test("spectator view reveals only at showdown", () => {
    const spectator = structuredClone(wireState);
    spectator.viewingPlayerId = null;
    spectator.players[0]!.hand = null;
    expect(PublicWireStateSchema.safeParse(spectator).success).toBe(true);

    const leaked = structuredClone(wireState);
    leaked.viewingPlayerId = null;
    leaked.players[0]!.hand = ["As", "Kd"];
    expect(PublicWireStateSchema.safeParse(leaked).success).toBe(false);
  });
});

describe("canonical legal actions and action submission", () => {
  test("validates betting bounds", () => {
    expect(
      LegalActionSchema.safeParse({
        actionId: "a1",
        family: "RAISE",
        minAmount: 40,
        maxAmount: 1000,
      }).success
    ).toBe(true);
    expect(
      LegalActionSchema.safeParse({
        actionId: "a1",
        family: "RAISE",
        minAmount: 100,
        maxAmount: 10,
      }).success
    ).toBe(false);
    expect(
      LegalActionSchema.safeParse({
        actionId: "a1",
        family: "RAISE",
        minAmount: 40,
        maxAmount: 100,
        amount: 200,
      }).success
    ).toBe(false);
    expect(LegalActionSchema.safeParse({ actionId: "a1", family: "FOLD", amount: 1 }).success).toBe(
      false
    );
    expect(LegalActionSchema.safeParse({ actionId: "a1", family: "BET" }).success).toBe(false);
    expect(LegalActionSchema.safeParse({ actionId: "a1", family: "ALL_IN" }).success).toBe(false);
    expect(
      LegalActionSchema.safeParse({
        actionId: "a1",
        family: "BET",
        minAmount: 0,
        maxAmount: Number.MAX_SAFE_INTEGER + 1,
      }).success
    ).toBe(false);
  });

  test("builds a legal-action observation with canonical wire state", () => {
    const observation = {
      tableId: "t1",
      handId: "hand-1",
      turnId: "turn-9",
      version: 4,
      eventSeq: 12,
      state: { ...wireState, version: 4 },
      legalActions: [
        { actionId: "a1", family: "FOLD" },
        { actionId: "a2", family: "CALL", amount: 20 },
        { actionId: "a3", family: "RAISE", minAmount: 40, maxAmount: 1000 },
      ],
    };
    expect(SeatObservationSchema.safeParse(observation).success).toBe(true);
  });

  test("accepts a strictly canonical action request", () => {
    expect(
      CanonicalActionRequestSchema.safeParse({
        requestId: "req-1",
        turnId: "turn-9",
        expectedVersion: 4,
        actionId: "a3",
        amount: 100,
      }).success
    ).toBe(true);
  });

  test("rejects every actor identity field on the request body", () => {
    const base = { requestId: "req-1", turnId: "turn-9", expectedVersion: 4, actionId: "a3" };
    for (const actor of [
      { playerId: "victim" },
      { principalId: "victim" },
      { seat: 0 },
      { actor: "victim" },
      { userId: "victim" },
    ]) {
      expect(CanonicalActionRequestSchema.safeParse({ ...base, ...actor }).success).toBe(false);
    }
  });

  test("enforces safe-integer chip boundaries on submission", () => {
    const base = { requestId: "req-1", turnId: "turn-9", expectedVersion: 4, actionId: "a3" };
    for (const amount of [NaN, Infinity, 1.1, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(CanonicalActionRequestSchema.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(
      CanonicalActionRequestSchema.safeParse({ ...base, amount: Number.MAX_SAFE_INTEGER }).success
    ).toBe(true);
    expect(CanonicalActionRequestSchema.safeParse({ ...base, expectedVersion: -1 }).success).toBe(
      false
    );
    expect(
      CanonicalActionRequestSchema.safeParse({ ...base, requestId: "x".repeat(129) }).success
    ).toBe(false);
  });

  test("validates an accepted receipt", () => {
    expect(
      CanonicalActionReceiptSchema.safeParse({
        requestId: "req-1",
        tableId: "t1",
        handId: "hand-1",
        turnId: "turn-9",
        actionId: "a3",
        version: 5,
        eventSeq: 13,
        acceptedAt: 1700000000000,
      }).success
    ).toBe(true);
  });

  test("shared action result carries receipt + resulting observation", () => {
    const result = {
      receipt: {
        requestId: "req-1",
        tableId: "t1",
        handId: "hand-1",
        turnId: "turn-9",
        actionId: "a3",
        version: 5,
        eventSeq: 13,
        acceptedAt: 1700000000000,
      },
      observation: {
        tableId: "t1",
        handId: "hand-1",
        turnId: "turn-10",
        version: 5,
        eventSeq: 13,
        state: { ...wireState, version: 5 },
        legalActions: [{ actionId: "a4", family: "CALL", amount: 20 }],
      },
    };
    expect(CanonicalActionResultSchema.safeParse(result).success).toBe(true);
    // strict: no compatibility/replay flags
    expect(CanonicalActionResultSchema.safeParse({ ...result, replayed: false }).success).toBe(
      false
    );
  });

  test("public wire state serializes/parses through JSON", () => {
    const json = serializePublicWireState(wireState);
    expect(parsePublicWireState(json)).toEqual(wireState);
  });
});

describe("canonical append-only streams", () => {
  const event = (seq: number) => ({
    eventId: `e${seq}`,
    tableId: "t1",
    eventSeq: seq,
    version: seq,
    type: "ACTION_APPLIED" as const,
    occurredAt: 1700000000000 + seq,
    payload: { actionId: "a3" },
  });

  const chainedEvent = (seq: number) => ({
    ...event(seq),
    previousHash: seq === 1 ? null : `h${seq - 1}`,
    hash: `h${seq}`,
  });

  test("validates events strictly and detects append-only ordering", () => {
    expect(TableEventSchema.safeParse(event(1)).success).toBe(true);
    expect(TableEventSchema.safeParse({ ...event(1), extra: true }).success).toBe(false);
    expect(TableEventSchema.safeParse({ ...event(1), type: "NOT_A_TYPE" }).success).toBe(false);
    expect(isAppendOnlyEventStream([event(1), event(2), event(3)])).toBe(true);
    expect(isAppendOnlyEventStream([event(1), event(1)])).toBe(false);
    expect(isAppendOnlyEventStream([event(2), event(1)])).toBe(false);
  });

  test("validates bounded chat with the authoritative hand id", () => {
    expect(
      ChatMessageSchema.safeParse({
        messageId: "m1",
        tableId: "t1",
        handId: "hand-1",
        eventSeq: 1,
        principalId: "p1",
        body: "gl",
        sentAt: 1700000000000,
      }).success
    ).toBe(true);
    expect(
      ChatMessageSchema.safeParse({
        messageId: "m1",
        tableId: "t1",
        handId: "hand-1",
        eventSeq: 1,
        principalId: "p1",
        body: "",
        sentAt: 1700000000000,
      }).success
    ).toBe(false);
    // chat without a hand id is not a canonical message
    expect(
      ChatMessageSchema.safeParse({
        messageId: "m1",
        tableId: "t1",
        eventSeq: 1,
        principalId: "p1",
        body: "gl",
        sentAt: 1700000000000,
      }).success
    ).toBe(false);
  });

  test("validates replay requests and frames", () => {
    expect(
      ReplayRequestSchema.safeParse({ tableId: "t1", fromEventSeq: 1, toEventSeq: 3 }).success
    ).toBe(true);
    expect(
      ReplayRequestSchema.safeParse({ tableId: "t1", fromEventSeq: 3, toEventSeq: 1 }).success
    ).toBe(false);
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 1,
        toEventSeq: 2,
        anchorHash: null,
        headEventSeq: 2,
        events: [chainedEvent(1), chainedEvent(2)],
        chainValid: true,
        state: wireState,
      }).success
    ).toBe(true);
    // a non-contiguous / reordered slice is rejected
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 1,
        toEventSeq: 2,
        anchorHash: null,
        headEventSeq: 2,
        events: [chainedEvent(2), chainedEvent(1)],
        chainValid: false,
      }).success
    ).toBe(false);
    // a missing middle event is rejected
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 1,
        toEventSeq: 3,
        anchorHash: null,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(3)],
        chainValid: false,
      }).success
    ).toBe(false);
    // a chain that misses its last requested event cannot claim validity
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 1,
        toEventSeq: 3,
        anchorHash: null,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(2)],
        chainValid: true,
      }).success
    ).toBe(false);
    // ...but a truncated slice may still be structurally valid as long as it
    // does not claim a complete chain.
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 1,
        toEventSeq: 3,
        anchorHash: null,
        headEventSeq: 3,
        events: [chainedEvent(1), chainedEvent(2)],
        chainValid: false,
      }).success
    ).toBe(true);
    // a sliced frame must link to its preceding anchor hash
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 2,
        toEventSeq: 2,
        anchorHash: "h1",
        headEventSeq: 2,
        events: [chainedEvent(2)],
        chainValid: true,
      }).success
    ).toBe(true);
    expect(
      ReplayFrameSchema.safeParse({
        tableId: "t1",
        fromEventSeq: 2,
        toEventSeq: 2,
        anchorHash: "wrong",
        headEventSeq: 2,
        events: [chainedEvent(2)],
        chainValid: false,
      }).success
    ).toBe(false);
  });
});

describe("canonical finance contracts", () => {
  test("validates asset identity and metadata", () => {
    expect(AssetSchema.safeParse(validAsset).success).toBe(true);
    expect(AssetIdSchema.safeParse(ASSET_A).success).toBe(true);
    expect(AssetIdSchema.safeParse(ASSET_A.toUpperCase()).success).toBe(false);
    expect(AssetSchema.safeParse({ ...validAsset, chainId: 2 }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...validAsset, tokenAddress: ADDRESS_B }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...validAsset, confirmations: 65 }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...validAsset, status: "PAUSED" }).success).toBe(false);
  });

  test("validates balances", () => {
    expect(
      BalanceSchema.safeParse({
        principalId: "p1",
        assetId: ASSET_A,
        availableAtomic: "0",
        inPlayAtomic: "1000000",
        pendingWithdrawalAtomic: "0",
      }).success
    ).toBe(true);
    expect(
      BalanceSchema.safeParse({
        principalId: "p1",
        assetId: ASSET_A,
        availableAtomic: "1.0",
        inPlayAtomic: "0",
        pendingWithdrawalAtomic: "0",
      }).success
    ).toBe(false);
  });

  test("deposit claim request is identity-only; response carries status/provenance", () => {
    expect(
      DepositClaimRequestSchema.safeParse({ assetId: ASSET_A, txHash: TX_HASH, logIndex: 3 })
        .success
    ).toBe(true);
    // request must not allow server-resolved fields
    expect(
      DepositClaimRequestSchema.safeParse({
        assetId: ASSET_A,
        txHash: TX_HASH,
        logIndex: 3,
        principalId: "p1",
        amountAtomic: "1",
        status: "CREDITED",
      }).success
    ).toBe(false);

    const claim = {
      id: "dep-1",
      assetId: ASSET_A,
      txHash: TX_HASH,
      logIndex: 3,
      principalId: "p1",
      amountAtomic: "5000000",
      status: "CREDITED" as const,
      provenance: "DIRECT_TREASURY" as const,
      blockNumber: 123,
      blockHash: BLOCK_HASH,
    };
    expect(DepositClaimSchema.safeParse(claim).success).toBe(true);
    expect(DepositClaimSchema.safeParse({ ...claim, txHash: "0x1234" }).success).toBe(false);
    expect(DepositClaimSchema.safeParse({ ...claim, status: "DONE" }).success).toBe(false);
    expect(DepositClaimSchema.safeParse({ ...claim, provenance: "UNKNOWN" }).success).toBe(false);
  });

  test("withdrawal lifecycle includes reserved, gas-blocked and ambiguous states", () => {
    for (const status of ["RESERVED", "BLOCKED_GAS", "AMBIGUOUS", "REORGED", "FAILED"]) {
      expect(WithdrawalStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(WithdrawalStatusSchema.safeParse("REPLACED").success).toBe(false);
  });

  test("validates EIP-712 withdrawal intents and enforces fixed domain", () => {
    const intent = {
      intentId: "w1",
      principalId: "p1",
      assetId: ASSET_A,
      destination: ADDRESS_B,
      amountAtomic: "1000000",
      nonce: 7,
      deadline: 1900000000,
      chainId: 1,
    };
    expect(WithdrawalIntentSchema.safeParse(intent).success).toBe(true);
    expect(WithdrawalIntentSchema.safeParse({ ...intent, chainId: 5 }).success).toBe(false);
    expect(WithdrawalIntentSchema.safeParse({ ...intent, amountAtomic: "0" }).success).toBe(false);

    const domain = createWithdrawalDomain(1, ADDRESS_A);
    expect(domain.name).toBe(WITHDRAWAL_DOMAIN_NAME);
    expect(domain.version).toBe(WITHDRAWAL_DOMAIN_VERSION);

    const typed = withdrawalIntentTypedData(intent, domain);
    expect(typed.primaryType).toBe(WITHDRAWAL_INTENT_PRIMARY_TYPE);
    expect(typed.message).toEqual(intent);
    const fields = typed.types[WITHDRAWAL_INTENT_PRIMARY_TYPE].map((field) => field.name);
    for (const key of Object.keys(intent)) expect(fields).toContain(key);

    // arbitrary client domain is rejected
    expect(() =>
      withdrawalIntentTypedData(intent, { ...domain, name: "Evil", version: "2" } as never)
    ).toThrow();
    // mismatched chain is rejected
    expect(() => withdrawalIntentTypedData(intent, { ...domain, chainId: 5 } as never)).toThrow();
    expect(() => createWithdrawalDomain(1, "0xabc" as never)).toThrow();
  });

  test("withdrawal submission rejects client-supplied typed data", () => {
    const intent = {
      intentId: "w1",
      principalId: "p1",
      assetId: ASSET_A,
      destination: ADDRESS_B,
      amountAtomic: "1000000",
      nonce: 7,
      deadline: 1900000000,
      chainId: 1,
    };
    expect(
      WithdrawalSubmissionSchema.safeParse({ intent, signature: `0x${"a".repeat(130)}` }).success
    ).toBe(true);
    expect(
      WithdrawalSubmissionSchema.safeParse({
        intent,
        signature: `0x${"a".repeat(130)}`,
        typedData: {},
      }).success
    ).toBe(false);
    expect(
      WithdrawalRecordSchema.safeParse({
        intentId: "w1",
        principalId: "p1",
        assetId: ASSET_A,
        destination: ADDRESS_B,
        amountAtomic: "1000000",
        deadline: 1900000000,
        chainId: 1,
        nonce: 7,
        status: "BLOCKED_GAS",
        txHash: null,
      }).success
    ).toBe(true);
  });
});

describe("canonical operations contracts", () => {
  test("requires the mandatory incident kinds", () => {
    for (const kind of [
      "DEPOSIT_REORG",
      "WITHDRAWAL_REORG",
      "RPC_DISAGREEMENT",
      "TREASURY_SHORTFALL",
      "GAS_STARVATION",
      "AMBIGUOUS_CUSTODY_STATE",
    ]) {
      expect(IncidentKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(IncidentKindSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  test("validates incidents and operator resolution metadata", () => {
    const open = {
      id: "i1",
      kind: "WITHDRAWAL_REORG" as const,
      severity: "CRITICAL" as const,
      status: "OPEN" as const,
      assetId: ASSET_A,
      chainId: 1,
      affectedId: "w1",
      evidence: { txHash: TX_HASH },
      createdAt: 1700000000000,
      resolvedAt: null,
      operatorId: null,
      operatorEvidence: null,
    };
    expect(FinancialIncidentSchema.safeParse(open).success).toBe(true);
    // no legacy aliases
    expect(
      FinancialIncidentSchema.safeParse({
        ...open,
        incidentId: "i1",
        detail: {},
        openedAt: 1,
      }).success
    ).toBe(false);
    expect(FinancialIncidentSchema.safeParse({ ...open, kind: "UNKNOWN" }).success).toBe(false);
    // resolution requires operator audit fields
    expect(FinancialIncidentSchema.safeParse({ ...open, status: "RESOLVED" }).success).toBe(false);
    expect(
      FinancialIncidentSchema.safeParse({
        ...open,
        status: "RESOLVED",
        resolvedAt: 1700000001000,
        operatorId: "op1",
        operatorEvidence: { note: "rechecked" },
      }).success
    ).toBe(true);
    // open incidents cannot carry resolution fields
    expect(FinancialIncidentSchema.safeParse({ ...open, resolvedAt: 1700000001000 }).success).toBe(
      false
    );
  });

  test("enforces fail-closed readiness", () => {
    expect(
      FinancialReadinessSchema.safeParse({ state: "READY", reasons: [], checks: [] }).success
    ).toBe(true);
    expect(
      FinancialReadinessSchema.safeParse({
        state: "READY",
        reasons: ["ASSET_LEDGER_UNVERIFIED"],
        checks: [],
      }).success
    ).toBe(false);
    expect(
      FinancialReadinessSchema.safeParse({ state: "BLOCKED", reasons: [], checks: [] }).success
    ).toBe(false);
  });
});

describe("canonical tournament wire contracts", () => {
  test("validates tournament seat assignments and payouts", () => {
    expect(
      TournamentSeatAssignmentSchema.safeParse({
        tournamentId: "tour-1",
        tableId: "t1",
        seat: 3,
        principalId: "p1",
      }).success
    ).toBe(true);
    expect(
      TournamentSeatAssignmentSchema.safeParse({
        tournamentId: "tour-1",
        tableId: "t1",
        seat: 10,
        principalId: "p1",
      }).success
    ).toBe(false);
    expect(
      TournamentPayoutSettlementSchema.safeParse({
        tournamentId: "tour-1",
        principalId: "p1",
        placement: 1,
        assetId: ASSET_A,
        amountAtomic: "50000000",
        status: "CREDITED",
      }).success
    ).toBe(true);
  });

  test("validates durable ordered tournament audit events", () => {
    const event = {
      eventId: "te1",
      tournamentId: "tour-1",
      eventSeq: 1,
      type: "TOURNAMENT_SETTLED" as const,
      occurredAt: 1700000000000,
      payload: { winnerUserId: "p1", payouts: [{ userId: "p1", placement: 1, amount: 100 }] },
      stateFingerprint: "settled:tour-1",
      requestRef: "op1",
      previousHash: null,
      hash: "a".repeat(64),
    };
    expect(TournamentEventSchema.safeParse(event).success).toBe(true);
    expect(TournamentEventSchema.safeParse({ ...event, type: "UNKNOWN" }).success).toBe(false);
    expect(
      TournamentEventSchema.safeParse({
        ...event,
        stateFingerprint: "",
      }).success
    ).toBe(false);
    // strict: chain provenance and idempotence fingerprint are required
    const { hash: _hash, ...withoutHash } = event;
    expect(TournamentEventSchema.safeParse(withoutHash).success).toBe(false);
  });
});

describe("canonical REST wire schemas", () => {
  test("validates the public error envelope", () => {
    expect(
      ErrorResponseSchema.safeParse({ error: "NOT_YOUR_TURN", message: "not your turn" }).success
    ).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: "MADE_UP", message: "x" }).success).toBe(false);
  });

  test("validates auth DTOs", () => {
    expect(
      LoginRequestSchema.safeParse({ message: "siwe", signature: `0x${"a".repeat(130)}` }).success
    ).toBe(true);
    expect(LoginRequestSchema.safeParse({ message: "siwe", signature: "nope" }).success).toBe(
      false
    );
    expect(NonceResponseSchema.safeParse({ nonce: "abc" }).success).toBe(true);
  });

  test("validates table list and tournament DTOs", () => {
    const config = {
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 9,
    };
    expect(
      TableListItemSchema.safeParse({
        id: "t1",
        name: "Main",
        config,
        status: "ACTIVE",
      }).success
    ).toBe(true);
    expect(
      GetTablesResponseSchema.safeParse({
        tables: [{ id: "t1", name: "Main", config, status: "ACTIVE" }],
      }).success
    ).toBe(true);

    const listItem = {
      id: "tour-1",
      name: "Sunday",
      status: "REGISTRATION",
      tableId: "t1",
      buyIn: 100,
      fee: 10,
      startingStack: 1000,
      maxPlayers: 90,
      tableMaxPlayers: 9,
      balancingTolerance: 2,
      registeredPlayers: 0,
      prizePool: 0,
    };
    expect(TournamentListItemSchema.safeParse(listItem).success).toBe(true);
    expect(
      TournamentDetailsSchema.safeParse({
        ...listItem,
        blindStructure: [{ smallBlind: 1, bigBlind: 2, ante: 0 }],
        payoutPercentages: [100],
        entries: [],
        tables: [],
      }).success
    ).toBe(true);
    expect(
      StartTournamentResponseSchema.safeParse({ success: true, tableIds: [], distribution: [] })
        .success
    ).toBe(true);
    expect(SettleTournamentResponseSchema.safeParse({ success: true }).success).toBe(true);
  });
});
