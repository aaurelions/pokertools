import { describe, expect, it, vi } from "vitest";
import { InMemoryAssetRegistry } from "../../src/core/in-memory-store.js";
import { CustodyHeartbeatWriter } from "../../src/workers/heartbeat-writer.js";
import type { TreasuryAccountResolver } from "../../src/core/viem-ports.js";
import { ASSET, FakeClock, FakeQuorumReader, TREASURY, quietLogger } from "./fakes.js";

const OTHER_TREASURY = "0x00000000000000000000000000000000000000ee";

function makeWriter(overrides: {
  accountAddress?: string;
  gasAtomic?: bigint;
  gasAgreed?: boolean;
}) {
  const clock = new FakeClock(1_700_000_000_000);
  const assets = new InMemoryAssetRegistry(clock, [ASSET]);
  const quorum = new FakeQuorumReader();
  quorum.nativeBalanceAtomic = overrides.gasAtomic ?? 10_000n;
  quorum.nativeAgreed = overrides.gasAgreed ?? true;

  const accounts = {
    resolve: () => ({ address: overrides.accountAddress ?? TREASURY }),
  } as unknown as TreasuryAccountResolver;

  const upsert = vi.fn(async (args: { create: unknown }) => args.create);
  const prisma = { custodyHeartbeat: { upsert } } as never;

  const writer = new CustodyHeartbeatWriter({
    prisma,
    assets,
    quorum,
    accounts,
    workerId: "worker-1",
    clock,
    logger: quietLogger(),
  });

  return { writer, upsert };
}

describe("CustodyHeartbeatWriter", () => {
  it("writes one fresh route-keyed heartbeat with public signer and gas evidence", async () => {
    const { writer, upsert } = makeWriter({ accountAddress: TREASURY, gasAtomic: 10_000n });

    const entries = await writer.writeAll();

    expect(entries).toEqual([
      {
        chainId: ASSET.chainId,
        signerAddress: TREASURY.toLowerCase(),
        signerReady: true,
        gasReady: true,
      },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      chainId_signerAddress_workerId: {
        chainId: ASSET.chainId,
        signerAddress: TREASURY.toLowerCase(),
        workerId: "worker-1",
      },
    });
    expect(call.create).toMatchObject({
      signerReady: true,
      gasReady: true,
      workerId: "worker-1",
    });
    // No key material is ever a field on the persisted row.
    expect(JSON.stringify(call.create)).not.toMatch(/private|mnemonic|secret/i);
  });

  it("marks a mismatched signer and insufficient gas as not ready", async () => {
    const { writer } = makeWriter({
      accountAddress: OTHER_TREASURY,
      gasAtomic: 1n,
    });

    const entries = await writer.writeAll();

    expect(entries).toEqual([
      {
        chainId: ASSET.chainId,
        signerAddress: TREASURY.toLowerCase(),
        signerReady: false,
        gasReady: false,
      },
    ]);
  });

  it("fails gas readiness closed when the quorum is unavailable", async () => {
    const { writer } = makeWriter({ gasAgreed: false });
    const entries = await writer.writeAll();
    expect(entries[0].signerReady).toBe(true);
    expect(entries[0].gasReady).toBe(false);
  });
});
