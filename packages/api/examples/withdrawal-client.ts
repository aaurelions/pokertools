/**
 * Example: request a withdrawal with the canonical EIP-712 intent flow.
 *
 * Chain value is denominated in per-asset atomic decimal strings, never chips
 * and never cents. The client:
 *   1. reads the supported assets and its per-asset balances,
 *   2. builds a canonical `WithdrawalIntent` (amount as an atomic decimal
 *      string derived from the asset's `decimals`),
 *   3. signs the fixed EIP-712 typed data with the wallet, and
 *   4. submits `{ intent, signature }` for verification/reservation.
 *
 * The API never hand-builds a withdrawal message and neither should a client:
 * all signing input comes from `createWithdrawalTypedData`.
 */

import {
  PokerClient,
  createWithdrawalTypedData,
  bigIntToAtomicAmount,
  atomicAmountToBigInt,
  type Eip712Domain,
  type WithdrawalIntent,
  type WithdrawalRecord,
} from "@pokertools/sdk";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Configuration
const API_BASE_URL = "http://localhost:3000";
const PRIVATE_KEY = process.env.PRIVATE_KEY!; // Your wallet private key
const JWT_TOKEN = process.env.JWT_TOKEN!; // Your authentication token

// The custody/treasury contract that verifies withdrawal signatures for the
// selected chain. This is deployment configuration supplied out-of-band.
const VERIFYING_CONTRACT = process.env.WITHDRAWAL_VERIFYING_CONTRACT!;

// Withdrawal parameters, in whole asset units (converted using asset.decimals)
const WITHDRAWAL_AMOUNT = "100"; // 100 USDC
const ASSET_SYMBOL = "USDC";
const DESTINATION_ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const TERMINAL_SUCCESS = new Set(["CONFIRMED", "FINALIZED"]);
const TERMINAL_FAILURE = new Set(["FAILED", "REORGED"]);

async function requestWithdrawal() {
  console.log("🔐 Initializing canonical withdrawal request...\n");

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  console.log(`Wallet Address: ${account.address}`);

  const client = new PokerClient({ baseUrl: API_BASE_URL, token: JWT_TOKEN });

  // 1. Select the asset. Amounts are atomic decimal strings.
  console.log("\n🌐 Fetching supported assets...");
  const assets = await client.getAssets();
  const asset = assets.find((candidate) => candidate.symbol === ASSET_SYMBOL);
  if (!asset) {
    throw new Error(`${ASSET_SYMBOL} asset not found`);
  }
  console.log(`Selected: ${asset.symbol} (${asset.assetId})`);

  // 2. Check the available balance for that asset (canonical atomic string).
  console.log("\n📊 Checking balance...");
  const balances = await client.getBalances();
  const balance = balances.find((candidate) => candidate.assetId === asset.assetId);
  if (!balance) {
    throw new Error(`No ${asset.symbol} balance found`);
  }

  const amountAtomic = bigIntToAtomicAmount(parseUnits(WITHDRAWAL_AMOUNT, asset.decimals));
  const availableAtomic = atomicAmountToBigInt(balance.availableAtomic);
  console.log(`Available: ${balance.availableAtomic} atomic units`);

  if (availableAtomic < BigInt(amountAtomic)) {
    throw new Error(
      `Insufficient balance. Available: ${balance.availableAtomic}, requested: ${amountAtomic}`
    );
  }

  // 3. Build the canonical intent. The API rebuilds the signed payload from it.
  console.log("\n✍️  Signing canonical EIP-712 withdrawal intent...");
  const intent: WithdrawalIntent = {
    intentId: crypto.randomUUID(),
    principalId: balance.principalId,
    assetId: asset.assetId,
    destination: DESTINATION_ADDRESS.toLowerCase() as `0x${string}`,
    amountAtomic,
    // Unique per intent; a real client persists and monotonically advances this.
    nonce: Date.now(),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    chainId: asset.chainId,
  };

  const domain: Eip712Domain = {
    // The name and version are fixed by the shared withdrawal contract.
    name: "PokerTools Withdrawal",
    version: "1",
    chainId: asset.chainId,
    verifyingContract: VERIFYING_CONTRACT.toLowerCase() as `0x${string}`,
  };

  const typedData = createWithdrawalTypedData(intent, domain);
  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  } as never); // viem's generic typed-data input is narrower than the wire shape
  console.log(`Signature: ${signature.slice(0, 20)}...${signature.slice(-20)}`);

  // 4. Submit the signed submission. The server verifies and reserves funds.
  console.log("\n📤 Submitting withdrawal intent...");
  const withdrawal = await client.submitWithdrawal({ intent, signature });
  console.log("\n✅ Withdrawal intent reserved!");
  console.log(`Intent: ${withdrawal.intentId}`);
  console.log(`Status: ${withdrawal.status}`);
  console.log(`Amount: ${withdrawal.amountAtomic} atomic units`);
  console.log(`Destination: ${withdrawal.destination}`);

  await monitorWithdrawal(client, withdrawal.intentId);
}

async function monitorWithdrawal(client: PokerClient, intentId: string) {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const withdrawal: WithdrawalRecord = await client.getWithdrawal(intentId);
    console.log(`\nStatus: ${withdrawal.status}`);

    if (TERMINAL_SUCCESS.has(withdrawal.status)) {
      console.log("✅ Withdrawal finalized!");
      console.log(`Transaction Hash: ${withdrawal.txHash ?? "pending"}`);
      return;
    }
    if (TERMINAL_FAILURE.has(withdrawal.status)) {
      console.log(`❌ Withdrawal ${withdrawal.status.toLowerCase()}`);
      return;
    }

    console.log("Waiting for custody confirmation...");
    attempts++;
  }

  if (attempts >= maxAttempts) {
    console.log(`\n⏱️  Monitoring timeout. Check GET /finance/withdrawals/${intentId}`);
  }
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!PRIVATE_KEY || !JWT_TOKEN || !VERIFYING_CONTRACT) {
    console.error(
      "❌ Error: PRIVATE_KEY, JWT_TOKEN and WITHDRAWAL_VERIFYING_CONTRACT environment variables are required"
    );
    console.log("\nUsage:");
    console.log(
      "  PRIVATE_KEY=0x... JWT_TOKEN=eyJ... WITHDRAWAL_VERIFYING_CONTRACT=0x... tsx examples/withdrawal-client.ts"
    );
    process.exit(1);
  }

  requestWithdrawal()
    .then(() => {
      console.log("\n🎉 Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error:", error.message);
      process.exit(1);
    });
}

export { requestWithdrawal };
