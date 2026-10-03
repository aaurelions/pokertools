/**
 * SERVICE agent credential regression on real PostgreSQL + Redis.
 *
 * Two invariants:
 * 1. Issuing an agent credential without `seat` yields a table-only
 *    restriction (no seat); an explicit seat must match the entrant's
 *    authoritative seat.
 * 2. An accepted canonical action from an explicitly seat-restricted agent
 *    credential must still replay its durable receipt after the agent is
 *    eliminated, without weakening NEW actions: authorization/revocation and
 *    table scope come first, and the historical seat is derived only from the
 *    exact durable COMPLETED request (principal + payload hash) in the
 *    platform database.
 *
 * Raw HTTP and SDK replay are both asserted; no sleeps.
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
  entrants: Array<{ principalId: string; seat: number }>;
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
        name: `seat-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
        scopes: ["competition:orchestrate"],
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`orchestrator credential failed: ${JSON.stringify(response.body)}`);
  }
  return { principalId: response.body.userId, token: response.body.token };
}

async function provisionServicePrincipal(
  baseUrl: string,
  operatorToken: string,
  name: string,
  delegatedToPrincipalId: string
): Promise<string> {
  const response = await apiRequest<{ principalId: string }>(
    baseUrl,
    "POST",
    "/auth/service-principals",
    { token: operatorToken, body: { name, delegatedToPrincipalId } }
  );
  if (response.status !== 201) {
    throw new Error(`service principal failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.principalId;
}

async function issueCredential(
  baseUrl: string,
  token: string,
  competitionId: string,
  principalId: string,
  seat?: number
): Promise<{ token: string; credentialId: string; seat: number | null }> {
  const response = await apiRequest<{ token: string; credentialId: string; seat: number | null }>(
    baseUrl,
    "POST",
    `/competitions/${competitionId}/agent-credentials`,
    {
      token,
      body: {
        principalId,
        name: `seat-agent-${crypto.randomBytes(3).toString("hex")}`,
        ...(seat !== undefined ? { seat } : {}),
      },
    }
  );
  if (response.status !== 201) {
    throw new Error(`agent credential failed: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

describe("competition SERVICE agent credential replay (PostgreSQL + Redis)", () => {
  let booted: AcceptanceApp;
  let operator: WalletPrincipal;
  let payer: WalletPrincipal;
  const competitionIds: string[] = [];
  const tableIds: string[] = [];
  const servicePrincipalIds: string[] = [];

  beforeAll(async () => {
    booted = await bootApp();
    payer = await loginWallet(booted.baseUrl);
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

  it("replays an eliminated seat-restricted agent's accepted action and keeps new actions blocked", async () => {
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `seat-agent-${crypto.randomBytes(3).toString("hex")}`,
      orchestrator.principalId
    );
    servicePrincipalIds.push(agent);

    const created = await apiRequest<{ competition: CompetitionWire }>(
      booted.baseUrl,
      "POST",
      "/competitions",
      {
        token: orchestrator.token,
        body: {
          name: "Agent seat replay",
          mode: "NONFINANCIAL",
          entrants: [
            { principalId: payer.id, kind: "WALLET" },
            { principalId: agent, kind: "SERVICE" },
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
    const agentSeat = competition.entrants.find((e) => e.principalId === agent)!.seat;

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

    const seatedCredential = await issueCredential(
      booted.baseUrl,
      orchestrator.token,
      competition.id,
      agent,
      agentSeat
    );
    expect(seatedCredential.seat).toBe(agentSeat);
    const tableOnlyCredential = await issueCredential(
      booted.baseUrl,
      orchestrator.token,
      competition.id,
      agent
    );
    expect(tableOnlyCredential.seat).toBeNull();

    // Play: the seat-restricted agent folds and busts; capture its last accepted
    // canonical action.
    let agentAccepted: AcceptedAction | null = null;
    const submit = async (
      token: string,
      families: readonly string[]
    ): Promise<{ body: AcceptedAction["body"]; receipt: AcceptedAction["receipt"] } | null> => {
      const observationResponse = await apiRequest<{
        turnId: string | null;
        version: number;
        legalActions: Array<{
          family: string;
          actionId: string;
          amount?: number;
          minAmount?: number;
          maxAmount?: number;
        }>;
      }>(booted.baseUrl, "GET", `/tables/${competition.tableId}/observation`, { token });
      if (observationResponse.status !== 200) return null;
      const observation = observationResponse.body;
      if (!observation.turnId || observation.legalActions.length === 0) return null;
      const legal = observation.legalActions.find((action) => families.includes(action.family));
      if (!legal) return null;
      const takesAmount = legal.family === "BET" || legal.family === "RAISE";
      const amount = legal.amount ?? legal.minAmount ?? legal.maxAmount;
      const body: AcceptedAction["body"] = {
        requestId: crypto.randomUUID(),
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: legal.actionId,
        ...(takesAmount && amount !== undefined ? { amount } : {}),
      };
      const response = await apiRequest<{ receipt: AcceptedAction["receipt"] }>(
        booted.baseUrl,
        "POST",
        `/tables/${competition.tableId}/action`,
        { token, body }
      );
      if (response.status !== 200) {
        throw new Error(`action rejected: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return { body, receipt: response.body.receipt };
    };

    for (let hand = 0; hand < 80; hand++) {
      await submit(payer.token, ["DEAL"]);
      await submit(seatedCredential.token, ["DEAL"]);
      for (let step = 0; step < 40; step++) {
        const stateResponse = await apiRequest<{
          state: { winners?: unknown[]; players: Array<{ stack: number } | null> };
        }>(booted.baseUrl, "GET", `/tables/${competition.tableId}`, { token: payer.token });
        if (stateResponse.body.state.winners?.length) break;
        const agentAction = await submit(seatedCredential.token, ["FOLD", "CHECK", "CALL"]);
        if (agentAction) agentAccepted = agentAction;
        const payerAction = await submit(payer.token, ["BET", "RAISE", "CALL", "CHECK"]);
        if (!agentAction && !payerAction) break;
      }
      const stateResponse = await apiRequest<{
        state: { players: Array<{ stack: number } | null> };
      }>(booted.baseUrl, "GET", `/tables/${competition.tableId}`, { token: payer.token });
      const live = stateResponse.body.state.players.filter(
        (player) => player && player.stack > 0
      ).length;
      if (live <= 1) break;
    }
    expect(agentAccepted, "no agent action was accepted").not.toBeNull();
    const accepted: AcceptedAction = agentAccepted!;

    // Eliminate the agent and clear its engine seat through the director.
    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: orchestrator.token }
    );
    expect(reconciled.status).toBe(200);
    const stateAfter = await apiRequest<{ state: { players: Array<{ id: string } | null> } }>(
      booted.baseUrl,
      "GET",
      `/tables/${competition.tableId}`,
      { token: payer.token }
    );
    expect(stateAfter.body.state.players[agentSeat]).toBeNull();

    const before = await booted.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { stateVersion: true, eventSeq: true },
    });
    const eventsBefore = await booted.app.prisma.gameEvent.count({
      where: { tableId: competition.tableId },
    });

    // Seat-restricted replay after elimination: durable receipt, no movement.
    const replay = await apiRequest<{ receipt: AcceptedAction["receipt"] }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      { token: seatedCredential.token, body: accepted.body }
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.receipt.requestId).toBe(accepted.body.requestId);
    expect(replay.body.receipt.version).toBe(accepted.receipt.version);
    expect(replay.body.receipt.eventSeq).toBe(accepted.receipt.eventSeq);

    // The same replay through the SDK recovery path.
    const { PokerClient } = await import("@pokertools/sdk");
    const sdk = new PokerClient({ baseUrl: booted.baseUrl, token: seatedCredential.token });
    const sdkResult = await sdk.action(competition.tableId, accepted.body);
    expect(sdkResult.receipt.requestId).toBe(accepted.body.requestId);
    expect(sdkResult.receipt.version).toBe(accepted.receipt.version);

    // Altered payload under the same requestId has no historical proof: denied.
    const altered = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      {
        token: seatedCredential.token,
        body: { ...accepted.body, actionId: "altered-action" },
      }
    );
    expect(altered.status).toBe(403);
    expect(altered.body.code ?? altered.body.error).toBe("SEAT_RESTRICTED");

    // A foreign actor replaying the agent's requestId is a conflict.
    const foreignActor = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      { token: payer.token, body: accepted.body }
    );
    expect(foreignActor.status).toBe(409);
    expect(foreignActor.body.code ?? foreignActor.body.error).toBe("REQUEST_ID_CONFLICT");

    // A brand-new action from the eliminated agent stays blocked.
    const newAgentAction = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      {
        token: seatedCredential.token,
        body: {
          requestId: crypto.randomUUID(),
          turnId: accepted.body.turnId,
          expectedVersion: accepted.body.expectedVersion,
          actionId: accepted.body.actionId,
        },
      }
    );
    expect(newAgentAction.status).toBe(403);
    expect(newAgentAction.body.code ?? newAgentAction.body.error).toBe("SEAT_RESTRICTED");

    // A table-only credential (omitted seat) replays the same receipt without
    // needing historical-seat proof.
    const tableOnlyReplay = await apiRequest<{ receipt: AcceptedAction["receipt"] }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      { token: tableOnlyCredential.token, body: accepted.body }
    );
    expect(tableOnlyReplay.status, JSON.stringify(tableOnlyReplay.body)).toBe(200);
    expect(tableOnlyReplay.body.receipt.requestId).toBe(accepted.body.requestId);

    // No replay or denial advanced the table.
    const after = await booted.app.prisma.table.findUniqueOrThrow({
      where: { id: competition.tableId },
      select: { stateVersion: true, eventSeq: true },
    });
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.eventSeq).toBe(before.eventSeq);
    expect(
      await booted.app.prisma.gameEvent.count({ where: { tableId: competition.tableId } })
    ).toBe(eventsBefore);

    // Revoked credential: authorization fails before replay.
    const revoked = await apiRequest(
      booted.baseUrl,
      "POST",
      `/auth/service-credentials/${seatedCredential.credentialId}/revoke`,
      { token: operator.token }
    );
    expect(revoked.status).toBe(200);
    const revokedReplay = await apiRequest(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      { token: seatedCredential.token, body: accepted.body }
    );
    expect(revokedReplay.status).toBe(401);

    // After settlement, a new action is still blocked.
    const settled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: {} }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    const newAfterFinish = await apiRequest<{ error?: string; code?: string }>(
      booted.baseUrl,
      "POST",
      `/tables/${competition.tableId}/action`,
      {
        token: tableOnlyCredential.token,
        body: {
          requestId: crypto.randomUUID(),
          turnId: accepted.body.turnId,
          expectedVersion: accepted.body.expectedVersion,
          actionId: accepted.body.actionId,
        },
      }
    );
    expect(newAfterFinish.status).toBe(409);
    const finishCode = newAfterFinish.body.code ?? newAfterFinish.body.error;
    expect(["COMPETITION_NOT_ACTIONABLE", "TABLE_CLOSED"]).toContain(finishCode);
  });
});
