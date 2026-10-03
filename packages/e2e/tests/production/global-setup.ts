/**
 * Production-container acceptance global setup.
 *
 * Runs against the disposable compose project prepared by
 * `scripts/run-production-acceptance.sh`:
 *
 *  1. starts two independent loopback JSON-RPC proxies in front of the
 *     isolated Anvil node (distinct URLs for the canonical ChainRegistry
 *     quorum),
 *  2. deploys the real MockUSDC fixture with the public, valueless Anvil
 *     account zero,
 *  3. starts the real `docker-compose.prod.yml` topology (postgres, redis,
 *     api, worker, custody) with the generated test-only overlay,
 *  4. discovers the random loopback API/PostgreSQL ports and writes a private
 *     handoff for the test process.
 *
 * Teardown removes the compose project including its named volumes and closes
 * the proxies. The runner script's trap is the crash-safe backstop.
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startQuorumProxies, type ProxySet } from "../finance/helpers/quorum-proxy.js";
import { ANVIL_PUBLIC_PRIVATE_KEY } from "../fixtures/anvil-public-key.js";
import {
  redact,
  runCompose,
  sleep,
  waitFor,
  workDir,
  type ProductionHandoff,
} from "./helpers/prod-harness.js";

let proxies: ProxySet | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for production acceptance`);
  return value;
}

async function resolvePublishedPort(service: string, containerPort: number): Promise<number> {
  const output = await runCompose(["port", service, String(containerPort)]);
  const match = output.trim().match(/:(\d+)\s*$/);
  if (!match) {
    throw new Error(`Unable to resolve published port for ${service}:${containerPort}`);
  }
  return Number(match[1]);
}

async function waitForApiHealth(apiBase: string, timeoutMs: number): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${apiBase}/health`);
        return response.ok;
      } catch {
        return false;
      }
    },
    timeoutMs,
    500,
    "API health"
  );
}

export async function setup(): Promise<void> {
  const project = requiredEnv("PT_PROD_ACCEPT_PROJECT");
  const image = requiredEnv("PT_PROD_ACCEPT_IMAGE");
  const anvilRpc = requiredEnv("PT_PROD_ACCEPT_ANVIL_RPC");
  const work = workDir();

  const chain = defineChain({
    id: 31337,
    name: "Anvil Production Acceptance",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcUrls: { default: { http: [anvilRpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(anvilRpc) });
  const treasuryAccount = privateKeyToAccount(ANVIL_PUBLIC_PRIVATE_KEY);
  const treasuryWallet = createWalletClient({
    chain,
    transport: http(anvilRpc),
    account: treasuryAccount,
  });

  // Two distinct same-chain endpoints satisfy the canonical registry topology
  // rule; both forward to the real isolated Anvil node.
  proxies = await startQuorumProxies(anvilRpc, 2);

  console.log("[prod-accept] Deploying MockUSDC fixture to isolated Anvil...");
  const artifact = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../custody/contracts/out/MockUSDC.sol/MockUSDC.json"
      ),
      "utf8"
    )
  ) as { abi: unknown[]; bytecode: { object: `0x${string}` } };
  const deployHash = await treasuryWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [],
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const usdcAddress = deployReceipt.contractAddress;
  if (!usdcAddress) throw new Error("MockUSDC deployment produced no contract address");

  console.log(`[prod-accept] Starting compose project ${project} (${image})...`);
  try {
    await runCompose(["up", "-d", "postgres", "redis", "api", "worker", "custody"], {
      timeoutMs: 420_000,
    });
  } catch (error) {
    const ps = await runCompose(["ps"], { allowFailure: true, timeoutMs: 30_000 });
    const logs = await runCompose(["logs", "--no-color", "--tail", "80", "api", "custody"], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    console.error(
      redact(`[prod-accept] compose ps:\n${ps}\n[prod-accept] api/custody logs:\n${logs}`)
    );
    throw error;
  }

  const apiPort = await resolvePublishedPort("api", 3000);
  const pgPort = await resolvePublishedPort("postgres", 5432);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitForApiHealth(apiBase, 180_000);

  const handoff: ProductionHandoff = {
    project,
    workDir: work,
    image,
    apiBase,
    wsUrl: `ws://127.0.0.1:${apiPort}/ws/play`,
    pg: {
      host: "127.0.0.1",
      port: pgPort,
      user: requiredEnv("PT_PROD_ACCEPT_PG_USER"),
      password: requiredEnv("PT_PROD_ACCEPT_PG_PASSWORD"),
      database: requiredEnv("PT_PROD_ACCEPT_PG_DATABASE"),
    },
    chain: {
      chainId: 31337,
      anvilRpc,
      usdcAddress,
      treasuryAddress: treasuryAccount.address,
      treasuryPrivateKey: ANVIL_PUBLIC_PRIVATE_KEY,
      containerRpcUrls: proxies.proxies.map((proxy) => proxy.hostUrl),
      hostRpcUrls: proxies.proxies.map((proxy) => proxy.url),
    },
    compose: {
      base: requiredEnv("PT_PROD_ACCEPT_COMPOSE_BASE"),
      overlay: requiredEnv("PT_PROD_ACCEPT_OVERLAY"),
      envFile: requiredEnv("PT_PROD_ACCEPT_COMPOSE_ENV"),
    },
  };
  fs.writeFileSync(path.join(work, "handoff.json"), JSON.stringify(handoff, null, 2), {
    mode: 0o600,
  });
  // Give the API one extra health confirmation after the handoff so the first
  // test never observes a mid-restart listener.
  await sleep(250);
  console.log(`[prod-accept] API ready at ${apiBase} (postgres 127.0.0.1:${pgPort})`);
}

export async function teardown(): Promise<void> {
  await runCompose(["down", "-v", "--remove-orphans"], {
    timeoutMs: 180_000,
    allowFailure: true,
  }).catch(() => undefined);
  if (proxies) {
    await proxies.close().catch(() => undefined);
    proxies = undefined;
  }
}
