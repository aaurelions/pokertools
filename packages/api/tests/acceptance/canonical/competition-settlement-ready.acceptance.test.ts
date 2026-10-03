/**
 * `settlementReady` capability acceptance on real PostgreSQL + Redis.
 *
 * The public competition projection must tell an external orchestrator when the
 * authoritative game is complete, without local stack heuristics or exception
 * polling:
 * - false while a hand is in flight or an elimination is not yet settled;
 * - true once the director state shows exactly one ACTIVE entrant with chips
 *   and every other entry eliminated at a completed-hand boundary;
 * - true once FINISHED, and settlement can then run exactly once.
 *
 * Asserted through the SDK `CompetitionClient.getCompetition` transport for
 * both a WALLET and a SERVICE winner.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
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
  status: string;
  settlementReady: boolean;
  entrants: Array<{ principalId: string; seat: number }>;
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
        name: `ready-orchestrator-${crypto.randomBytes(3).toString("hex")}`,
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
  principalId: string
): Promise<string> {
  const response = await apiRequest<{ token: string }>(
    baseUrl,
    "POST",
    `/competitions/${competitionId}/agent-credentials`,
    { token, body: { principalId, name: `ready-agent-${crypto.randomBytes(3).toString("hex")}` } }
  );
  if (response.status !== 201) {
    throw new Error(`agent credential failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

describe("competition settlementReady (PostgreSQL + Redis, SDK)", () => {
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

  /**
   * Play heads-up to one live stack. `folder` folds; `caller` calls/bets.
   * Returns after the final hand completes, before director reconciliation.
   */
  const playToCompletion = async (
    tableId: string,
    folderToken: string,
    callerToken: string
  ): Promise<void> => {
    const submit = async (token: string, families: readonly string[]): Promise<boolean> => {
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
      }>(booted.baseUrl, "GET", `/tables/${tableId}/observation`, { token });
      if (observationResponse.status !== 200) return false;
      const observation = observationResponse.body;
      if (!observation.turnId || observation.legalActions.length === 0) return false;
      const legal = observation.legalActions.find((action) => families.includes(action.family));
      if (!legal) return false;
      const takesAmount = legal.family === "BET" || legal.family === "RAISE";
      const amount = legal.amount ?? legal.minAmount ?? legal.maxAmount;
      const response = await apiRequest(booted.baseUrl, "POST", `/tables/${tableId}/action`, {
        token,
        body: {
          requestId: crypto.randomUUID(),
          turnId: observation.turnId,
          expectedVersion: observation.version,
          actionId: legal.actionId,
          ...(takesAmount && amount !== undefined ? { amount } : {}),
        },
      });
      if (response.status !== 200) {
        throw new Error(`action rejected: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return true;
    };

    for (let hand = 0; hand < 80; hand++) {
      await submit(callerToken, ["DEAL"]);
      await submit(folderToken, ["DEAL"]);
      for (let step = 0; step < 40; step++) {
        const stateResponse = await apiRequest<{
          state: { winners?: unknown[]; players: Array<{ stack: number } | null> };
        }>(booted.baseUrl, "GET", `/tables/${tableId}`, { token: callerToken });
        if (stateResponse.body.state.winners?.length) break;
        const acted =
          (await submit(folderToken, ["FOLD", "CHECK", "CALL"])) ||
          (await submit(callerToken, ["BET", "RAISE", "CALL", "CHECK"]));
        if (!acted) break;
      }
      const stateResponse = await apiRequest<{
        state: { players: Array<{ stack: number } | null> };
      }>(booted.baseUrl, "GET", `/tables/${tableId}`, { token: callerToken });
      const live = stateResponse.body.state.players.filter(
        (player) => player && player.stack > 0
      ).length;
      if (live <= 1) return;
    }
    throw new Error("competition did not complete within the hand budget");
  };

  const runSettlementReadyScenario = async (
    name: string,
    winner: "WALLET" | "SERVICE"
  ): Promise<void> => {
    const { CompetitionClient } = await import("@pokertools/sdk");
    const orchestrator = await createOrchestrator(booted.baseUrl, operator.token);
    servicePrincipalIds.push(orchestrator.principalId);
    const agent = await provisionServicePrincipal(
      booted.baseUrl,
      operator.token,
      `ready-agent-${crypto.randomBytes(3).toString("hex")}`,
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
          name,
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

    const sdk = new CompetitionClient({ baseUrl: booted.baseUrl, token: payer.token });

    // Registration: never settlement-ready.
    const beforeStart = await sdk.getCompetition(competition.id);
    expect(beforeStart.status).toBe("REGISTRATION");
    expect(beforeStart.settlementReady).toBe(false);

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

    // Hand in flight: false, even though blinds have been posted.
    const inFlight = await sdk.getCompetition(competition.id);
    expect(inFlight.status).toBe("RUNNING");
    expect(inFlight.settlementReady).toBe(false);

    const agentToken = await issueCredential(
      booted.baseUrl,
      orchestrator.token,
      competition.id,
      agent
    );
    await playToCompletion(
      competition.tableId,
      winner === "WALLET" ? agentToken : payer.token,
      winner === "WALLET" ? payer.token : agentToken
    );

    // The final hand completed and the action path's integrated director has
    // already settled the elimination: RUNNING but settlement-ready, before any
    // explicit settle call.
    const afterPlay = await sdk.getCompetition(competition.id);
    expect(afterPlay.status).toBe("RUNNING");
    expect(afterPlay.settlementReady).toBe(true);

    const reconciled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/reconcile`,
      { token: orchestrator.token }
    );
    expect(reconciled.status).toBe(200);

    // Exactly one ACTIVE entrant with chips, all others eliminated: ready.
    const ready = await sdk.getCompetition(competition.id);
    expect(ready.status).toBe("RUNNING");
    expect(ready.settlementReady).toBe(true);

    const settled = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: {} }
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);

    const finished = await sdk.getCompetition(competition.id);
    expect(finished.status).toBe("FINISHED");
    expect(finished.settlementReady).toBe(true);

    // Settlement after ready is exactly once; a repeat replays.
    const replayed = await apiRequest(
      booted.baseUrl,
      "POST",
      `/competitions/${competition.id}/settle`,
      { token: orchestrator.token, body: {} }
    );
    expect(replayed.status).toBe(200);
    const tournament = await booted.app.prisma.competition.findUniqueOrThrow({
      where: { id: competition.id },
      select: { tournamentId: true },
    });
    expect(
      await booted.app.prisma.tournamentEvent.count({
        where: { tournamentId: tournament.tournamentId, type: "TOURNAMENT_SETTLED" },
      })
    ).toBe(1);
  };

  it("reports settlementReady for a WALLET winner only after director elimination", async () => {
    await runSettlementReadyScenario("Ready wallet winner", "WALLET");
  });

  it("reports settlementReady for a SERVICE winner and settles exactly once", async () => {
    await runSettlementReadyScenario("Ready service winner", "SERVICE");
  });
});
