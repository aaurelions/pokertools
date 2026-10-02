// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockAssetToken
 * @notice Test-only mintable ERC20 with configurable decimals.
 *
 * This is a Foundry *test* fixture. It intentionally lives under
 * `contracts/test/` (not `contracts/src/`) so it never ships as custody
 * implementation. It exists because the only compiled in-tree mock
 * (`MockUSDC`) is hard-coded to 6 decimals; acceptance requires a second
 * asset with 18 decimals. Forge compiles it during `forge build`, and the
 * artifact is consumed by the finance acceptance harness.
 */
contract MockAssetToken is ERC20 {
    uint8 private immutable TOKEN_DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        TOKEN_DECIMALS = decimals_;
    }

    function decimals() public view virtual override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    /// @notice Mint tokens to any address (test only).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn tokens from the caller (test only).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Emit one ERC20 Transfer log per recipient in a single transaction.
     * @dev Used to prove exact (txHash, logIndex) claim identity when one
     * treasury transaction credits multiple deposits.
     */
    function batchTransfer(address[] calldata recipients, uint256[] calldata amounts) external {
        require(recipients.length == amounts.length, "length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _transfer(msg.sender, recipients[i], amounts[i]);
        }
    }
}
