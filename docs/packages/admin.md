# @pokertools/admin

Private blockchain administration service: sweep permits, broadcast withdrawals,
monitor receipts, manage gas and approve operations over Telegram.

## Services

| Service              | Responsibility                                                          |
| :------------------- | :---------------------------------------------------------------------- |
| `BlockchainService`  | RPC clients, chain config, gas estimation                               |
| `HDWalletManager`    | BIP-32/BIP-39 wallets, xpub-only address derivation, encrypted secrets  |
| `NonceManager`       | Per-address nonce coordination                                          |
| `SweeperService`     | ERC-2612 permit batch sweeps via `BatchSweeper`                         |
| `WithdrawalBot`      | Telegram operator approvals and recovery scans                          |
| `TransactionMonitor` | Receipt polling: marks withdrawals `CONFIRMED` or refunds reverted ones |
| `GasMonitor`         | Chain gas tracking and alerts                                           |
| `RefundService`      | Transactional refunds of reverted broadcasts                            |

## BatchSweeper contract

The `BatchSweeper` contract batches EIP-2612 permit signatures and `transferFrom` calls to
save gas.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BatchSweeper} from "contracts/src/BatchSweeper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Owner redeems N permit signatures and forwards tokens to itself.
function sweep(
    BatchSweeper sweeper,
    IERC20 token,
    address[] calldata owners,
    uint256[] calldata amounts,
    uint256[] calldata deadlines,
    uint8[] calldata v,
    bytes32[] calldata r,
    bytes32[] calldata s
) external {
    sweeper.batchSweep(token, owners, amounts, deadlines, v, r, s);
}
```

| Property | Behavior                                                                    |
| :------- | :-------------------------------------------------------------------------- |
| Access   | `batchSweep` is **`onlyOwner`** — permits cannot be replayed by an attacker |
| Payout   | Proceeds always go to the contract owner                                    |
| Permit   | Standard EIP-2612 `(owner, spender, value, deadline, nonce)`                |
| Arrays   | `owners/amounts/deadlines/v/r/s` must match in length                       |
| Rescue   | `rescueToken` / `rescueETH` for stuck funds                                 |

::: danger
The deployed contract is **not upgradeable**. Deploy this corrected source and configure
the sweep operator as owner **before** use; older deployments keep their original
authorization behavior.
:::

### Testing

```bash
cd packages/admin/contracts
forge test          # 5 tests, incl. copied-permit theft attempt
```

## Withdrawal lifecycle

```text
User request (signed) ──► API validates & holds PENDING_WITHDRAWAL
        │
        ▼
Admin operator approves (Telegram) ──► broadcast tx ──► HOUSE_RESERVE credited
        │
        ├── success ──────────────► CONFIRMED
        └── reverted ─────────────► REFUND (claim-once transaction)
                                        ├── debit recorded reserve entries
                                        ├── credit MAIN
                                        └── balanced REFUND ledger entries
```

Security properties of the refund path:

- `PROCESSING → FAILED` is claimed with `updateMany` — competing monitors cannot double-refund
- Refunds verify the original `broadcast-complete` reserve ledger entries match `amountCredit`
  **before** debiting; missing/insufficient entries roll the claim back for investigation
- Refunds never consume another withdrawal's pending hold

## Configuration

| Variable                                        | Purpose                        |
| :---------------------------------------------- | :----------------------------- |
| `RPC_URLS` / chain keys                         | Per-chain RPC endpoints        |
| `MASTER_MNEMONIC`                               | HD wallet seed                 |
| `WALLET_XPRIV_ENCRYPTION_SECRET`                | Encrypts derived xprvs at rest |
| `SWEEPER_OWNER`                                 | Contract owner hot wallet      |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` | Operator approvals             |
| `TRANSACTION_MONITOR_INTERVAL_MS`               | Receipt poll cadence           |
| `GAS_MONITOR_INTERVAL_MS` / thresholds          | Gas alerts                     |

## Notes

- Receipt monitoring only scans `type = WITHDRAWAL` transactions and guards the
  `PROCESSING →` transition with `updateMany`, so concurrent monitors cannot double-confirm
- A failed scan logs and retries on the next interval instead of stopping the loop
- Ledger entries record every broadcast stage (`broadcast-complete`, refunds as `REFUND`),
  keeping the accounting auditable
