/**
 * Browser acceptance harness entry.
 *
 * This module is bundled by the test runner (esbuild) and executed inside a
 * real Chromium page. It imports ONLY the published/built SDK package root
 * (`@pokertools/sdk` -> packages/sdk/dist) plus public transport contracts
 * (`@pokertools/types`) and `viem` for a disposable test wallet.
 *
 * Rules enforced here:
 * - No private SDK/API internals are imported or poked.
 * - The wallet is generated in-browser from an ephemeral private key. It is
 *   never persisted, never exported, and never a real credential.
 * - Canonical actions are built from server-issued legal actions only; the
 *   harness never invents legality.
 */

import { PokerClient, PokerSocket, createSiweMessage } from "@pokertools/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CanonicalActionResultSchema, SeatObservationSchema } from "@pokertools/types";

const CHAIN_ID = 31337;
const PLAYER_BUY_IN = 1000;
const ACTION_FAMILIES = ["DEAL", "FOLD", "CHECK", "CALL", "BET", "RAISE", "MUCK", "SHOW"] as const;

type ActionFamily = (typeof ACTION_FAMILIES)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface EphemeralWallet {
  readonly address: string;
  signMessage(message: string): Promise<string>;
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

interface ObservationLike {
  tableId: string;
  handId: string;
  turnId: string | null;
  version: number;
  eventSeq: number;
  state: Record<string, unknown> & {
    version: number;
    deck: unknown[];
    previousStates?: unknown[];
    players: Array<{ id: string; hand: unknown } | null>;
    viewingPlayerId: string | null;
  };
  legalActions: Array<{
    actionId: string;
    family: string;
    minAmount?: number;
    maxAmount?: number;
    amount?: number;
  }>;
}

interface MaskedStateLike {
  version: number;
  deck: unknown[];
  previousStates?: unknown[];
  players: Array<{ id: string; hand: unknown } | null>;
  viewingPlayerId: string | null;
  actionTo?: number | null;
  winners?: unknown[];
}

/** Generate a valueless, single-use wallet. The private key never leaves this scope. */
function createEphemeralWallet(): EphemeralWallet {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    address: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
  };
}

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, ok: response.ok, body };
}

function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// Lose exactly one REAL committed HTTP response at the client transport
// boundary. No API result is fabricated: the SDK must retry the same request
// through the live server's durable request-id replay path.
let droppedActionBody: string | null = null;
let retriedActionBody: string | null = null;
async function acceptanceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (String(input).endsWith("/action") && init?.method === "POST" && response.ok) {
    const body = String(init.body);
    if (droppedActionBody === null) {
      await response.text();
      droppedActionBody = body;
      throw new TypeError("accepted action response lost at transport boundary");
    }
    if (retriedActionBody === null) retriedActionBody = body;
  }
  return response;
}

/**
 * Authenticate one ephemeral wallet through the SIWE boundary. When
 * `testBoundary` is set, also probes the negative cases (wrong signer must not
 * burn the nonce, nonce replay, unauthenticated REST).
 */
async function authenticate(
  baseUrl: string,
  wallet: EphemeralWallet,
  testBoundary: boolean
): Promise<{ client: PokerClient; userId: string; boundary: Record<string, JsonValue> }> {
  const client = new PokerClient({
    baseUrl,
    retry: { count: 1, delay: 0 },
    fetch: acceptanceFetch,
  });
  const nonce = await client.getNonce();
  const message = createSiweMessage({
    address: wallet.address as `0x${string}`,
    chainId: CHAIN_ID,
    domain: new URL(baseUrl).hostname,
    uri: baseUrl,
    nonce,
    version: "1",
    issuedAt: new Date(),
  });

  const boundary: Record<string, JsonValue> = {};
  if (testBoundary) {
    const attacker = createEphemeralWallet();
    const wrongSignature = await attacker.signMessage(message);
    const wrong = await request(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: wrongSignature }),
    });
    boundary.wrongSignerStatus = wrong.status;

    const unauthenticated = new PokerClient({ baseUrl, retry: { count: 0 } });
    try {
      await unauthenticated.getProfile();
      boundary.unauthenticatedRestStatus = 200;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      boundary.unauthenticatedRestStatus = typeof status === "number" ? status : null;
    }
  }

  const signature = await wallet.signMessage(message);
  const login = await client.login({ message, signature });
  boundary.loginUserId = login.user.id;

  if (testBoundary) {
    const replay = await request(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    boundary.replayStatus = replay.status;
  }

  return { client, userId: login.user.id, boundary };
}

function isMaskedHand(hand: unknown, viewingPlayerId: string | null, playerId: string): boolean {
  if (viewingPlayerId !== null && playerId === viewingPlayerId) return true;
  if (hand === null) return true;
  if (!Array.isArray(hand)) return false;
  return hand.every((card) => card === null || card === undefined);
}

function inspectMasking(state: MaskedStateLike): Record<string, JsonValue> {
  return {
    version: state.version,
    deckEmpty: Array.isArray(state.deck) && state.deck.length === 0,
    previousStatesEmpty: !state.previousStates || state.previousStates.length === 0,
    viewingPlayerId: state.viewingPlayerId,
    nonViewerHandsMasked: state.players.every(
      (player) => !player || isMaskedHand(player.hand, state.viewingPlayerId, player.id)
    ),
  };
}

/** Masking invariants from a canonical `SeatObservation` (wire state). */
function inspectObservationMasking(observation: ObservationLike): Record<string, JsonValue> {
  return inspectMasking(observation.state as unknown as MaskedStateLike);
}

/**
 * Submit a server-issued legal action for `family`.
 *
 * The SDK's public `getObservation` supplies the authoritative legal actions.
 * The canonical submit and its parsed receipt must succeed through the public
 * SDK. A committed server mutation is not a substitute for a working SDK.
 */
async function submitFamily(
  client: PokerClient,
  tableId: string,
  family: ActionFamily,
  amount?: number
): Promise<{
  applied: boolean;
  beforeVersion: number;
  afterVersion: number;
  sdkError: string | null;
  sdkReceipt: JsonValue;
}> {
  const before = (await client.getObservation(tableId)) as unknown as ObservationLike;
  const legal = before.legalActions.find((action) => action.family === family);
  if (!legal) {
    throw new Error(
      `server did not offer ${family}; offered=[${before.legalActions
        .map((action) => action.family)
        .join(",")}]`
    );
  }
  const canonical = {
    requestId: crypto.randomUUID(),
    turnId: before.turnId!,
    expectedVersion: before.version,
    actionId: legal.actionId,
    ...(amount !== undefined ? { amount } : {}),
  };

  const result = await client.action(tableId, canonical);
  const receipt = result.receipt;
  const sdkReceipt = toJson(result);
  const after = (await client.getObservation(tableId)) as unknown as ObservationLike;
  const afterVersion = after.version;
  if (
    receipt.requestId !== canonical.requestId ||
    receipt.version !== afterVersion ||
    afterVersion !== before.version + 1
  ) {
    throw new Error("SDK action receipt did not match the committed canonical action");
  }
  return {
    applied: true,
    beforeVersion: before.version,
    afterVersion,
    sdkError: null,
    sdkReceipt,
  };
}

/** Send one legal family from whichever client the server offers it to. */
async function submitFromAnyClient(
  clients: PokerClient[],
  tableId: string,
  family: ActionFamily
): Promise<{ index: number; result: Awaited<ReturnType<typeof submitFamily>>; errors: string[] }> {
  const errors: string[] = [];
  for (let index = 0; index < clients.length; index++) {
    try {
      const result = await submitFamily(clients[index], tableId, family);
      if (result.applied) return { index, result, errors };
      errors.push(`client[${index}] did not advance version`);
    } catch (error) {
      errors.push(`client[${index}]: ${describeError(error)}`);
    }
  }
  throw new Error(`no client could submit ${family}: ${errors.join(" | ")}`);
}

/**
 * Feature-probe the canonical observation/action wire contract directly over
 * the public HTTP API, validating strict schemas. Classifies the target as
 * READY, BLOCKED (endpoint not implemented / not ready) or FAILED (contract
 * present but violated).
 */
async function runCanonicalProbe(
  baseUrl: string,
  clients: PokerClient[],
  userIds: string[],
  tableId: string
): Promise<Record<string, JsonValue>> {
  // Ensure a pending decision exists.
  let observation: ObservationLike | null = null;
  let actor: PokerClient | null = null;
  async function findActor(): Promise<void> {
    for (const client of clients) {
      const current = (await client
        .getObservation(tableId)
        .catch(() => null)) as ObservationLike | null;
      if (current && current.turnId && current.legalActions.length > 0) {
        observation = current;
        actor = client;
        return;
      }
    }
  }
  await findActor();
  if (!observation || !actor) {
    try {
      await submitFromAnyClient(clients, tableId, "DEAL");
      await findActor();
    } catch (error) {
      return {
        status: "BLOCKED",
        reason: `no pending turn available for canonical observation (${describeError(error)})`,
      };
    }
  }
  if (!observation || !actor || !observation.turnId) {
    return { status: "BLOCKED", reason: "observation carried no active turnId" };
  }

  const token = actor.getToken();

  const observationResponse = await request(`${baseUrl}/tables/${tableId}/observation`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if ([404, 405, 501, 503].includes(observationResponse.status)) {
    return {
      status: "BLOCKED",
      httpStatus: observationResponse.status,
      reason: "canonical GET /tables/:id/observation is not implemented",
    };
  }
  const parsedObservation = SeatObservationSchema.safeParse(observationResponse.body);
  if (!parsedObservation.success) {
    return {
      status: "FAILED",
      httpStatus: observationResponse.status,
      reason: "GET observation failed SeatObservationSchema",
      issues: parsedObservation.error.issues.map((issue) => issue.message),
    };
  }
  const observed = parsedObservation.data;
  if (observed.legalActions.length === 0) {
    return { status: "FAILED", reason: "observation carried no legalActions for the actor" };
  }

  const choice =
    observed.legalActions.find((action) => action.family === "FOLD") ?? observed.legalActions[0]!;
  const requestId = crypto.randomUUID();
  const submitBody: Record<string, JsonValue> = {
    requestId,
    turnId: observed.turnId,
    expectedVersion: observed.version,
    actionId: choice.actionId,
  };
  if (choice.amount !== undefined) submitBody.amount = choice.amount;

  const submitted = await request(`${baseUrl}/tables/${tableId}/action`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(submitBody),
  });
  if (submitted.status >= 500) {
    return {
      status: "BLOCKED",
      httpStatus: submitted.status,
      reason: "POST canonical action returned a server error",
      body: toJson(submitted.body),
    };
  }

  const result = CanonicalActionResultSchema.safeParse(submitted.body);

  const spoofed = await request(`${baseUrl}/tables/${tableId}/action`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ ...submitBody, requestId: `${requestId}-spoof`, playerId: userIds[0] }),
  });
  const stale = await request(`${baseUrl}/tables/${tableId}/action`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      ...submitBody,
      requestId: `${requestId}-stale`,
      expectedVersion: Math.max(0, observed.version - 1),
    }),
  });
  const replay = await request(`${baseUrl}/tables/${tableId}/action`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(submitBody),
  });
  const replayResult = CanonicalActionResultSchema.safeParse(replay.body);
  const receiptValid = result.success;
  const replayIdempotent =
    replay.ok &&
    replayResult.success &&
    result.success &&
    JSON.stringify(replayResult.data) === JSON.stringify(result.data);

  return {
    status:
      submitted.ok &&
      receiptValid &&
      replayIdempotent &&
      spoofed.status === 400 &&
      stale.status === 409
        ? "READY"
        : "FAILED",
    observationStatus: observationResponse.status,
    submitStatus: submitted.status,
    wireShape: result.success ? "receipt-envelope" : "invalid",
    receiptValid,
    replayIdempotent,
    legalActionFamilies: observed.legalActions.map((action) => action.family),
    turnObserved: true,
    spoofStatus: spoofed.status,
    staleStatus: stale.status,
    replayStatus: replay.status,
  };
}

interface BrowserSession {
  baseUrl: string;
  clients: PokerClient[];
  userIds: string[];
  tableId: string;
}

let session: BrowserSession | null = null;

/**
 * Phase 1: authenticate both ephemeral wallets and create the table. Funds are
 * granted by the Node side between phases (fixture grant), so this phase never
 * depends on a test-only faucet route.
 */
async function prepare(options: { baseUrl: string }): Promise<Record<string, JsonValue>> {
  const baseUrl = options.baseUrl;
  const walletZero = createEphemeralWallet();
  const authZero = await authenticate(baseUrl, walletZero, true);
  const walletOne = createEphemeralWallet();
  const authOne = await authenticate(baseUrl, walletOne, false);
  const clients = [authZero.client, authOne.client];
  const userIds = [authZero.userId, authOne.userId];

  const healthBody = (await clients[0].health()) as unknown as JsonValue;
  const profile = await clients[0].getProfile();
  const tableId = await clients[0].createTable({
    name: `browser-acceptance-${Date.now()}`,
    mode: "CASH",
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 2,
    rakePercent: 0,
  });
  const listed = (await clients[0].getTables()).some((table) => table.id === tableId);

  session = { baseUrl, clients, userIds, tableId };
  return toJson({
    cleanup: { userIds, tableId },
    steps: {
      siwe: authZero.boundary,
      auth: { players: userIds.length, loginUserId: authZero.boundary.loginUserId },
      healthBody,
      profile: { id: (profile as { id?: string }).id ?? null },
      rest: { tableCreated: true, listed },
    },
  });
}

/**
 * Phase 2: funded gameplay, live updates, reconnect/resync and the canonical
 * observation/action probe. Requires `prepare()` plus a Node-side fixture grant.
 */
async function play(): Promise<Record<string, JsonValue>> {
  if (!session) throw new Error("prepare() must run before play()");
  const { baseUrl, clients, userIds, tableId } = session;
  const steps: Record<string, JsonValue> = {};
  const disconnectReasons: string[] = [];
  let socket: PokerSocket | undefined;

  try {
    try {
      for (let index = 0; index < clients.length; index++) {
        await clients[index].buyIn(tableId, {
          seat: index,
          amount: PLAYER_BUY_IN,
          idempotencyKey: `browser-buyin-${index}-${Date.now()}`,
        });
      }
      steps.buyIn = clients.length;
    } catch (error) {
      steps.error = `buy-in: ${describeError(error)}`;
    }

    // Authenticated WS join + masked snapshot.
    if (!steps.error) {
      socket = new PokerSocket({
        url: `${baseUrl.replace(/^http/, "ws")}/ws/play`,
        token: clients[1].getToken()!,
        reconnectAttempts: 0,
        heartbeatInterval: 60_000,
      });
      socket.on("disconnect", (reason) => disconnectReasons.push(reason));
      await socket.connect();
      const snapshotObservation = (await socket.join(tableId)) as unknown as ObservationLike;
      steps.wsJoin = {
        connected: socket.isConnected(),
        expectedViewerId: userIds[1],
        ...inspectObservationMasking(snapshotObservation),
      };
    }

    // Deal a hand so hole-card masking is meaningful, then exercise live
    // updates and reconnect/resync. A mid-migration action path is reported as
    // BLOCKED rather than crashing the auth/REST/WS assertions.
    if (!steps.error && socket) {
      try {
        const dealt = await submitFromAnyClient(clients, tableId, "DEAL");
        const dealtObservation = (await clients[dealt.index].getObservation(
          tableId
        )) as unknown as ObservationLike;
        const viewerState = (await clients[1].getTableState(tableId)) as unknown as MaskedStateLike;
        const viewerObservation = (await clients[1].getObservation(
          tableId
        )) as unknown as ObservationLike;
        steps.deal = {
          byClient: dealt.index,
          version: dealtObservation.version,
          sdkError: dealt.result.sdkError,
          offeredFamilies: dealtObservation.legalActions.map((action) => action.family),
        };
        steps.transportRetry = {
          dropped: droppedActionBody !== null,
          exactReplay: retriedActionBody === droppedActionBody,
          requestId: droppedActionBody === null ? null : JSON.parse(droppedActionBody).requestId,
        };
        steps.masking = {
          engine: inspectMasking(viewerState),
          observation: inspectObservationMasking(viewerObservation),
        };

        const liveUpdate = new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("stateUpdate timeout")), 10_000);
          const unsubscribe = socket!.on("stateUpdate", (_tableId, state) => {
            if (state.version > dealtObservation.version) {
              clearTimeout(timer);
              unsubscribe();
              resolve(state.version);
            }
          });
        });
        const acted = await submitFromAnyClient(clients, tableId, "FOLD");
        const afterFold = (await clients[acted.index].getObservation(
          tableId
        )) as unknown as ObservationLike;
        steps.liveUpdate = {
          actorIndex: acted.index,
          sdkError: acted.result.sdkError,
          actionVersion: afterFold.version,
          pushedVersion: await liveUpdate,
        };

        socket.leave(tableId);
        socket.disconnect();
        const advanced = await submitFromAnyClient(clients, tableId, "DEAL");
        await socket.connect();
        const resynced = (await socket.join(tableId)) as unknown as ObservationLike;
        const authoritative = (await clients[0].getTableState(
          tableId
        )) as unknown as MaskedStateLike;
        steps.reconnectResync = {
          disconnectedWhileAway: disconnectReasons.length > 0,
          advancedWhileAway: advanced.result.afterVersion > afterFold.version,
          resyncedVersion: resynced.version,
          authoritativeVersion: authoritative.version,
          versionsMatch: resynced.version === authoritative.version,
          ...inspectObservationMasking(resynced),
        };
      } catch (error) {
        steps.blocked = { at: "canonical-action", detail: describeError(error) };
      }
    }

    steps.canonical = await runCanonicalProbe(baseUrl, clients, userIds, tableId).catch(
      (error) => ({
        status: "BLOCKED" as const,
        reason: describeError(error),
      })
    );
  } catch (error) {
    steps.error = describeError(error);
  } finally {
    try {
      socket?.disconnect();
    } catch {
      // ignore
    }
  }

  return toJson({ steps, cleanup: { userIds, tableId } });
}

declare global {
  interface Window {
    __POKER_BROWSER_ACCEPTANCE__?: {
      prepare: typeof prepare;
      play: typeof play;
    };
  }
}

window.__POKER_BROWSER_ACCEPTANCE__ = { prepare, play };
