import { describe, expect, it } from "vitest";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PokerClient, PokerSocket } from "@pokertools/sdk";
import { HealthResponseSchema, ReadinessResponseSchema } from "@pokertools/types";
import { buildApp } from "../../src/app.js";

describe("actual loopback API + SDK", () => {
  it("completes a wallet-only hand with masking, retries and blocked readiness", async () => {
    const app = await buildApp();
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const clients: PokerClient[] = [];
    const ids: string[] = [];
    let tableId: string | undefined;
    let socket: PokerSocket | undefined;
    try {
      for (let index = 0; index < 2; index++) {
        const client = new PokerClient({ baseUrl, retry: { count: 0 } });
        const account = privateKeyToAccount(generatePrivateKey());
        const message = createSiweMessage({
          address: account.address,
          chainId: 31337,
          domain: new URL(baseUrl).hostname,
          uri: baseUrl,
          nonce: await client.getNonce(),
          version: "1",
          issuedAt: new Date(),
        });
        const result = await client.login({
          message,
          signature: await account.signMessage({ message }),
        });
        clients.push(client);
        ids.push(result.user.id);
        // Canonical chip funding. Disposable gameplay fixture only, NOT
        // deposit/ledger acceptance.
        await app.financialManager.grantChips(result.user.id, 1000, {
          reason: "test_fixture",
          operatorId: result.user.id,
          idempotencyKey: `loopback-grant-${result.user.id}`,
        });
      }
      expect(HealthResponseSchema.safeParse(await clients[0].health()).success).toBe(true);
      const readiness = await fetch(`${baseUrl}/ready`);
      expect(readiness.status).toBe(503);
      expect(ReadinessResponseSchema.parse(await readiness.json()).financial.state).toBe("BLOCKED");

      tableId = await clients[0].createTable({
        name: "loopback-wallet-hand",
        mode: "CASH",
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        rakePercent: 0,
      });
      for (let index = 0; index < 2; index++) {
        await clients[index].buyIn(tableId, {
          seat: index,
          amount: 1000,
          idempotencyKey: `buyin-${index}`,
        });
      }
      socket = new PokerSocket({
        url: baseUrl.replace(/^http/, "ws") + "/ws/play",
        token: clients[0].getToken()!,
        reconnectAttempts: 0,
      });
      await socket.connect();
      const joined = await socket.join(tableId);
      expect(joined.state.viewingPlayerId).toBe(ids[0]);

      // Canonical DEAL through the observation/action protocol.
      const preDeal = await clients[0].getObservation(tableId);
      const dealAction = preDeal.legalActions.find((action) => action.family === "DEAL");
      expect(dealAction).toBeDefined();
      const dealRequest = {
        requestId: "loopback-deal",
        turnId: preDeal.turnId,
        expectedVersion: preDeal.version,
        actionId: dealAction!.actionId,
      };
      const dealt = await clients[0].action(tableId, dealRequest);
      const replay = await clients[0].action(tableId, dealRequest);
      expect(replay.receipt.version).toBe(dealt.receipt.version);
      expect(replay.observation.version).toBe(dealt.observation.version);
      expect(dealt.observation.state.deck).toEqual([]);
      // No original/private snapshot fields may leak onto the wire.
      expect("previousStates" in dealt.observation.state).toBe(false);
      expect(
        dealt.observation.state.players.find((player) => player?.id === ids[1])?.hand
      ).toBeNull();

      const spoof = await fetch(`${baseUrl}/tables/${tableId}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${clients[0].getToken()}`,
        },
        // Actor identity is derived from auth. This carries every canonical
        // field plus an explicit `playerId`, so it fails strictly on the actor
        // field rather than on a missing canonical field.
        body: JSON.stringify({
          requestId: "spoof-request",
          turnId: "spoof-turn",
          expectedVersion: 0,
          actionId: "spoof-action",
          playerId: ids[1],
        }),
      });
      expect(spoof.status).toBe(400);
      expect((await clients[0].getTableState(tableId))?.version).toBe(dealt.observation.version);

      let state = dealt.observation.state;
      for (let step = 0; step < 10 && !state.winners?.length; step++) {
        const actor = state.players[state.actionTo!];
        const index = ids.indexOf(actor!.id);
        expect(index).toBeGreaterThanOrEqual(0);
        const observation = await clients[index].getObservation(tableId);
        const fold = observation.legalActions.find((action) => action.family === "FOLD");
        expect(fold).toBeDefined();
        const result = await clients[index].action(tableId, {
          requestId: `loopback-fold-${step}`,
          turnId: observation.turnId,
          expectedVersion: observation.version,
          actionId: fold!.actionId,
        });
        state = result.observation.state;
      }
      expect(state.winners?.length).toBeGreaterThan(0);
      expect(state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0)).toBe(2000);

      socket.disconnect();
      await socket.connect();
      const recovered = await socket.join(tableId);
      expect(recovered.version).toBe(state.version);
      expect(recovered.state.deck).toEqual([]);
      expect("previousStates" in recovered.state).toBe(false);

      // Stand uses the dedicated REST cash-out endpoint (STAND is a management
      // action and is deliberately not offered as a public legal action).
      for (const client of clients) {
        const stand = await fetch(`${baseUrl}/tables/${tableId}/stand`, {
          method: "POST",
          headers: { authorization: `Bearer ${client.getToken()}` },
        });
        expect(stand.status).toBe(200);
      }
      console.log(
        "LOOPBACK_WALLET_HAND=PASS (development protocol; not service/finance acceptance)"
      );
    } finally {
      socket?.disconnect();
      if (tableId) {
        await app.prisma.handHistory.deleteMany({ where: { tableId } });
        await app.prisma.table.deleteMany({ where: { id: tableId } });
        await app.redis.del(`table:${tableId}`);
      }
      for (const id of ids) {
        await app.prisma.session.deleteMany({ where: { userId: id } });
        await app.prisma.chipLedgerEntry.deleteMany({
          where: { account: { principalId: id } },
        });
        await app.prisma.chipGrant.deleteMany({ where: { principalId: id } });
        await app.prisma.chipAccount.deleteMany({ where: { principalId: id } });
        await app.prisma.user.deleteMany({ where: { id } });
      }
      await app.close();
    }
  });
});
