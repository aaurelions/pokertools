import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import {
  InMemoryAssetRegistry,
  InMemoryIncidentStore,
  InMemoryTreasuryAccounting,
  InMemoryWithdrawalStore,
} from "../../src/core/in-memory-store.js";
import { WithdrawalWorkflow } from "../../src/core/withdrawal-workflow.js";
import type { NewWithdrawalRecord } from "../../src/core/types.js";
import {
  ASSET,
  ASSET_ID,
  CHAIN_ID,
  DESTINATION,
  FakeBroadcaster,
  FakeClock,
  FakeQuorumReader,
  FakeSigner,
  OTHER_DESTINATION,
  quietLogger,
  successReceipt,
  matchingTransfer,
  TREASURY,
} from "./fakes.js";

function newIntent(overrides: Partial<NewWithdrawalRecord> = {}): NewWithdrawalRecord {
  return {
    intentId: "int_1",
    principalId: "principal_1",
    assetId: ASSET_ID,
    chainId: CHAIN_ID,
    destination: DESTINATION,
    amountAtomic: "500",
    nonce: 1,
    deadline: 1_700_003_600,
    signature: "0x" + "ab".repeat(65),
    treasuryAddress: TREASURY,
    tokenAddress: ASSET.tokenAddress,
    ...overrides,
  };
}

function setup() {
  const clock = new FakeClock(1_700_000_000_000);
  const store = new InMemoryWithdrawalStore(clock);
  const incidents = new InMemoryIncidentStore(clock);
  const assets = new InMemoryAssetRegistry(clock, [ASSET]);
  const accounting = new InMemoryTreasuryAccounting(clock);
  const signer = new FakeSigner();
  const quorum = new FakeQuorumReader();
  const broadcaster = new FakeBroadcaster();
  const logger = quietLogger();

  const makeWorkflow = () =>
    new WithdrawalWorkflow({
      store,
      incidents,
      assets,
      accounting,
      signer,
      quorum,
      broadcaster,
      clock,
      logger,
      config: { minQuorum: 2, maxScanBatch: 10 },
    });

  return {
    clock,
    store,
    incidents,
    assets,
    accounting,
    signer,
    quorum,
    broadcaster,
    workflow: makeWorkflow(),
    makeWorkflow,
  };
}

describe("WithdrawalWorkflow persist-before-broadcast", () => {
  it.each(["bytes", "hash"])(
    "rejects dishonest signer %s even with correct declared provenance",
    async (mismatch) => {
      const h = setup();
      const sign = h.signer.signTransfer.bind(h.signer);
      h.signer.signTransfer = async (request) => {
        const honest = await sign(request);
        if (mismatch === "hash") return { ...honest, hash: keccak256("0xdeadbeef") };
        const wrong = await sign({ ...request, destination: OTHER_DESTINATION });
        return { ...wrong, provenance: honest.provenance };
      };
      await h.workflow.acceptIntent(newIntent());
      await h.workflow.processIntent("int_1");
      expect((await h.store.get("int_1"))?.signedRawTx).toBeNull();
      expect(h.broadcaster.broadcasts).toHaveLength(0);
      expect(
        (await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" })).map(
          (incident) => incident.detail.reason
        )
      ).toContain("signed_provenance_mismatch");
    }
  );

  it("does not sign a reservation after its treasury route changes", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent({ treasuryAddress: OTHER_DESTINATION }));
    await h.workflow.processIntent("int_1");
    expect(h.signer.calls).toHaveLength(0);
    expect((await h.store.get("int_1"))?.state).toBe("RESERVED");
    expect(
      (await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" })).map(
        (incident) => incident.detail.reason
      )
    ).toContain("reserved_route_changed");
  });
  it("durably persists nonce, call data, exact bytes and hash before broadcasting", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());

    let observedDuringBroadcast: Awaited<ReturnType<typeof h.store.get>> = null;
    h.broadcaster.onBroadcast = async () => {
      observedDuringBroadcast = await h.store.get("int_1");
    };

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("signed_broadcast");
    expect(h.signer.calls).toHaveLength(1);
    expect(h.broadcaster.broadcasts).toHaveLength(1);

    const persisted = observedDuringBroadcast;
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("PERSISTED");
    expect(persisted!.signedRawTx).toBe(h.broadcaster.broadcasts[0]);
    expect(persisted!.txHash).toBe(keccak256(h.broadcaster.broadcasts[0]));
    expect(persisted!.treasuryNonce).toBe(0);
    expect(persisted!.signedCallData).not.toBeNull();
    expect(persisted!.signedValueAtomic).toBe("0");

    const finalRecord = await h.store.get("int_1");
    expect(finalRecord!.state).toBe("BROADCAST");
  });

  it("does not broadcast when signed provenance does not match the reserved intent", async () => {
    const h = setup();
    h.signer.provenanceOverride = { amountAtomic: "999" };
    await h.workflow.acceptIntent(newIntent());

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("none");
    expect(h.broadcaster.broadcasts).toHaveLength(0);
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("RESERVED");
    expect(record!.signedRawTx).toBeNull();
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some((incident) => incident.detail.reason === "signed_provenance_mismatch")
    ).toBe(true);
  });

  it("refuses to broadcast when the broadcaster returns a different hash", async () => {
    const h = setup();
    h.broadcaster.overrideHash = keccak256("0xdeadbeef");
    await h.workflow.acceptIntent(newIntent());

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("malformed");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("PERSISTED");
    const incidents = await h.incidents.listOpen({ kind: "NONCE_CONFLICT" });
    expect(incidents).toHaveLength(1);
  });

  it("fails closed and records evidence when signing throws, without leaking the message", async () => {
    const h = setup();
    h.signer.failWith = new Error("transport http://user:secret@rpc.example/key");
    await h.workflow.acceptIntent(newIntent());

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("none");
    expect(h.broadcaster.broadcasts).toHaveLength(0);
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("RESERVED");
    expect(record!.signedRawTx).toBeNull();
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    const signing = incidents.find((incident) => incident.detail.reason === "signing_failed");
    expect(signing).toBeDefined();
    expect(JSON.stringify(signing!.detail)).not.toContain("secret");
  });
});

describe("WithdrawalWorkflow treasury nonce serialization", () => {
  it("serializes concurrent nonce allocation per (chainId, treasuryAddress)", async () => {
    const h = setup();
    h.quorum.nonce = 5;
    h.signer.delayMs = 5;
    await h.workflow.acceptIntent(newIntent({ intentId: "int_a" }));
    await h.workflow.acceptIntent(newIntent({ intentId: "int_b" }));

    await Promise.all([h.workflow.processIntent("int_a"), h.workflow.processIntent("int_b")]);

    const a = await h.store.get("int_a");
    const b = await h.store.get("int_b");
    expect([a!.treasuryNonce, b!.treasuryNonce].sort((x, y) => Number(x) - Number(y))).toEqual([
      5, 6,
    ]);
    expect(h.signer.calls.map((call) => call.nonce).sort((x, y) => x - y)).toEqual([5, 6]);
    expect(h.broadcaster.broadcasts).toHaveLength(2);
  });

  it("fails closed and does not sign when nonce quorum is unavailable", async () => {
    const h = setup();
    h.quorum.nonceAgreed = false;
    await h.workflow.acceptIntent(newIntent());

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("none");
    expect(h.signer.calls).toHaveLength(0);
    expect(h.broadcaster.broadcasts).toHaveLength(0);
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("RESERVED");
    const incidents = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
    expect(
      incidents.some((incident) => incident.detail.reason === "nonce_quorum_unavailable")
    ).toBe(true);
  });
});

describe("WithdrawalWorkflow ambiguous broadcast recovery", () => {
  it("retains obligation and exact bytes on ambiguous broadcast and re-broadcasts only those bytes", async () => {
    const h = setup();
    h.broadcaster.failCount = 1;
    await h.workflow.acceptIntent(newIntent());

    const first = await h.workflow.processIntent("int_1");
    expect(first.action).toBe("ambiguous");

    let record = await h.store.get("int_1");
    const persistedBytes = record!.signedRawTx;
    const persistedHash = record!.txHash;
    expect(record!.state).toBe("AMBIGUOUS");
    expect(h.accounting.entries).toHaveLength(0); // never refunds

    // Simulate a restart: a fresh workflow shares the durable store.
    const restarted = h.makeWorkflow();
    const second = await restarted.processIntent("int_1");
    expect(second.action).toBe("rebroadcast");

    // Same bytes and hash, no new signing, no new nonce.
    expect(h.broadcaster.broadcasts).toHaveLength(2);
    expect(h.broadcaster.broadcasts[1]).toBe(persistedBytes);
    expect(h.signer.calls).toHaveLength(1);

    record = await h.store.get("int_1");
    expect(record!.txHash).toBe(persistedHash);
    expect(record!.state).toBe("BROADCAST");
  });
});

describe("WithdrawalWorkflow confirmation and finality", () => {
  it("cannot finalize while settlement fails, and retries the same journal obligation", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, `0x${"22".repeat(32)}`);
    h.quorum.blockHeight = 110;
    await h.workflow.processIntent("int_1");
    const complete = h.accounting.completeWithdrawal.bind(h.accounting);
    h.accounting.completeWithdrawal = async () => {
      throw new Error("temporary journal failure");
    };
    await h.workflow.processIntent("int_1");
    await h.workflow.processIntent("int_1");
    expect((await h.store.get("int_1"))?.state).toBe("CONFIRMED");
    expect((await h.store.get("int_1"))?.confirmedJournalId).toBeNull();
    expect(h.accounting.entries).toHaveLength(0);
    h.accounting.completeWithdrawal = complete;
    await h.workflow.processIntent("int_1");
    expect((await h.store.get("int_1"))?.state).toBe("FINALIZED");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);
  });
  it("confirms on quorum receipt at confirmations and finalizes at deepFinality, exactly once", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");

    const blockHash = "0x" + "22".repeat(32);
    h.quorum.receipt = successReceipt(100, blockHash);
    h.quorum.blockHeight = 100;

    let outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("pending_confirmation");
    let record = await h.store.get("int_1");
    expect(record!.receiptBlockNumber).toBe("100");
    expect(record!.receiptBlockHash).toBe(blockHash);

    h.quorum.blockHeight = 102; // confirmations = 3 == asset.confirmations
    outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("confirmed");
    record = await h.store.get("int_1");
    expect(record!.confirmedJournalId).not.toBeNull();
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    // Repeated ticks must not double-post accounting.
    await h.workflow.processIntent("int_1");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    h.quorum.blockHeight = 106; // confirmations = 7 >= deepFinality
    outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("finalized");
    record = await h.store.get("int_1");
    expect(record!.state).toBe("FINALIZED");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);
  });

  it("does not confirm when the receipt Transfer does not match destination/amount/token", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");

    h.quorum.receipt = successReceipt(100, "0x" + "33".repeat(32), [matchingTransfer("999")]);
    h.quorum.blockHeight = 120;

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("blocked_quorum");

    const record = await h.store.get("int_1");
    expect(record!.state).toBe("BROADCAST");
    const asset = await h.assets.get(ASSET_ID);
    expect(asset!.status).toBe("FROZEN");
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(incidents.some((incident) => incident.detail.reason === "transfer_mismatch")).toBe(true);
  });
});

describe("WithdrawalWorkflow frozen routes and gas starvation", () => {
  it("blocks new signing for a non-ACTIVE route while still monitoring signed obligations", async () => {
    const h = setup();
    await h.assets.setStatus(ASSET_ID, "FROZEN", "maintenance");

    await h.workflow.acceptIntent(newIntent({ intentId: "int_blocked" }));
    const blocked = await h.workflow.processIntent("int_blocked");
    expect(blocked.action).toBe("skipped_frozen");
    expect(h.signer.calls).toHaveLength(0);

    // Sign a second obligation while ACTIVE, then freeze and confirm monitoring
    // continues.
    await h.assets.setStatus(ASSET_ID, "ACTIVE", "resume");
    await h.workflow.acceptIntent(newIntent({ intentId: "int_live" }));
    await h.workflow.processIntent("int_live");
    await h.assets.setStatus(ASSET_ID, "FROZEN", "maintenance-2");

    h.quorum.receipt = successReceipt(200, "0x" + "44".repeat(32));
    h.quorum.blockHeight = 200;
    const monitored = await h.workflow.processIntent("int_live");
    expect(monitored.action).toBe("pending_confirmation");
  });

  it("blocks signing on gas starvation, then clears safely when funds are replenished without refund", async () => {
    const h = setup();
    h.quorum.nativeBalanceAtomic = 500n; // below minGasAtomic 1000
    await h.workflow.acceptIntent(newIntent());

    const blocked = await h.workflow.processIntent("int_1");
    expect(blocked.action).toBe("blocked_gas");
    let record = await h.store.get("int_1");
    expect(record!.state).toBe("BLOCKED_GAS");
    expect(h.signer.calls).toHaveLength(0);
    expect(h.accounting.entries).toHaveLength(0);

    const gasIncidents = await h.incidents.listOpen({ kind: "GAS_STARVATION" });
    expect(gasIncidents).toHaveLength(1);

    // Replenish and tick again: the obligation signs, no refund, no new incident.
    h.quorum.nativeBalanceAtomic = 10_000n;
    const cleared = await h.workflow.processIntent("int_1");
    expect(cleared.action).toBe("signed_broadcast");
    expect(h.signer.calls).toHaveLength(1);
    record = await h.store.get("int_1");
    expect(record!.state).toBe("BROADCAST");
  });

  it("fails closed on native gas quorum disagreement", async () => {
    const h = setup();
    h.quorum.nativeAgreed = false;
    await h.workflow.acceptIntent(newIntent());

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("blocked_quorum");
    expect(h.signer.calls).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
    expect(incidents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("WithdrawalWorkflow reorg obligations", () => {
  it("reverses the post-completion obligation exactly once when the exact same payout re-finalizes, without a second settlement", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1"); // PENDING_CONFIRMATION
    h.quorum.blockHeight = 102;
    expect((await h.workflow.processIntent("int_1")).action).toBe("confirmed");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    // Post-completion reorg: obligation restored.
    h.quorum.receipt = null;
    expect((await h.workflow.processIntent("int_1")).action).toBe("reorged");
    let record = await h.store.get("int_1");
    const firstObligationJournal = record!.reorgJournalId;
    expect(firstObligationJournal).not.toBeNull();
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(1);

    // The exact same payout re-includes in a new canonical block and re-finalizes.
    h.quorum.receipt = successReceipt(150, "0x" + "99".repeat(32));
    h.quorum.blockHeight = 150;
    expect((await h.workflow.processIntent("int_1")).action).toBe("pending_confirmation");
    h.quorum.blockHeight = 152;
    expect((await h.workflow.processIntent("int_1")).action).toBe("confirmed");

    record = await h.store.get("int_1");
    expect(record!.state).toBe("CONFIRMED");
    expect(record!.reorgJournalId).toBe(firstObligationJournal);
    const reversals = h.accounting.entries.filter(
      (entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED"
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0].evidence).toMatchObject({
      receiptBlockNumber: "150",
      receiptBlockHash: "0x" + "99".repeat(32),
    });
    // Settlement is never replayed.
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    // Repeated ticks and finality do not reverse or settle again.
    h.quorum.blockHeight = 156;
    expect((await h.workflow.processIntent("int_1")).action).toBe("finalized");
    await h.workflow.processIntent("int_1");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(1);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    // A repeat reorg cycle posts a fresh obligation and a fresh reversal. A
    // finalized record is only scanned by the production runOnce pass.
    h.quorum.receipt = null;
    const repeatPass = await h.workflow.runOnce();
    expect(repeatPass.reorged).toBe(1);
    record = await h.store.get("int_1");
    const secondObligationJournal = record!.reorgJournalId;
    expect(secondObligationJournal).not.toBeNull();
    expect(secondObligationJournal).not.toBe(firstObligationJournal);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(2);

    h.quorum.receipt = successReceipt(200, "0x" + "ab".repeat(32));
    h.quorum.blockHeight = 202;
    await h.workflow.processIntent("int_1");
    expect((await h.workflow.processIntent("int_1")).action).toBe("confirmed");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(2);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);
  });

  it("does not reverse while the re-included payout can still reorg away before re-finalization", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");
    h.quorum.blockHeight = 102;
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = null;
    await h.workflow.processIntent("int_1"); // REORGED + obligation

    // Re-included but not yet deep enough: PENDING_CONFIRMATION, no reversal.
    h.quorum.receipt = successReceipt(150, "0x" + "99".repeat(32));
    h.quorum.blockHeight = 150;
    await h.workflow.processIntent("int_1");
    expect((await h.store.get("int_1"))?.state).toBe("PENDING_CONFIRMATION");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(0);

    // Reorged away again before finality: the original obligation stays
    // outstanding and no second obligation is created.
    h.quorum.receipt = null;
    expect((await h.workflow.processIntent("int_1")).action).toBe("reorged");
    expect((await h.store.get("int_1"))?.state).toBe("REORGED");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(1);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(0);

    // Finally re-included and finalized: exactly one reversal.
    h.quorum.receipt = successReceipt(150, "0x" + "99".repeat(32));
    h.quorum.blockHeight = 152;
    await h.workflow.processIntent("int_1");
    expect((await h.workflow.processIntent("int_1")).action).toBe("confirmed");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(1);
  });

  it("fails closed in PENDING_CONFIRMATION when the obligation reversal fails, then retries safely", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");
    h.quorum.blockHeight = 102;
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = null;
    await h.workflow.processIntent("int_1"); // REORGED + obligation

    h.quorum.receipt = successReceipt(150, "0x" + "99".repeat(32));
    h.quorum.blockHeight = 152;
    await h.workflow.processIntent("int_1"); // PENDING_CONFIRMATION
    const reverse = h.accounting.reverseObligation.bind(h.accounting);
    h.accounting.reverseObligation = async () => {
      throw new Error("temporary ledger failure");
    };
    const blocked = await h.workflow.processIntent("int_1");
    expect(blocked.action).toBe("blocked_reorg_reversal");
    expect((await h.store.get("int_1"))?.state).toBe("PENDING_CONFIRMATION");
    const failures = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      failures.some(
        (incident) => incident.detail.reason === "reorg_reversal_failed_operator_resolution"
      )
    ).toBe(true);

    h.accounting.reverseObligation = reverse;
    expect((await h.workflow.processIntent("int_1")).action).toBe("confirmed");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION_REVERSED")
    ).toHaveLength(1);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);
  });

  it("posts no new cycle when the durable record already advanced past a stale reorg observation", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");
    h.quorum.blockHeight = 102;
    await h.workflow.processIntent("int_1"); // CONFIRMED + settle

    // The durable row is re-included/re-confirmed while the scanning snapshot
    // still shows CONFIRMED with a missing receipt.
    const realGet = h.store.get.bind(h.store);
    let injected = false;
    h.store.get = async (intentId) => {
      const record = await realGet(intentId);
      if (!injected && record?.state === "CONFIRMED" && record.txHash) {
        injected = true;
        return {
          ...record,
          state: "PENDING_CONFIRMATION" as const,
          receiptBlockNumber: "150",
          receiptBlockHash: "0x" + "99".repeat(32),
        };
      }
      return record;
    };
    h.quorum.receipt = null;

    const summary = await h.workflow.runOnce();

    expect(injected).toBe(true);
    expect(summary.reorged).toBe(0);
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(0);
    h.store.get = realGet;
    expect((await h.store.get("int_1"))?.state).toBe("CONFIRMED");
  });

  it("posts no obligation when the REORGED transition CAS loses to a concurrent worker", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");
    h.quorum.blockHeight = 102;
    await h.workflow.processIntent("int_1"); // CONFIRMED + settle

    const realTransition = h.store.transition.bind(h.store);
    let failed = false;
    h.store.transition = async (request) => {
      if (!failed && request.to === "REORGED") {
        failed = true;
        return null;
      }
      return realTransition(request);
    };
    h.quorum.receipt = null;

    const outcome = await h.workflow.processIntent("int_1");

    expect(failed).toBe(true);
    expect(outcome.action).toBe("none");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(0);
    h.store.transition = realTransition;
    expect((await h.store.get("int_1"))?.state).toBe("CONFIRMED");
  });

  it("recovers a missing post-completion obligation from durable receipt evidence", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");
    h.quorum.blockHeight = 102;
    await h.workflow.processIntent("int_1"); // CONFIRMED + settle
    const settled = await h.store.get("int_1");
    expect(settled?.confirmedJournalId).not.toBeNull();

    // Simulate a failed obligation post: REORGED with no pointer.
    await h.store.transition({ intentId: "int_1", from: ["CONFIRMED"], to: "REORGED" });
    expect((await h.store.get("int_1"))?.reorgJournalId).toBeNull();

    const evidence: unknown[] = [];
    const original = h.accounting.recordObligation.bind(h.accounting);
    h.accounting.recordObligation = async (record, incident, reversalEvidence) => {
      evidence.push(reversalEvidence);
      return original(record, incident, reversalEvidence);
    };
    h.quorum.receipt = null;

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("rebroadcast");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(1);
    expect((await h.store.get("int_1"))?.reorgJournalId).not.toBeNull();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      txHash: settled!.txHash,
      priorReceiptBlockNumber: "100",
      priorReceiptBlockHash: "0x" + "66".repeat(32),
    });
  });

  it("pre-completion reorg freezes and preserves history with no second liability", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "55".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");

    // Receipt disappears before completion.
    h.quorum.receipt = null;
    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("reorged");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("REORGED");
    expect(record!.reorgJournalId).toBeNull();
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(0);
    const asset = await h.assets.get(ASSET_ID);
    expect(asset!.status).toBe("FROZEN");
    const incidents = await h.incidents.listOpen({ kind: "WITHDRAWAL_REORG" });
    expect(incidents).toHaveLength(1);
  });

  it("post-completion reorg posts INCIDENT_OBLIGATION exactly once", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "66".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1"); // -> PENDING_CONFIRMATION
    h.quorum.blockHeight = 102; // confirmations == 3 -> CONFIRMED
    await h.workflow.processIntent("int_1");
    let record = await h.store.get("int_1");
    expect(record!.state).toBe("CONFIRMED");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "WITHDRAWAL_CONFIRMED")
    ).toHaveLength(1);

    // Reorg after completion.
    h.quorum.receipt = null;
    const first = await h.workflow.processIntent("int_1");
    expect(first.action).toBe("reorged");
    record = await h.store.get("int_1");
    expect(record!.state).toBe("REORGED");
    expect(record!.reorgJournalId).not.toBeNull();
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(1);

    // A further tick re-broadcasts the exact bytes; no second obligation.
    const second = await h.workflow.processIntent("int_1");
    expect(second.action).toBe("rebroadcast");
    expect(
      h.accounting.entries.filter((entry) => entry.kind === "INCIDENT_OBLIGATION")
    ).toHaveLength(1);
  });

  it("detects a receipt moved to a different block as a reorg", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, "0x" + "77".repeat(32));
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1");

    h.quorum.receipt = successReceipt(101, "0x" + "88".repeat(32));
    h.quorum.blockHeight = 101;
    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("reorged");
  });
});

describe("WithdrawalWorkflow reconciliation", () => {
  it("freezes and raises TREASURY_SHORTFALL on a quorum mismatch", async () => {
    const h = setup();
    h.accounting.expected[ASSET_ID] = "100";
    h.quorum.nativeBalanceAtomic = 60n;

    const outcome = await h.workflow.reconcileAsset(ASSET_ID);

    expect(outcome.mismatch).toBe(true);
    expect(h.accounting.entries.filter((entry) => entry.kind === "RECONCILIATION")).toHaveLength(1);
    const asset = await h.assets.get(ASSET_ID);
    expect(asset!.status).toBe("FROZEN");
    const incidents = await h.incidents.listOpen({ kind: "TREASURY_SHORTFALL" });
    expect(incidents).toHaveLength(1);
  });

  it("records matched evidence without freezing", async () => {
    const h = setup();
    h.accounting.expected[ASSET_ID] = "100";
    h.quorum.nativeBalanceAtomic = 100n;

    const outcome = await h.workflow.reconcileAsset(ASSET_ID);

    expect(outcome.mismatch).toBe(false);
    const asset = await h.assets.get(ASSET_ID);
    expect(asset!.status).toBe("ACTIVE");
  });
});

describe("WithdrawalWorkflow runOnce", () => {
  it("advances signable and monitoring records in one pass", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent({ intentId: "int_x" }));
    h.quorum.receipt = null;

    const summary = await h.workflow.runOnce();

    expect(summary.broadcast).toBeGreaterThanOrEqual(1);
    const record = await h.store.get("int_x");
    expect(record!.state).toBe("BROADCAST");
    expect(record!.signedRawTx).not.toBeNull();
    expect(DESTINATION).not.toBe(OTHER_DESTINATION);
  });

  it("signs multiple records for one account with strictly increasing serialized nonces", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent({ intentId: "int_n1" }));
    await h.workflow.acceptIntent(newIntent({ intentId: "int_n2" }));

    const summary = await h.workflow.runOnce();

    expect(summary.signed).toBe(2);
    expect(h.signer.calls.map((call) => call.nonce)).toEqual([0, 1]);
    const first = await h.store.get("int_n1");
    const second = await h.store.get("int_n2");
    expect(
      [Number(first!.treasuryNonce), Number(second!.treasuryNonce)].sort((a, b) => a - b)
    ).toEqual([0, 1]);
    // The same tick's monitoring lane may re-broadcast the exact bytes (no
    // receipt yet); signing itself must happen exactly once per record.
    expect(h.broadcaster.broadcasts.length).toBeGreaterThanOrEqual(2);
    expect(h.broadcaster.broadcasts[0]).toBe(first!.signedRawTx);
    expect(h.broadcaster.broadcasts[1]).toBe(second!.signedRawTx);
  });

  it("rotates durable scan lanes so a blocked front batch cannot starve later records", async () => {
    const h = setup();
    const workflow = new WithdrawalWorkflow({
      store: h.store,
      incidents: h.incidents,
      assets: h.assets,
      accounting: h.accounting,
      signer: h.signer,
      quorum: h.quorum,
      broadcaster: h.broadcaster,
      clock: h.clock,
      logger: quietLogger(),
      config: { minQuorum: 2, maxScanBatch: 1, maxScanPages: 1 },
    });

    // Two signable records that stay blocked in BLOCKED_GAS on every tick.
    await workflow.acceptIntent(newIntent({ intentId: "int_a" }));
    await workflow.acceptIntent(newIntent({ intentId: "int_b" }));

    // Two monitoring records whose receipt quorum is unavailable.
    for (const id of ["int_c", "int_d"]) {
      await workflow.acceptIntent(newIntent({ intentId: id }));
      await workflow.processIntent(id); // BROADCAST
    }

    h.quorum.nativeBalanceAtomic = 500n; // below ASSET.minGasAtomic 1000
    h.quorum.receiptAgreed = false;
    for (let tick = 0; tick < 2; tick += 1) {
      h.clock.advance(1);
      await workflow.runOnce();
    }

    // Both lanes visited every record despite a one-record batch: a fixed
    // oldest batch would only ever have touched int_a and int_c.
    const gasIncidents = await h.incidents.listOpen({ kind: "GAS_STARVATION" });
    expect(new Set(gasIncidents.map((incident) => incident.intentId))).toEqual(
      new Set(["int_a", "int_b"])
    );
    const rpcIncidents = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
    expect(new Set(rpcIncidents.map((incident) => incident.intentId))).toEqual(
      new Set(["int_c", "int_d"])
    );
  });
});

describe("WithdrawalWorkflow treasury nonce overflow", () => {
  it("fails closed with a durable incident when the next treasury nonce exceeds the safe range", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent({ intentId: "int_overflow" }));
    await h.store.transition({
      intentId: "int_overflow",
      from: ["RESERVED"],
      to: "RESERVED",
      patch: { treasuryNonce: Number.MAX_SAFE_INTEGER },
    });
    h.quorum.nonce = Number.MAX_SAFE_INTEGER;

    const outcome = await h.workflow.processIntent("int_overflow");

    expect(outcome.action).toBe("none");
    expect(h.signer.calls).toHaveLength(0);
    expect(h.broadcaster.broadcasts).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some(
        (incident) => incident.detail.reason === "treasury_nonce_overflow_operator_resolution"
      )
    ).toBe(true);
  });

  it("fails closed with a durable incident when the persisted nonce state is unreadable", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    const original = h.store.maxPersistedTreasuryNonce.bind(h.store);
    h.store.maxPersistedTreasuryNonce = async () => {
      throw new RangeError("WithdrawalIntentRecord.broadcastNonce exceeds safe integer range");
    };

    const outcome = await h.workflow.processIntent("int_1");

    expect(outcome.action).toBe("none");
    expect(h.signer.calls).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some((incident) => incident.detail.reason === "treasury_nonce_state_unreadable")
    ).toBe(true);
    h.store.maxPersistedTreasuryNonce = original;
  });

  it("records a durable incident when the durable scan itself is unreadable", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    h.store.listByStates = async () => {
      throw new RangeError("WithdrawalIntentRecord.broadcastNonce exceeds safe integer range");
    };

    const summary = await h.workflow.runOnce();

    expect(summary.signed).toBe(0);
    expect(h.signer.calls).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(incidents.some((incident) => incident.detail.reason === "scan_failed")).toBe(true);
  });
});

describe("WithdrawalWorkflow canonical block identity", () => {
  const CANONICAL = "0x" + "aa".repeat(32);
  const NON_CANONICAL = "0x" + "bb".repeat(32);

  it("fails closed and freezes when the receipt's block is not canonical before confirmation", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");

    h.quorum.receipt = successReceipt(100, CANONICAL);
    h.quorum.canonicalBlockHash = NON_CANONICAL;
    h.quorum.blockHeight = 100;

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("blocked_quorum");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("BROADCAST");
    const asset = await h.assets.get(ASSET_ID);
    expect(asset!.status).toBe("FROZEN");
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some((incident) => incident.detail.reason === "receipt_block_not_canonical")
    ).toBe(true);
    expect(h.accounting.entries).toHaveLength(0);
  });

  it("treats a canonical block mismatch after confirmation as a reorg", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, CANONICAL);
    h.quorum.blockHeight = 100;
    await h.workflow.processIntent("int_1"); // PENDING_CONFIRMATION
    h.quorum.blockHeight = 102; // confirmations == 3
    const confirmed = await h.workflow.processIntent("int_1");
    expect(confirmed.action).toBe("confirmed");

    // The block at that height is no longer the receipt's block.
    h.quorum.canonicalBlockHash = NON_CANONICAL;
    const reorged = await h.workflow.processIntent("int_1");
    expect(reorged.action).toBe("reorged");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("REORGED");
    expect(record!.reorgJournalId).not.toBeNull();
  });

  it("treats an unavailable canonical-block quorum as an outage, never a reorg", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");
    h.quorum.receipt = successReceipt(100, CANONICAL);
    h.quorum.canonicalBlockAgreed = false;
    h.quorum.blockHeight = 100;

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("blocked_quorum");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("BROADCAST");
    const incidents = await h.incidents.listOpen({ kind: "RPC_DISAGREEMENT" });
    expect(incidents.some((incident) => incident.detail.reason === "canonical_block_quorum")).toBe(
      true
    );
  });
});

describe("WithdrawalWorkflow non-terminal obligations", () => {
  const BLOCK_HASH = "0x" + "cc".repeat(32);

  it("keeps a reverted payout non-terminal with an explicit operator incident", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    await h.workflow.processIntent("int_1");

    h.quorum.receipt = {
      status: "reverted",
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      transfers: [],
    };
    h.quorum.blockHeight = 100;

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("blocked_reverted");
    const record = await h.store.get("int_1");
    expect(record!.state).not.toBe("FAILED");
    expect(record!.signedRawTx).not.toBeNull();
    expect(h.accounting.entries).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some(
        (incident) => incident.detail.reason === "transaction_reverted_operator_resolution"
      )
    ).toBe(true);
  });

  it("keeps an expired reserved intent obligated instead of terminally failing it", async () => {
    const h = setup();
    await h.workflow.acceptIntent(newIntent());
    h.clock.advance(4_000_000); // past the deadline

    const outcome = await h.workflow.processIntent("int_1");
    expect(outcome.action).toBe("expired");
    const record = await h.store.get("int_1");
    expect(record!.state).toBe("RESERVED");
    expect(h.signer.calls).toHaveLength(0);
    expect(h.accounting.entries).toHaveLength(0);
    const incidents = await h.incidents.listOpen({ kind: "CUSTODY_FAILURE" });
    expect(
      incidents.some((incident) => incident.detail.reason === "intent_expired_operator_resolution")
    ).toBe(true);
  });
});
