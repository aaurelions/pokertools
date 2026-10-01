import { spawn, ChildProcess } from "child_process";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Standard Anvil Private Key #0
export const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ANVIL_PORT = 8545;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

export const localChain = defineChain({
  id: 31337,
  name: "Anvil",
  network: "anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [ANVIL_RPC] }, public: { http: [ANVIL_RPC] } },
});

let anvilProcess: ChildProcess | null = null;

export async function startAnvil() {
  if (anvilProcess) return;

  await new Promise<void>((resolve) => {
    anvilProcess = spawn("anvil", ["--port", "8545", "--block-time", "1"], {
      stdio: "ignore",
      detached: false,
    });

    setTimeout(() => resolve(), 1000);
  });

  await (publicClient.request as (args: { method: string }) => Promise<unknown>)({
    method: "anvil_reset",
  });
}

export async function stopAnvil() {
  if (anvilProcess) {
    anvilProcess.kill();
    anvilProcess = null;
  }
}

import fs from "fs";
import path from "path";

export async function deployContracts() {
  const usdcArtifactPath = path.join(process.cwd(), "contracts/out/MockUSDC.sol/MockUSDC.json");
  const usdcArtifact = JSON.parse(fs.readFileSync(usdcArtifactPath, "utf8"));

  const sweeperArtifactPath = path.join(
    process.cwd(),
    "contracts/out/BatchSweeper.sol/BatchSweeper.json"
  );
  const sweeperArtifact = JSON.parse(fs.readFileSync(sweeperArtifactPath, "utf8"));

  // 1. Deploy MockUSDC
  const usdcHash = await walletClient.deployContract({
    abi: usdcArtifact.abi,
    bytecode: usdcArtifact.bytecode.object,
    account: walletClient.account,
    args: [],
  });

  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcHash });
  const usdcAddress = usdcReceipt.contractAddress!;

  const sweeperHash = await walletClient.deployContract({
    abi: sweeperArtifact.abi,
    bytecode: sweeperArtifact.bytecode.object,
    account: walletClient.account,
    args: [walletClient.account.address],
  });

  const sweeperReceipt = await publicClient.waitForTransactionReceipt({ hash: sweeperHash });
  const sweeperAddress = sweeperReceipt.contractAddress!;

  return { usdcAddress, sweeperAddress };
}

export const publicClient: PublicClient<Transport, Chain> = createPublicClient({
  chain: localChain,
  transport: http(ANVIL_RPC),
});

export const walletClient: WalletClient<Transport, Chain, Account> = createWalletClient({
  chain: localChain,
  transport: http(ANVIL_RPC),
  account: privateKeyToAccount(DEPLOYER_PK),
});
