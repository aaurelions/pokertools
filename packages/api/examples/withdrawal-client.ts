/**
 * Example: How to request a withdrawal with signature verification
 *
 * This example demonstrates the complete flow for withdrawing funds
 * from the poker platform to an external Ethereum address.
 */

import { privateKeyToAccount } from 'viem/accounts';

// Configuration
const API_BASE_URL = 'http://localhost:3000';
const PRIVATE_KEY = process.env.PRIVATE_KEY!; // Your wallet private key
const JWT_TOKEN = process.env.JWT_TOKEN!; // Your authentication token

// Withdrawal parameters
const WITHDRAWAL_AMOUNT = 100; // $100 USD
const DESTINATION_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function requestWithdrawal() {
  console.log('🔐 Initializing withdrawal request...\n');

  // 1. Create account from private key
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  console.log(`Wallet Address: ${account.address}`);

  // 2. Check current balance
  console.log('\n📊 Checking balance...');
  const balanceResponse = await fetch(`${API_BASE_URL}/user/me`, {
    headers: {
      'Authorization': `Bearer ${JWT_TOKEN}`,
    },
  });

  if (!balanceResponse.ok) {
    throw new Error(`Failed to get balance: ${balanceResponse.statusText}`);
  }

  const balanceData = await balanceResponse.json();
  const availableBalance = balanceData.balances.main / 100; // Convert cents to dollars
  console.log(`Available Balance: $${availableBalance.toFixed(2)}`);

  if (availableBalance < WITHDRAWAL_AMOUNT) {
    throw new Error(`Insufficient balance. Available: $${availableBalance}, Requested: $${WITHDRAWAL_AMOUNT}`);
  }

  // 3. Get available blockchains and tokens
  console.log('\n🌐 Fetching blockchain options...');
  const chainsResponse = await fetch(`${API_BASE_URL}/finance/chains`);
  const chains = await chainsResponse.json();

  // Find Polygon and USDC (or use your preferred chain/token)
  const polygon = chains.find((c: any) => c.name === 'Polygon');
  if (!polygon) {
    throw new Error('Polygon blockchain not found');
  }

  const usdc = polygon.tokens.find((t: any) => t.symbol === 'USDC');
  if (!usdc) {
    throw new Error('USDC token not found');
  }

  console.log(`Selected: ${polygon.name} - ${usdc.symbol}`);

  // 4. Create and sign the withdrawal message
  console.log('\n✍️  Signing withdrawal message...');
  const message = `Withdraw ${WITHDRAWAL_AMOUNT} USD to ${DESTINATION_ADDRESS}`;
  console.log(`Message: "${message}"`);

  const signature = await account.signMessage({ message });
  console.log(`Signature: ${signature.slice(0, 20)}...${signature.slice(-20)}`);

  // 5. Submit withdrawal request
  console.log('\n📤 Submitting withdrawal request...');
  const withdrawalResponse = await fetch(`${API_BASE_URL}/user/withdraw`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: WITHDRAWAL_AMOUNT,
      blockchainId: polygon.id,
      tokenId: usdc.id,
      address: DESTINATION_ADDRESS,
      message,
      signature,
    }),
  });

  if (!withdrawalResponse.ok) {
    const error = await withdrawalResponse.json();
    throw new Error(`Withdrawal failed: ${JSON.stringify(error, null, 2)}`);
  }

  const withdrawal = await withdrawalResponse.json();
  console.log('\n✅ Withdrawal request successful!');
  console.log(`ID: ${withdrawal.id}`);
  console.log(`Status: ${withdrawal.status}`);
  console.log(`Amount: $${withdrawal.amount}`);
  console.log(`Destination: ${withdrawal.destination}`);
  console.log(`Message: ${withdrawal.message}`);

  // 6. Monitor withdrawal status
  console.log('\n👀 Monitoring withdrawal status...');
  await monitorWithdrawal(withdrawal.id);
}

async function monitorWithdrawal(withdrawalId: string) {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

    const response = await fetch(`${API_BASE_URL}/user/withdrawals`, {
      headers: {
        'Authorization': `Bearer ${JWT_TOKEN}`,
      },
    });

    const data = await response.json();
    const withdrawal = data.withdrawals.find((w: any) => w.id === withdrawalId);

    if (!withdrawal) {
      console.log(`Attempt ${attempts + 1}: Withdrawal not found in history yet...`);
      attempts++;
      continue;
    }

    console.log(`\nStatus: ${withdrawal.status}`);

    if (withdrawal.status === 'CONFIRMED') {
      console.log('✅ Withdrawal confirmed!');
      console.log(`Transaction Hash: ${withdrawal.txHash}`);
      console.log(`Explorer: ${withdrawal.explorerUrl}`);
      break;
    } else if (withdrawal.status === 'FAILED') {
      console.log('❌ Withdrawal failed on blockchain');
      break;
    } else if (withdrawal.status === 'REJECTED') {
      console.log('❌ Withdrawal rejected by admin');
      break;
    } else {
      console.log(`Waiting for admin approval... (${withdrawal.status})`);
    }

    attempts++;
  }

  if (attempts >= maxAttempts) {
    console.log('\n⏱️  Monitoring timeout. Check status manually via /user/withdrawals');
  }
}

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!PRIVATE_KEY || !JWT_TOKEN) {
    console.error('❌ Error: PRIVATE_KEY and JWT_TOKEN environment variables are required');
    console.log('\nUsage:');
    console.log('  PRIVATE_KEY=0x... JWT_TOKEN=eyJ... tsx examples/withdrawal-client.ts');
    process.exit(1);
  }

  requestWithdrawal()
    .then(() => {
      console.log('\n🎉 Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Error:', error.message);
      process.exit(1);
    });
}

export { requestWithdrawal };
