// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title MockUSDC
 * @notice ERC20 token with Permit for testing the sweeper system
 */
contract MockUSDC is ERC20, ERC20Permit {
    uint8 private immutable DECIMALS;

    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {
        DECIMALS = 6;
    }

    function decimals() public view virtual override returns (uint8) {
        return DECIMALS;
    }

    /**
     * @notice Mint tokens to any address (for testing)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from sender
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
