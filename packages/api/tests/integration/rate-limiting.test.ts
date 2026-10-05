/// <reference path="../../types/fastify.d.ts" />
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ActionType, CanonicalActionResultSchema, type SeatObservation } from "@pokertools/types";
import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { parseTrustedProxyCidrs } from "../../src/rate-limiting.js";
import {
  cleanupTestTable,
  cleanupTestUser,
  createTestUser,
  toCanonicalActionRequest,
  type TestUser,
} from "../helpers/test-utils.js";
import {
  buildRateLimitedApp,
  cleanupServicePrincipal,
  closeRateLimitRedis,
  createRateLimitTable,
  createServiceFixture,
  createWalletSession,
  mintUnregisteredServiceToken,
  observeAt,
  rateLimitRequest,
  resetRateLimitState,
  type ServiceFixture,
  type ServiceFixtureOptions,
} from "../helpers/rate-limit.js";

/**
 * Rate limiting contract:
 *
 * - coarse manual limiter, global onRequest before auth, independent store,
 *   keyed per client IP; `networkMax` default 1000;
 * - per-principal limiter, application plugin preParsing hook (after every
 *   auth onRequest hook, before body parsing and the SERVICE authorization
 *   preHandler), keyed by the verified principal (`kind:id`), falling back to
 *   the unauthenticated client IP; `max` default 100 (unchanged). Rejected
 *   bodies/forbidden scopes still spend the principal's budget;
 * - strict nonce/login per-IP route limits (5/10 per minute) stay as they are;
 * - `trustedProxyCidrs` explicitly enables proxy IP resolution; default false.
 */

const TEST_NET = "198.51.100";

function rateOptions(max: number, networkMax: number) {
  return { enabled: true, max, networkMax } as const;
}

/**
 * Pick a non-terminal family from the server-issued menu (CALL/CHECK keep the
 * hand alive for the opponent). Legality is never computed client-side.
 */
function pickActorFamily(observation: SeatObservation): string {
  const families = observation.legalActions.map((action) => action.family);
  for (const family of ["CALL", "CHECK"] as const) {
    if (families.includes(family)) return family;
  }
  throw new Error(`Server offered no non-terminal legal action (offered: ${families.join(", ")})`);
}

describe("rate limiting: principal budgets, network bound and client-IP resolution", () => {
  let app: FastifyInstance | undefined;
  const walletIds: string[] = [];
  const servicePrincipalIds: string[] = [];
  const tableIds: string[] = [];

  async function init(options: BuildAppOptions): Promise<FastifyInstance> {
    app = await buildRateLimitedApp(options);
    return app;
  }

  async function wallet(userApp: FastifyInstance, name: string): Promise<TestUser> {
    const user = await createTestUser(userApp, name, 10000);
    walletIds.push(user.id);
    return user;
  }

  async function service(
    userApp: FastifyInstance,
    options: ServiceFixtureOptions
  ): Promise<ServiceFixture> {
    const fixture = await createServiceFixture(userApp, options);
    servicePrincipalIds.push(fixture.principalId);
    return fixture;
  }

  async function table(userApp: FastifyInstance): Promise<string> {
    const tableId = await createRateLimitTable(userApp);
    tableIds.push(tableId);
    return tableId;
  }

  beforeEach(async () => {
    await resetRateLimitState();
  });

  afterEach(async () => {
    if (!app) return;
    const userApp = app;
    app = undefined;
    for (const tableId of tableIds.splice(0)) {
      await cleanupTestTable(userApp, tableId);
    }
    for (const principalId of servicePrincipalIds.splice(0)) {
      await cleanupServicePrincipal(userApp, principalId);
    }
    for (const userId of walletIds.splice(0)) {
      await cleanupTestUser(userApp, userId);
    }
    await userApp.close();
  });

  afterAll(async () => {
    await closeRateLimitRedis();
  });

  it("gives SERVICE and WALLET principals behind the same IP independent budgets", async () => {
    const userApp = await init({ rateLimiting: rateOptions(2, 20) });
    const tableId = await table(userApp);
    const observer = await service(userApp, { scopes: ["table:observe"], tableId });
    const player = await wallet(userApp, "rl_svc_wallet");
    const ip = `${TEST_NET}.10`;
    const url = `/tables/${tableId}/observation`;

    const walletStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      walletStatuses.push(
        (await rateLimitRequest(userApp, { url, token: player.token, remoteAddress: ip }))
          .statusCode
      );
    }
    expect(walletStatuses.slice(0, 2)).toEqual([200, 200]);
    expect(walletStatuses[2]).toBe(429);

    // The wallet exhausting its own budget must not spend the SERVICE budget,
    // even though both principals share the same source IP.
    const serviceStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      serviceStatuses.push(
        (await rateLimitRequest(userApp, { url, token: observer.token, remoteAddress: ip }))
          .statusCode
      );
    }
    expect(serviceStatuses.slice(0, 2)).toEqual([200, 200]);
    expect(serviceStatuses[2]).toBe(429);
  });

  it.each(["SERVICE", "WALLET"] as const)(
    "keeps two %s principals behind the same IP on independent budgets",
    async (kind) => {
      const userApp = await init({ rateLimiting: rateOptions(2, 20) });
      const tableId = await table(userApp);
      const url = `/tables/${tableId}/observation`;
      const ip = `${TEST_NET}.90`;

      // Same kind on both sides: a key composed from the principal kind alone
      // would make the peers share a single budget and fail here.
      const first =
        kind === "SERVICE"
          ? await service(userApp, { scopes: ["table:observe"], tableId })
          : await wallet(userApp, "rl_peer_a");
      const second =
        kind === "SERVICE"
          ? await service(userApp, { scopes: ["table:observe"], tableId })
          : await wallet(userApp, "rl_peer_b");

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        statuses.push(
          (await rateLimitRequest(userApp, { url, token: first.token, remoteAddress: ip }))
            .statusCode
        );
      }
      expect(statuses.slice(0, 2)).toEqual([200, 200]);
      expect(statuses[2]).toBe(429);

      // The peer keeps its own budget despite the first peer being exhausted.
      const peerStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        peerStatuses.push(
          (await rateLimitRequest(userApp, { url, token: second.token, remoteAddress: ip }))
            .statusCode
        );
      }
      expect(peerStatuses.slice(0, 2)).toEqual([200, 200]);
      expect(peerStatuses[2]).toBe(429);
    }
  );

  it("keeps one principal on a single budget across credentials, sockets and a fresh wallet session", async () => {
    const userApp = await init({ rateLimiting: rateOptions(2, 20) });
    const tableId = await table(userApp);
    const observer = await service(userApp, { scopes: ["table:observe"], tableId });
    const url = `/tables/${tableId}/observation`;

    // Two different source addresses still share the principal's budget.
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: observer.token,
          remoteAddress: `${TEST_NET}.20`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: observer.token,
          remoteAddress: `${TEST_NET}.21`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: observer.token,
          remoteAddress: `${TEST_NET}.22`,
        })
      ).statusCode
    ).toBe(429);

    // A brand-new credential for the same SERVICE principal keeps its budget.
    const rotated = await service(userApp, {
      scopes: ["table:observe"],
      tableId,
      principalId: observer.principalId,
    });
    expect(rotated.principalId).toBe(observer.principalId);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: rotated.token,
          remoteAddress: `${TEST_NET}.23`,
        })
      ).statusCode
    ).toBe(429);

    // A fresh wallet session/JWT (same wallet principal) keeps its budget too.
    const player = await wallet(userApp, "rl_evade");
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: player.token,
          remoteAddress: `${TEST_NET}.24`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: player.token,
          remoteAddress: `${TEST_NET}.25`,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: player.token,
          remoteAddress: `${TEST_NET}.26`,
        })
      ).statusCode
    ).toBe(429);
    const reconnected = await createWalletSession(userApp, player);
    expect(
      (
        await rateLimitRequest(userApp, {
          url,
          token: reconnected.token,
          remoteAddress: `${TEST_NET}.27`,
        })
      ).statusCode
    ).toBe(429);
  });

  it("gives revoked and unknown credentials no trusted key and bounds them at the network layer", async () => {
    const userApp = await init({ rateLimiting: rateOptions(50, 4) });
    const tableId = await table(userApp);
    const revoked = await service(userApp, {
      scopes: ["table:observe"],
      tableId,
      revoked: true,
    });
    const url = "/tables";
    const ip = `${TEST_NET}.30`;

    const statuses: number[] = [];
    statuses.push(
      (await rateLimitRequest(userApp, { url, token: revoked.token, remoteAddress: ip })).statusCode
    );
    // Never-seen credentials must not mint fresh per-credential buckets.
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (
          await rateLimitRequest(userApp, {
            url,
            token: mintUnregisteredServiceToken(),
            remoteAddress: ip,
          })
        ).statusCode
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401]);

    // The coarse network bound is already exhausted for hostile traffic on
    // this IP.
    const overflow = await rateLimitRequest(userApp, {
      url,
      token: mintUnregisteredServiceToken(),
      remoteAddress: ip,
    });
    expect(overflow.statusCode).toBe(429);

    // The coarse layer is per client IP, not one globally shared platform
    // bucket: a fresh IP with an unknown credential is still challenged (401),
    // not rejected by the exhausted network budget of the first IP.
    const isolated = await rateLimitRequest(userApp, {
      url,
      token: mintUnregisteredServiceToken(),
      remoteAddress: `${TEST_NET}.31`,
    });
    expect(isolated.statusCode).toBe(401);
  });

  it("limits unauthenticated traffic per client IP and keeps separate IPs isolated", async () => {
    const userApp = await init({ rateLimiting: rateOptions(2, 50) });
    const ipA = `${TEST_NET}.40`;
    const ipB = `${TEST_NET}.41`;

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await rateLimitRequest(userApp, { url: "/tables", remoteAddress: ipA })).statusCode
      );
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);

    // A different client IP is not consumed by the first client's traffic.
    expect(
      (await rateLimitRequest(userApp, { url: "/tables", remoteAddress: ipB })).statusCode
    ).toBe(200);
  });

  it("ignores spoofed X-Forwarded-For without trusted proxies", async () => {
    const userApp = await init({ rateLimiting: rateOptions(2, 50) });
    const ip = `${TEST_NET}.50`;

    const statuses: number[] = [];
    for (const forwardedFor of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      statuses.push(
        (await rateLimitRequest(userApp, { url: "/tables", remoteAddress: ip, forwardedFor }))
          .statusCode
      );
    }
    // Rotating a forged XFF header must not rotate the limiter bucket.
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);
  });

  it("resolves the real client IP from X-Forwarded-For only behind trusted proxy CIDRs", async () => {
    const userApp = await init({
      rateLimiting: rateOptions(2, 50),
      trustedProxyCidrs: ["10.0.0.0/8"],
    });
    const proxyIp = "10.1.2.3";
    const realA = "203.0.113.10";
    const realB = "203.0.113.11";

    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: proxyIp,
          forwardedFor: realA,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: proxyIp,
          forwardedFor: realA,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: proxyIp,
          forwardedFor: realA,
        })
      ).statusCode
    ).toBe(429);
    // A different real client behind the same trusted proxy has its own budget.
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: proxyIp,
          forwardedFor: realB,
        })
      ).statusCode
    ).toBe(200);

    // An untrusted peer cannot forge the client IP via X-Forwarded-For.
    const untrusted = `${TEST_NET}.60`;
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: untrusted,
          forwardedFor: "203.0.113.99",
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: untrusted,
          forwardedFor: "203.0.113.98",
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          url: "/tables",
          remoteAddress: untrusted,
          forwardedFor: "203.0.113.97",
        })
      ).statusCode
    ).toBe(429);
  });

  it("keeps strict nonce/login IP limits firing alongside the manual limiter", async () => {
    const userApp = await init({ rateLimiting: rateOptions(50, 100) });

    // Route-level strict limits are 5/min (nonce) and 10/min (login). They must
    // still fire after the manual global limiter ran: the manual instance must
    // not set the @fastify/rate-limit `rateLimitRan` marker that would skip the
    // plugin's route handler.
    const nonceIp = `${TEST_NET}.70`;
    const nonceStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      nonceStatuses.push(
        (
          await rateLimitRequest(userApp, {
            method: "POST",
            url: "/auth/nonce",
            remoteAddress: nonceIp,
          })
        ).statusCode
      );
    }
    expect(nonceStatuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(nonceStatuses[5]).toBe(429);

    // Malformed bodies still consume the login budget: limiting happens on
    // request, before body validation.
    const loginIp = `${TEST_NET}.71`;
    const loginStatuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      loginStatuses.push(
        (
          await rateLimitRequest(userApp, {
            method: "POST",
            url: "/auth/login",
            remoteAddress: loginIp,
            payload: "{ malformed",
            contentType: "application/json",
          })
        ).statusCode
      );
    }
    expect(loginStatuses.slice(0, 10)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect(loginStatuses[10]).toBe(429);
  });

  it("charges malformed JSON and forbidden-scope requests without masking auth or scope", async () => {
    const userApp = await init({ rateLimiting: rateOptions(2, 20) });
    const tableId = await table(userApp);
    const player = await wallet(userApp, "rl_parse");
    const observer = await service(userApp, { scopes: ["table:observe"], tableId });
    const ip = `${TEST_NET}.95`;
    // A route without a route-level rate-limit override, so the application
    // budget under test is the one configured through buildApp. (The chat
    // routes carry an explicit test-env route override of their own.)
    const actionUrl = `/tables/${tableId}/action`;

    // A SERVICE principal holding only table:observe still receives its scope
    // decision (403 SCOPE_MISSING), while both attempts are charged to its
    // preParsing budget: the third request is rejected by the limiter.
    const firstScope = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: observer.token,
      remoteAddress: ip,
      payload: {},
    });
    expect(firstScope.statusCode).toBe(403);
    expect(JSON.parse(firstScope.body).error).toBe("SCOPE_MISSING");

    const secondScope = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: observer.token,
      remoteAddress: ip,
      payload: {},
    });
    expect(secondScope.statusCode).toBe(403);

    const scopeOverflow = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: observer.token,
      remoteAddress: ip,
      payload: {},
    });
    expect(scopeOverflow.statusCode).toBe(429);

    // A valid wallet principal with a malformed body: the auth onRequest hook
    // has already succeeded, so the strict body error is 400 — never a 401 —
    // and both units of the application budget are still spent.
    const malformed = {
      method: "POST" as const,
      url: actionUrl,
      token: player.token,
      remoteAddress: ip,
      payload: "{ malformed",
      contentType: "application/json",
    };
    expect((await rateLimitRequest(userApp, malformed)).statusCode).toBe(400);
    expect((await rateLimitRequest(userApp, malformed)).statusCode).toBe(400);

    const wellFormed = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: player.token,
      remoteAddress: ip,
      payload: {},
    });
    expect(wellFormed.statusCode).toBe(429);

    // An exhausted application budget never masks authentication: an invalid
    // credential fails closed at onRequest with 401, before the limiter.
    const invalid = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: mintUnregisteredServiceToken(),
      remoteAddress: ip,
      payload: {},
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("charges observation and both chat verbs against one shared principal budget", async () => {
    const userApp = await init({ rateLimiting: rateOptions(3, 20) });
    const tableId = await table(userApp);
    const player = await wallet(userApp, "rl_shared_budget");
    const ip = `${TEST_NET}.96`;
    const observationUrl = `/tables/${tableId}/observation`;
    const chatUrl = `/tables/${tableId}/chat`;

    // Observation plus GET/POST chat all draw on the same application budget:
    // the chat routes carry no separate route-level bucket.
    expect(
      (
        await rateLimitRequest(userApp, {
          url: observationUrl,
          token: player.token,
          remoteAddress: ip,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await rateLimitRequest(userApp, {
          method: "POST",
          url: chatUrl,
          token: player.token,
          remoteAddress: ip,
          payload: { body: "shared budget" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await rateLimitRequest(userApp, { url: chatUrl, token: player.token, remoteAddress: ip }))
        .statusCode
    ).toBe(200);

    // Budget 3 is spent; every further request on the shared routes is 429.
    expect(
      (
        await rateLimitRequest(userApp, {
          url: observationUrl,
          token: player.token,
          remoteAddress: ip,
        })
      ).statusCode
    ).toBe(429);
    expect(
      (
        await rateLimitRequest(userApp, {
          method: "POST",
          url: chatUrl,
          token: player.token,
          remoteAddress: ip,
          payload: { body: "shared budget" },
        })
      ).statusCode
    ).toBe(429);
  });

  it("bounds early CORS preflight responses at the coarse network layer", async () => {
    const userApp = await init({ rateLimiting: rateOptions(50, 2) });
    const ip = `${TEST_NET}.97`;
    const preflight = {
      method: "OPTIONS" as const,
      url: "/tables",
      remoteAddress: ip,
      headers: {
        origin: "https://app.example.test",
        "access-control-request-method": "GET",
      },
    };

    // A valid preflight is answered early by CORS (204), but the coarse network
    // guard is installed before CORS and still charges the source IP.
    const first = await rateLimitRequest(userApp, preflight);
    expect(first.statusCode).toBe(204);
    expect(first.headers["access-control-allow-origin"]).toBe("https://app.example.test");

    expect((await rateLimitRequest(userApp, preflight)).statusCode).toBe(204);

    // networkMax is 2: the third preflight from the same IP is rejected before
    // CORS can answer.
    expect((await rateLimitRequest(userApp, preflight)).statusCode).toBe(429);
  });

  it("prevents one principal's exhausted observation/action traffic from starving another behind the same IP", async () => {
    const userApp = await init({ rateLimiting: rateOptions(4, 20) });
    const tableId = await table(userApp);
    const playerA = await wallet(userApp, "rl_starve_a");
    const playerB = await wallet(userApp, "rl_starve_b");
    const ip = `${TEST_NET}.80`;
    const actionUrl = `/tables/${tableId}/action`;

    const buyIn = (player: TestUser, seat: number) =>
      rateLimitRequest(userApp, {
        method: "POST",
        url: `/tables/${tableId}/buy-in`,
        token: player.token,
        remoteAddress: ip,
        payload: { amount: 1000, seat, idempotencyKey: crypto.randomUUID() },
      });

    expect((await buyIn(playerA, 0)).statusCode).toBe(200);
    expect((await buyIn(playerB, 1)).statusCode).toBe(200);

    // Start the hand through the internal management path, exactly like the
    // canonical protocol tests (canonical DEAL is not a public action).
    await userApp.gameManager.processAction(tableId, { type: ActionType.DEAL }, playerA.id);

    // Resolve the turn and the action family from the server-issued menu only.
    let observation = await observeAt(userApp, {
      token: playerA.token,
      tableId,
      remoteAddress: ip,
    });
    let first = playerA;
    let second = playerB;
    if (observation.legalActions.length === 0) {
      first = playerB;
      second = playerA;
      observation = await observeAt(userApp, {
        token: playerB.token,
        tableId,
        remoteAddress: ip,
      });
    }
    expect(observation.state.viewingPlayerId).toBe(first.id);
    expect(observation.legalActions.length).toBeGreaterThan(0);

    // Real server-issued canonical action, accepted and version-advanced.
    const firstAction = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: first.token,
      remoteAddress: ip,
      payload: toCanonicalActionRequest(observation, { type: pickActorFamily(observation) }),
    });
    expect(firstAction.statusCode).toBe(200);
    const firstResult = CanonicalActionResultSchema.parse(JSON.parse(firstAction.body));
    expect(firstResult.receipt.version).toBe(observation.version + 1);

    // Exhaust `first` after its real action: the fourth request is allowed and
    // the fifth is rejected for this principal only (max 4).
    expect(
      (await observeAt(userApp, { token: first.token, tableId, remoteAddress: ip })).version
    ).toBe(firstResult.receipt.version);
    const exhausted = await rateLimitRequest(userApp, {
      url: `/tables/${tableId}/observation`,
      token: first.token,
      remoteAddress: ip,
    });
    expect(exhausted.statusCode).toBe(429);

    // The other principal, on the same IP, still gets a real observation and a
    // server-accepted canonical action.
    const secondObservation = await observeAt(userApp, {
      token: second.token,
      tableId,
      remoteAddress: ip,
    });
    expect(secondObservation.state.viewingPlayerId).toBe(second.id);
    expect(secondObservation.legalActions.length).toBeGreaterThan(0);
    const secondAction = await rateLimitRequest(userApp, {
      method: "POST",
      url: actionUrl,
      token: second.token,
      remoteAddress: ip,
      payload: toCanonicalActionRequest(secondObservation, {
        type: pickActorFamily(secondObservation),
      }),
    });
    expect(secondAction.statusCode).toBe(200);
    expect(CanonicalActionResultSchema.parse(JSON.parse(secondAction.body)).receipt.version).toBe(
      secondObservation.version + 1
    );
  });

  it("rejects non-explicit or unrestricted trusted proxy entries at startup", async () => {
    // Explicit ingress addresses only: valid IP/CIDR entries are preserved.
    expect(parseTrustedProxyCidrs(["10.0.0.0/8", "192.0.2.7", "2001:db8::/32"])).toEqual([
      "10.0.0.0/8",
      "192.0.2.7",
      "2001:db8::/32",
    ]);
    // The default empty config trusts no proxy.
    expect(parseTrustedProxyCidrs("")).toEqual([]);

    // `true`, hostnames/hops, unrestricted /0 and malformed prefixes are all
    // rejected rather than inferred.
    for (const invalid of [
      true,
      "hop",
      "proxy.internal",
      "10.0.0.0/0",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/x",
    ]) {
      expect(() => parseTrustedProxyCidrs(invalid as never)).toThrow();
    }

    // The buildApp seam applies the same startup validation.
    await expect(buildApp({ trustedProxyCidrs: ["10.0.0.0/0"] })).rejects.toThrow();
  });
});
