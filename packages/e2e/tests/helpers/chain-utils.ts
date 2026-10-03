import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_PUBLIC_PRIVATE_KEY } from "../fixtures/anvil-public-key.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Standard Anvil Private Key #0
export const DEPLOYER_PK = ANVIL_PUBLIC_PRIVATE_KEY;
export const ANVIL_PORT = 8545;
export const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

// Test mnemonic (deterministic, local-only, never used in production)
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

export const localChain = defineChain({
  id: 31337,
  name: "Anvil Local",
  network: "anvil-local",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: [ANVIL_RPC] },
    public: { http: [ANVIL_RPC] },
  },
  blockExplorers: {
    default: { name: "Local Explorer", url: "http://localhost:4000" },
  },
});

export const publicClient: PublicClient = createPublicClient({
  chain: localChain,
  transport: http(ANVIL_RPC),
});

export const walletClient: WalletClient<
  ReturnType<typeof http>,
  typeof localChain,
  ReturnType<typeof privateKeyToAccount>
> = createWalletClient({
  chain: localChain,
  transport: http(ANVIL_RPC),
  account: privateKeyToAccount(DEPLOYER_PK),
});

let anvilProcess: ChildProcess | null = null;

export async function startAnvil(): Promise<void> {
  if (anvilProcess) return;

  return new Promise<void>((resolve) => {
    anvilProcess = spawn(
      "anvil",
      ["--host", "0.0.0.0", "--port", String(ANVIL_PORT), "--block-time", "1"],
      {
        stdio: "ignore",
        detached: false,
      }
    );
    // Give Anvil time to start up
    setTimeout(() => resolve(), 1500);
  });
}

export async function stopAnvil(): Promise<void> {
  if (anvilProcess) {
    anvilProcess.kill("SIGTERM");
    anvilProcess = null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface DeployedContracts {
  usdcAddress: Address;
}

export async function deployContracts(): Promise<DeployedContracts> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const contractsDir = path.resolve(__dirname, "../../../custody/contracts/out");

  const usdcArtifactPath = path.join(contractsDir, "MockUSDC.sol/MockUSDC.json");

  if (!fs.existsSync(usdcArtifactPath)) {
    throw new Error(
      `MockUSDC artifact not found at ${usdcArtifactPath}. Run 'forge build' in packages/custody first.`
    );
  }

  const usdcArtifact = JSON.parse(fs.readFileSync(usdcArtifactPath, "utf8"));

  // Deploy MockUSDC. The canonical finance path credits via direct treasury
  // claims and does not require the optional BatchSweeper contract, so the
  // obsolete sweeper deploy bootstrap was removed.
  const usdcHash = await walletClient.deployContract({
    abi: usdcArtifact.abi,
    bytecode: usdcArtifact.bytecode.object,
    account: walletClient.account,
    args: [],
  });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcHash });
  const usdcAddress = usdcReceipt.contractAddress!;

  return { usdcAddress };
}
