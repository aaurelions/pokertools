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
        // Disposable gameplay fixture only, NOT deposit/ledger acceptance.
        await app.prisma.account.updateMany({
          where: { userId: result.user.id, type: "MAIN" },
          data: { balance: 1000n },
        });
      }
      expect(HealthResponseSchema.safeParse(await clients[0].health()).success).toBe(true);
      const readiness = await fetch(`${baseUrl}/ready`);
      expect(readiness.status).toBe(503);
      expect(ReadinessResponseSchema.parse(await readiness.json()).financial.status).toBe(
        "blocked"
      );

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
      await socket.join(tableId);
      const deal = { type: "DEAL" as const, idempotencyKey: "loopback-deal" };
      const dealt = await clients[0].action(tableId, deal);
      const replay = await clients[0].action(tableId, deal);
      expect(replay.version).toBe(dealt.version);
      expect(dealt.deck).toEqual([]);
      expect(dealt.previousStates).toEqual([]);
      expect(dealt.players.find((player) => player?.id === ids[1])?.hand).toBeNull();

      const spoof = await fetch(`${baseUrl}/tables/${tableId}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${clients[0].getToken()}`,
        },
        body: JSON.stringify({ type: "FOLD", playerId: ids[1] }),
      });
      expect(spoof.status).toBe(400);
      expect((await clients[0].getTableState(tableId))?.version).toBe(dealt.version);

      let state = dealt;
      for (let step = 0; step < 10 && !state.winners?.length; step++) {
        const actor = state.players[state.actionTo!];
        const index = ids.indexOf(actor!.id);
        expect(index).toBeGreaterThanOrEqual(0);
        state = await clients[index].action(tableId, {
          type: "FOLD",
          idempotencyKey: `fold-${step}`,
        });
      }
      expect(state.winners?.length).toBeGreaterThan(0);
      expect(state.players.reduce((sum, player) => sum + (player?.stack ?? 0), 0)).toBe(2000);
      socket.disconnect();
      await socket.connect();
      const recovered = await socket.join(tableId);
      expect(recovered.version).toBe(state.version);
      expect(recovered.deck).toEqual([]);
      expect(recovered.previousStates).toEqual([]);
      for (const client of clients) await client.stand(tableId);
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
        await app.prisma.ledgerEntry.deleteMany({ where: { account: { userId: id } } });
        await app.prisma.account.deleteMany({ where: { userId: id } });
        await app.prisma.user.deleteMany({ where: { id } });
      }
      await app.close();
    }
  });
});
