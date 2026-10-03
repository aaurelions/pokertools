/**
 * Canonical idempotency regression on real PostgreSQL + Redis.
 *
 * An action accepted while a competition is RUNNING must replay its durable
 * receipt even after the competition settles and its tables close. The
 * lifecycle gate must run only for NEW mutations, after the authorized
 * principal + strict payload hash lookup; authorization/revocation boundaries
 * still precede replay, and opposite-principal or wrong-payload submissions
 * are conflicts.
 *
 * The test captures a real accepted final action over HTTP (response "lost"),
 * settles the competition, then replays the identical request over raw HTTP
 * and through the SDK. No sleeps.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  apiRequest,
  bootApp,
  loginWallet,
  promoteToOperator,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";

interface CompetitionWire {
  id: string;
  tableId: string;
}

interface AcceptedAction {
  body: {
    requestId: string;
    turnId: string;
    expectedVersion: number;
    actionId: string;
    amount?: number;
  };
  receipt: { requestId: string; actionId: string; version: number; eventSeq: number };
  observation: { version: number; eventSeq: number };
}

async function createOrchestrator(
  baseUrl: string,
  operatorToken: string
): Promise<{ principalId: string; token: string }> {
  const response = await apiRequest<{ userId: string; token: string }>(
    baseUrl,
    "POST",
    "/auth/service-credentials",
    {
      token: operatorToken,
      body: {
        name: `replay-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return { principalId: response.body.userId, token: response.body.token };
}

describe("competition canonical action replay (PostgreSQL + Redis)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  let payer: WalletPrincipal;
  let spectator: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    booted = await bootApp();
    [payer, spectator] = await Promise.all([
      loginWallet(booted.baseUrl),
      loginWallet(booted.baseUrl),
    ]);
    operator = await loginWallet(booted.baseUrl);
    await promoteToOperator(booted.app, operator.id);
  });

  afterAll(async () => {
    await booted.app.prisma.competition.deleteMany({ where: { id: { in: competitionIds } } });
    if (tableIds.length > 0) {
      await booted.app.prisma.table.deleteMany({ where: { id: { in: tableIds } } });
    }
    await booted.app.prisma.servicePrincipalDelegation.deleteMany({
      where: {
        OR: [
          { servicePrincipalId: { in: servicePrincipalIds } },
          { delegatePrincipalId: { in: servicePrincipalIds } },
        ],
      },
    });
    await booted.app.prisma.serviceCredential.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.session.deleteMany({ where: { userId: { in: servicePrincipalIds } } });
    await booted.app.prisma.competitionEntrant.deleteMany({
      where: { principalId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.tournamentEntry.deleteMany({
      where: { userId: { in: servicePrincipalIds } },
    });
    await booted.app.prisma.user.deleteMany({ where: { id: { in: servicePrincipalIds } } });
    await booted.close();
  });

  it("replays an accepted final action after settlement and rejects new mutations", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);

    const created = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "POST",
      "/competitions",
      {
        token: orchestrator.token,
        body: {
          name: "Replay after settle",
          mode: "NONFINANCIAL",
          entrants: [
            { principalId: payer.id, kind: "WALLET" },
            { principalId: spectator.id, kind: "WALLET" },
          ],
          smallBlind: 100,
          bigBlind: 200,
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const competition = created.body.competition;
    competitionIds.push(competition.id);
    tableIds.push(competition.tableId);

    const started = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/start`,
      {
        token: orchestrator.token,
        body: {},
      }
    );
    expect(started.status).toBe(200);

    // Play heads-up over raw HTTP, tracking the last accepted canonical action.
    let lastAccepted: AcceptedAction | null = null;
    const submit = async (
      principal: WalletPrincipal,
      families: readonly string[]
    ): Promise<boolean> => {
      const observationResponse = await apiRequest<{
        turnId: string | null;
        version: number;
        eventSeq: number;
        legalActions: Array<{
          family: string;
          actionId: string;
          amount?: number;
          minAmount?: number;
          maxAmount?: number;
        }>;
      }>(booted.baseUrl, "GET", `/tables/${competition.tableId}/observation`, {
        token: principal.token,
      });
      if (observationResponse.status !== 200) return false;
      const observation = observationResponse.body;
      if (!observation.turnId || observation.legalActions.length === 0) return false;
      const legal = observation.legalActions.find((action) => families.includes(action.family));
      if (!legal) return false;
      const takesAmount = legal.family === "BET" || legal.family === "RAISE";
      const amount = legal.amount ?? legal.minAmount ?? legal.maxAmount;
      const body: AcceptedAction["body"] = {
        requestId: crypto.randomUUID(),
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: legal.actionId,
        ...(takesAmount && amount !== undefined ? { amount } : {}),
      };
      const response = await apiRequest<{
        receipt: AcceptedAction["receipt"];
        observation: AcceptedAction["observation"];
      }>(booted.baseUrl, "POST", `/tables/${competition.tableId}/action`, {
        token: principal.token,
        body,
      });
      if (response.status !== 200) {
        throw new Error(`action rejected: ${response.status} ${JSON.stringify(response.body)}`);
      }
      lastAccepted = {
        body,
        receipt: response.body.receipt,
        observation: response.body.observation,
      };
      return true;
    };

    for (let hand = 0; hand < 80; hand++) {
      if (!(await submit(payer, ["DEAL"]))) await submit(spectator, ["DEAL"]);
      for (let step = 0; step < 40; step++) {
        const stateResponse = await apiRequest<{
          state: { winners?: unknown[]; players: Array<{ stack: number } | null> };
        }>(booted.baseUrl, "GET", `/tables/${competition.tableId}`, { token: payer.token });
        if (stateResponse.body.state.winners?.length) break;
        const acted =
          (await submit(spectator, ["FOLD", "CHECK", "CALL"])) ||
          (await submit(payer, ["BET", "RAISE", "CALL", "CHECK"]));
        if (!acted) break;
      }
      const stateResponse = await apiRequest<{
        state: { players: Array<{ stack: number } | null> };
      }>(booted.baseUrl, "GET", `/tables/${competition.tableId}`, { token: payer.token });
      const live = stateResponse.body.state.players.filter(
        (player) => player && player.stack > 0
      ).length;
      if (live <= 1) break;
    }
    expect(lastAccepted, "no canonical action was accepted").not.toBeNull();
    const accepted: AcceptedAction = lastAccepted!;

    // Finalize the competition through the authoritative lifecycle.
    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: orchestrator.token }
    );
    expect(reconciled.status).toBe(200);
    const settled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: {} }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);

    const before = await booted.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { status: true, stateVersion: true, eventSeq: true },
    });
    expect(before.status).toBe("CLOSED");
    const eventsBefore = await booted.app.prisma.gameEvent.count({
      where: { tableId: competition.tableId },
    });

    // Lost-response replay over raw HTTP: identical durable receipt, no new
    // mutation, no version/event movement.
    const replay = await apiRequest<{
      receipt: AcceptedAction["receipt"];
      observation: AcceptedAction["observation"];
    }>(booted.baseUrl, "POST", `/tables/${competition.tableId}/action`, {
      token: payer.token,
      body: accepted.body,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.receipt.requestId).toBe(accepted.body.requestId);
    expect(replay.body.receipt.actionId).toBe(accepted.body.actionId);
    expect(replay.body.receipt.version).toBe(accepted.receipt.version);
    expect(replay.body.receipt.eventSeq).toBe(accepted.receipt.eventSeq);
    expect(replay.body.observation.version).toBe(accepted.observation.version);

    const afterReplay = await booted.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { stateVersion: true, eventSeq: true },
    });
    expect(afterReplay.stateVersion).toBe(before.stateVersion);
    expect(afterReplay.eventSeq).toBe(before.eventSeq);
    expect(
      await booted.app.prisma.gameEvent.count({ where: { tableId: competition.tableId } })
    ).toBe(eventsBefore);

    // The SDK transport (the external consumer recovery path) must resolve the same
    // durable receipt rather than surfacing the lifecycle error.
    const { PokerClient } = await import("@pokertools/sdk");
    const sdk = new PokerClient({ baseUrl: booted.baseUrl, token: payer.token });
    const sdkResult = await sdk.action(competition.tableId, accepted.body);
    expect(sdkResult.receipt.requestId).toBe(accepted.body.requestId);
    expect(sdkResult.receipt.version).toBe(accepted.receipt.version);
    expect(sdkResult.receipt.eventSeq).toBe(accepted.receipt.eventSeq);

    // Wrong payload under the same requestId is a conflict, never a replay.
    const wrongPayload = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      {
        token: payer.token,
        body: { ...accepted.body, actionId: "different-action" },
      }
    );
    expect(wrongPayload.status).toBe(409);
    expect(wrongPayload.body.code ?? wrongPayload.body.error).toBe("REQUEST_ID_CONFLICT");

    // Opposite principal cannot claim another actor's requestId.
    const wrongActor = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      { token: spectator.token, body: accepted.body }
    );
    expect(wrongActor.status).toBe(409);
    expect(wrongActor.body.code ?? wrongActor.body.error).toBe("REQUEST_ID_CONFLICT");

    // A brand-new mutation after settlement remains blocked.
    const newMutation = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      {
        token: payer.token,
        body: {
          requestId: crypto.randomUUID(),
          turnId: accepted.body.turnId,
          expectedVersion: accepted.body.expectedVersion,
          actionId: accepted.body.actionId,
        },
      }
    );
    expect(newMutation.status).toBe(409);
    const newCode = newMutation.body.code ?? newMutation.body.error;
    expect(["COMPETITION_NOT_ACTIONABLE", "TABLE_CLOSED"]).toContain(newCode);
    expect(
      await booted.app.prisma.gameEvent.count({ where: { tableId: competition.tableId } })
    ).toBe(eventsBefore);
  });
});
