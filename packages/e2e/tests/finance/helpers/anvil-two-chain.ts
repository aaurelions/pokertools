/**
 * Real, isolated two-chain Anvil harness for finance/custody acceptance.
 *
 * Chain 31337 (port 8545) carries a 6-decimal ERC20 (the existing in-tree
 * MockUSDC compile). Chain 31338 (port 8546) carries an 18-decimal ERC20
 * (test-only MockAssetToken compile). Both chains are real local EVM nodes;
 * every balance, transfer, log and reorg in the acceptance suite is produced
 * by an actual transaction, never by direct DB credit.
 *
 * Artifacts come from `packages/custody/contracts/out` (run
 * `npm run contracts:build -w @pokertools/custody` first). The 18-decimal
 * token source lives at
 * `packages/custody/contracts/test/acceptance/MockAssetToken.sol`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { ANVIL_PUBLIC_PRIVATE_KEY } from "../../fixtures/anvil-public-key.js";

export const CHAIN_A_ID = 31337;
export const CHAIN_B_ID = 31338;
export const CHAIN_A_PORT = 8545;
export const CHAIN_B_PORT = 8546;
export const CHAIN_A_RPC = `http://127.0.0.1:${CHAIN_A_PORT}`;
export const CHAIN_B_RPC = `http://127.0.0.1:${CHAIN_B_PORT}`;

/** Public, valueless Anvil test mnemonic. NEVER fund on a real network. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function burn(uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function batchTransfer(address[] to, uint256[] amounts)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface LocalChain {
  chainId: number;
  port: number;
  rpcUrl: string;
  chain: Chain;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  /** Account index 0 = deployer / treasury (funded with native gas by Anvil). */
  treasuryAccount: HDAccount;
}

export interface DeployedToken {
  address: Address;
  symbol: string;
  decimals: number;
}

let chainA: LocalChain | null = null;
let chainB: LocalChain | null = null;
const processes: ChildProcess[] = [];

function anvilBinary(): string {
  return process.env.ANVIL_BIN ?? "anvil";
}

function defineAnvilChain(chainId: number, port: number): Chain {
  const rpcUrl = `http://127.0.0.1:${port}`;
  return defineChain({
    id: chainId,
    name: `Anvil ${chainId}`,
    network: `anvil-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
  });
}

export function makeChain(chainId: number, port: number): LocalChain {
  const chain = defineAnvilChain(chainId, port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
  return {
    chainId,
    port,
    rpcUrl,
    chain,
    treasuryAccount: account,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    testClient: createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) }),
  };
}

export function getAccount(index: number): HDAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

export function walletFor(chain: LocalChain, accountIndex: number) {
  const account = getAccount(accountIndex);
  return createWalletClient({ chain: chain.chain, transport: http(chain.rpcUrl), account });
}

async function rpcChainId(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    return json.result ? Number.parseInt(json.result, 16) : null;
  } catch {
    return null;
  }
}

/** Wait until an RPC reports the expected chain id (fresh Anvil can take ~1s). */
export async function waitForChain(rpcUrl: string, chainId: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await rpcChainId(rpcUrl)) === chainId) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Anvil at ${rpcUrl} did not report chain ${chainId} within ${timeoutMs}ms`);
}

function spawnAnvil(chainId: number, port: number): ChildProcess {
  const child = spawn(
    anvilBinary(),
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--mnemonic",
      ANVIL_MNEMONIC,
      // Fund enough accounts that acceptance wallets (e.g. index 11+) can pay
      // native gas for their own transfers, not just receive tokens.
      "--accounts",
      "20",
      // No block-time: tests mine deterministically via evm_mine/snapshot.
      "--silent",
    ],
    { stdio: "ignore", detached: false }
  );
  child.on("error", () => undefined);
  return child;
}

/**
 * Start both chains if they are not already serving the expected chain ids.
 * Idempotent within a process; safe to call from a vitest global setup and
 * from an individual test that runs without one.
 */
export async function startTwoChainAnvil(): Promise<{ chainA: LocalChain; chainB: LocalChain }> {
  if (chainA && chainB) return { chainA, chainB };

  if ((await rpcChainId(CHAIN_A_RPC)) !== CHAIN_A_ID) {
    processes.push(spawnAnvil(CHAIN_A_ID, CHAIN_A_PORT));
  }
  if ((await rpcChainId(CHAIN_B_RPC)) !== CHAIN_B_ID) {
    processes.push(spawnAnvil(CHAIN_B_ID, CHAIN_B_PORT));
  }

  await Promise.all([waitForChain(CHAIN_A_RPC, CHAIN_A_ID), waitForChain(CHAIN_B_RPC, CHAIN_B_ID)]);

  chainA = makeChain(CHAIN_A_ID, CHAIN_A_PORT);
  chainB = makeChain(CHAIN_B_ID, CHAIN_B_PORT);
  return { chainA, chainB };
}

export async function stopTwoChainAnvil(): Promise<void> {
  for (const child of processes.splice(0)) {
    child.kill("SIGTERM");
  }
  chainA = null;
  chainB = null;
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * Re-attach to already-running chains (started by global setup or a sibling
 * process) without spawning. Fails loudly if the endpoints are not live.
 */
export async function attachTwoChainAnvil(): Promise<{ chainA: LocalChain; chainB: LocalChain }> {
  await Promise.all([waitForChain(CHAIN_A_RPC, CHAIN_A_ID), waitForChain(CHAIN_B_RPC, CHAIN_B_ID)]);
  chainA = chainA ?? makeChain(CHAIN_A_ID, CHAIN_A_PORT);
  chainB = chainB ?? makeChain(CHAIN_B_ID, CHAIN_B_PORT);
  return { chainA, chainB };
}

// ---------------------------------------------------------------------------
// Contract deployment (real bytecode from the in-tree Foundry compile)
// ---------------------------------------------------------------------------

function loadArtifact(contract: string): { abi: readonly unknown[]; bytecode: Hex } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const artifactPath = path.resolve(
    here,
    `../../../../custody/contracts/out/${contract}.sol/${contract}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Missing Foundry artifact ${artifactPath}. ` +
        `Run: npm run contracts:build -w @pokertools/custody`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    abi: readonly unknown[];
    bytecode: { object: Hex } | Hex;
  };
  const bytecode =
    typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode.object;
  if (!bytecode || bytecode === "0x") {
    throw new Error(`Artifact ${contract} has no deployable bytecode`);
  }
  return { abi: artifact.abi, bytecode };
}

export async function deployMockUsdc6(chain: LocalChain): Promise<DeployedToken> {
  const { abi, bytecode } = loadArtifact("MockUSDC");
  const wallet = walletFor(chain, 0);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [],
    account: wallet.account!,
    chain: chain.chain,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockUSDC deployment produced no address");
  return { address: receipt.contractAddress, symbol: "USDC", decimals: 6 };
}

export async function deployMockAssetToken(
  chain: LocalChain,
  symbol = "mDAI",
  decimals = 18
): Promise<DeployedToken> {
  const { abi, bytecode } = loadArtifact("MockAssetToken");
  const wallet = walletFor(chain, 0);
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [`Mock ${symbol}`, symbol, decimals],
    account: wallet.account!,
    chain: chain.chain,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockAssetToken deployment produced no address");
  return { address: receipt.contractAddress, symbol, decimals };
}

export async function deployMockAssetToken18(chain: LocalChain): Promise<DeployedToken> {
  return deployMockAssetToken(chain, "mDAI", 18);
}

export async function mintToken(
  chain: LocalChain,
  token: Address,
  to: Address,
  amount: bigint,
  minterIndex = 0
) {
  const wallet = walletFor(chain, minterIndex);
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "mint",
    args: [to, amount],
    account: wallet.account!,
    chain: chain.chain,
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

export async function transferToken(
  chain: LocalChain,
  token: Address,
  fromIndex: number,
  to: Address,
  amount: bigint
): Promise<TransactionReceipt> {
  const wallet = walletFor(chain, fromIndex);
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
    account: wallet.account!,
    chain: chain.chain,
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

/** One treasury transaction that emits one ERC20 Transfer log per recipient. */
export async function batchTransferFromTreasury(
  chain: LocalChain,
  token: Address,
  recipients: Address[],
  amounts: bigint[]
): Promise<TransactionReceipt> {
  if (recipients.length !== amounts.length) {
    throw new Error("recipients/amounts length mismatch");
  }
  const wallet = walletFor(chain, 0);
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "batchTransfer",
    args: [recipients, amounts],
    account: wallet.account!,
    chain: chain.chain,
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

/** One transaction from `fromIndex` that emits one ERC20 Transfer log per recipient. */
export async function batchTransferFrom(
  chain: LocalChain,
  token: Address,
  fromIndex: number,
  recipients: Address[],
  amounts: bigint[]
): Promise<TransactionReceipt> {
  if (recipients.length !== amounts.length) {
    throw new Error("recipients/amounts length mismatch");
  }
  const wallet = walletFor(chain, fromIndex);
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "batchTransfer",
    args: [recipients, amounts],
    account: wallet.account!,
    chain: chain.chain,
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

export async function readTokenBalance(
  chain: LocalChain,
  token: Address,
  owner: Address
): Promise<bigint> {
  return chain.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function readTokenDecimals(chain: LocalChain, token: Address): Promise<number> {
  return Number(
    await chain.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "decimals",
    })
  );
}

// ---------------------------------------------------------------------------
// Exact log identity
// ---------------------------------------------------------------------------

export interface TransferLogMatch {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address;
  value: bigint;
}

export interface TransferLogFilter {
  from?: Address;
  to?: Address;
  value?: bigint;
  logIndex?: number;
}

/** Find *exact* canonical ERC20 Transfer logs emitted by one receipt. */
export function findTransferLogs(
  receipt: TransactionReceipt,
  token: Address,
  filter: TransferLogFilter = {}
): TransferLogMatch[] {
  const matches: TransferLogMatch[] = [];
  receipt.logs.forEach((log: Log) => {
    if (log.address.toLowerCase() !== token.toLowerCase()) return;
    let decoded: { eventName: string; args: { from: Address; to: Address; value: bigint } };
    try {
      decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName: string; args: { from: Address; to: Address; value: bigint } };
    } catch {
      return;
    }
    if (decoded.eventName !== "Transfer") return;
    const { from, to, value } = decoded.args;
    if (!from || !to) return;
    if (filter.from && from.toLowerCase() !== filter.from.toLowerCase()) return;
    if (filter.to && to.toLowerCase() !== filter.to.toLowerCase()) return;
    if (filter.value !== undefined && value !== filter.value) return;
    if (log.logIndex === null) throw new Error("Receipt log is missing its block-global logIndex");
    if (filter.logIndex !== undefined && log.logIndex !== filter.logIndex) return;
    matches.push({
      txHash: log.transactionHash!,
      // viem exposes `logIndex` on receipt logs; absolute index within the block.
      logIndex: log.logIndex,
      blockNumber: log.blockNumber!,
      blockHash: log.blockHash!,
      from,
      to,
      value,
    });
  });
  return matches;
}

// ---------------------------------------------------------------------------
// Deterministic block production / reorg control
// ---------------------------------------------------------------------------

export async function mine(chain: LocalChain, blocks = 1): Promise<void> {
  await chain.testClient.mine({ blocks });
}

export async function snapshot(chain: LocalChain): Promise<Hex> {
  const id = await chain.testClient.snapshot();
  return id as Hex;
}

export async function revertSnapshot(chain: LocalChain, id: Hex): Promise<void> {
  await chain.testClient.revert({ id });
}

export async function setNextBlockTimestamp(chain: LocalChain, seconds: number): Promise<void> {
  await chain.testClient.setNextBlockTimestamp({ timestamp: BigInt(seconds) });
}

export async function setNativeBalance(
  chain: LocalChain,
  address: Address,
  wei: bigint
): Promise<void> {
  await chain.testClient.setBalance({ address, value: wei });
}

export async function getNativeBalance(chain: LocalChain, address: Address): Promise<bigint> {
  return chain.publicClient.getBalance({ address });
}

export const ANVIL_ACCOUNT_ZERO_KEY = ANVIL_PUBLIC_PRIVATE_KEY;
