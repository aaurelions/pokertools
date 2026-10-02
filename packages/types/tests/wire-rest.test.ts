import {
  CreateServiceCredentialRequestSchema,
  CreatedServiceCredentialSchema,
  CredentialIdSchema,
  HandHistoryResponseSchema,
  ListServiceCredentialsResponseSchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  PlayerNoteRequestSchema,
  PlayerNoteSchema,
  RevokeServiceCredentialResponseSchema,
  SavePlayerNoteResponseSchema,
  ServiceCredentialSummarySchema,
  UserProfileSchema,
} from "../src";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const ISO = "2026-01-01T00:00:00.000Z";
const ASSET_ID = "eip155:1/erc20:0x1111111111111111111111111111111111111111";

const chipBalances = {
  available: "1000",
  inPlay: "0",
  tournament: "0",
  totalInPlay: "0",
  pendingWithdrawal: "0",
};

describe("canonical auth wire contracts", () => {
  test("rejects malformed SIWE signatures and over-long messages", () => {
    expect(
      LoginRequestSchema.safeParse({ message: "siwe", signature: `0x${"a".repeat(130)}` }).success
    ).toBe(true);
    expect(LoginRequestSchema.safeParse({ message: "siwe", signature: "0x123" }).success).toBe(
      false
    );
    expect(
      LoginRequestSchema.safeParse({ message: "x".repeat(4097), signature: `0x${"a".repeat(130)}` })
        .success
    ).toBe(false);
  });

  test("rejects extra fields on the login body", () => {
    expect(
      LoginRequestSchema.safeParse({
        message: "siwe",
        signature: `0x${"a".repeat(130)}`,
        user: { id: "spoofed", username: "spoofed" },
      }).success
    ).toBe(false);
  });

  test("validates the logout envelope", () => {
    expect(LogoutResponseSchema.safeParse({ success: true }).success).toBe(true);
    expect(LogoutResponseSchema.safeParse({ success: false }).success).toBe(false);
  });
});

describe("canonical service credential wire contracts", () => {
  test("create request is strict, scoped and requires tableId for a seat restriction", () => {
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot-1",
        scopes: ["table:observe", "table:act"],
      }).success
    ).toBe(true);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot-1",
        scopes: ["table:act"],
        tableId: "table-1",
        seat: 3,
        expiresAt: ISO,
      }).success
    ).toBe(true);
    // seat without tableId fails closed
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot-1",
        scopes: ["table:act"],
        seat: 3,
      }).success
    ).toBe(false);
    // unknown scope rejected
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot-1",
        scopes: ["table:admin"],
      }).success
    ).toBe(false);
    // client cannot mint operator authority fields
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bot-1",
        scopes: ["table:act"],
        isOperator: true,
      }).success
    ).toBe(false);
  });

  test("created credential carries the one-time token; summary never does", () => {
    const created = {
      id: "abcdef0123456789",
      userId: "svc-user",
      name: "bot-1",
      scopes: ["table:observe"],
      tableId: "table-1",
      seat: null,
      expiresAt: null,
      token: "ptsvc_example",
    };
    expect(CreatedServiceCredentialSchema.safeParse(created).success).toBe(true);
    expect(CreatedServiceCredentialSchema.safeParse({ ...created, token: "" }).success).toBe(false);

    const summary = {
      id: created.id,
      userId: created.userId,
      name: created.name,
      scopes: created.scopes,
      tableId: created.tableId,
      seat: created.seat,
      revoked: false,
      expiresAt: ISO,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: ISO,
    };
    expect(ServiceCredentialSummarySchema.safeParse(summary).success).toBe(true);
    // summary must reject a plaintext token leak
    expect(
      ServiceCredentialSummarySchema.safeParse({ ...summary, token: "ptsvc_leak" }).success
    ).toBe(false);
    expect(ListServiceCredentialsResponseSchema.safeParse({ credentials: [summary] }).success).toBe(
      true
    );
    expect(RevokeServiceCredentialResponseSchema.safeParse({ success: true }).success).toBe(true);
  });

  test("credential id matches the minted/revoke format", () => {
    expect(CredentialIdSchema.safeParse("abcdef0123456789").success).toBe(true);
    expect(CredentialIdSchema.safeParse("short").success).toBe(false);
    expect(CredentialIdSchema.safeParse("has-dashes-12345678").success).toBe(false);
  });
});

describe("canonical user/profile wire contracts", () => {
  const profile = {
    id: "user-1",
    username: "alice",
    address: ADDRESS,
    role: "PLAYER",
    createdAt: ISO,
    chipBalances,
    assetBalances: [],
  };

  test("accepts a wallet profile with decimal chip balances and asset balances", () => {
    expect(UserProfileSchema.safeParse(profile).success).toBe(true);
  });

  test("accepts a SERVICE identity whose address is explicitly null", () => {
    expect(UserProfileSchema.safeParse({ ...profile, address: null }).success).toBe(true);
  });

  test("rejects the removed BOT role and cents/default-currency fields", () => {
    expect(UserProfileSchema.safeParse({ ...profile, role: "BOT" }).success).toBe(false);
    expect(
      UserProfileSchema.safeParse({ ...profile, balances: { main: 1, inPlay: 0 } }).success
    ).toBe(false);
    expect(
      UserProfileSchema.safeParse({
        ...profile,
        chipBalances: { ...chipBalances, defaultCurrency: "USD" },
      }).success
    ).toBe(false);
  });

  test("chip balances are canonical decimal strings", () => {
    for (const bad of ["01", "-1", "1.0", 1000]) {
      expect(
        UserProfileSchema.safeParse({
          ...profile,
          chipBalances: { ...chipBalances, available: bad },
        }).success
      ).toBe(false);
    }
  });

  test("asset balances stay atomic and per-asset", () => {
    expect(
      UserProfileSchema.safeParse({
        ...profile,
        assetBalances: [
          {
            principalId: "user-1",
            assetId: ASSET_ID,
            availableAtomic: "0",
            inPlayAtomic: "0",
            pendingWithdrawalAtomic: "0",
          },
        ],
      }).success
    ).toBe(true);
    expect(
      UserProfileSchema.safeParse({
        ...profile,
        assetBalances: [
          {
            principalId: "user-1",
            assetId: ASSET_ID,
            availableAtomic: "1.0",
            inPlayAtomic: "0",
            pendingWithdrawalAtomic: "0",
          },
        ],
      }).success
    ).toBe(false);
  });
});

describe("canonical hand history wire contracts", () => {
  test("validates a history page and rejects chips disguised as atomic amounts", () => {
    const history = [
      { id: "e1", amount: 50, type: "HAND_WIN", referenceId: null, createdAt: ISO },
      { id: "e2", amount: 20, type: "HAND_LOSS", referenceId: "hand-9", createdAt: ISO },
    ];
    expect(HandHistoryResponseSchema.safeParse({ history }).success).toBe(true);
    expect(
      HandHistoryResponseSchema.safeParse({
        history: [{ ...history[0], type: "DONATION" }],
      }).success
    ).toBe(false);
    expect(
      HandHistoryResponseSchema.safeParse({
        history: [{ ...history[0], amountAtomic: "50" }],
      }).success
    ).toBe(false);
  });
});

describe("canonical player note wire contracts", () => {
  const note = {
    id: "n1",
    authorId: "user-1",
    targetId: "user-2",
    content: "tight player",
    label: "TAG",
    createdAt: ISO,
    updatedAt: ISO,
  };

  test("validates note requests strictly", () => {
    expect(PlayerNoteRequestSchema.safeParse({ targetId: "user-2", content: "note" }).success).toBe(
      true
    );
    expect(
      PlayerNoteRequestSchema.safeParse({ targetId: "user-2", content: "note", label: "TAG" })
        .success
    ).toBe(true);
    expect(
      PlayerNoteRequestSchema.safeParse({ targetId: "user-2", authorId: "spoof" }).success
    ).toBe(false);
  });

  test("validates list/upsert note responses", () => {
    expect(PlayerNoteSchema.safeParse(note).success).toBe(true);
    expect(
      PlayerNoteSchema.safeParse({
        ...note,
        target: { id: "user-2", username: "bob" },
      }).success
    ).toBe(true);
    expect(SavePlayerNoteResponseSchema.safeParse({ success: true, note }).success).toBe(true);
    expect(
      SavePlayerNoteResponseSchema.safeParse({ success: true, note: { ...note, targetId: 42 } })
        .success
    ).toBe(false);
  });
});
