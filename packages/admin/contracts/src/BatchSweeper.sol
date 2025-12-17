// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BatchSweeper
 * @notice Batches EIP-2612 Permit signatures and TransferFrom calls to save gas.
 * @dev Funds are always sent to msg.sender to prevent redirection.
 */
contract BatchSweeper is Ownable {
    using SafeERC20 for IERC20;

    error ArrayLengthMismatch();

    event BatchSwept(address indexed token, uint256 count, uint256 totalAmount);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /**
     * @notice Sweep a single token from multiple users in one transaction.
     * @param token The ERC20 token address.
     * @param owners List of user wallet addresses.
     * @param amounts Amounts to sweep per user.
     * @param deadlines Permit deadlines.
     * @param v ECDSA recovery id.
     * @param r ECDSA signature output.
     * @param s ECDSA signature output.
     */
    function batchSweep(
        address token,
        address[] calldata owners,
        uint256[] calldata amounts,
        uint256[] calldata deadlines,
        uint8[] calldata v,
        bytes32[] calldata r,
        bytes32[] calldata s
    ) external {
        uint256 length = owners.length;

        if (
            amounts.length != length ||
            deadlines.length != length ||
            v.length != length ||
            r.length != length ||
            s.length != length
        ) {
            revert ArrayLengthMismatch();
        }

        uint256 totalSwept = 0;

        // Optimization: unchecked increment for gas savings
        for (uint256 i = 0; i < length;) {
            // 1. Permit (Gas is paid by Hot Wallet, signature from User Wallet)
            IERC20Permit(token).permit(
                owners[i],
                address(this),
                amounts[i],
                deadlines[i],
                v[i],
                r[i],
                s[i]
            );

            // 2. Transfer to Caller (Hot Wallet)
            IERC20(token).safeTransferFrom(
                owners[i],
                msg.sender,
                amounts[i]
            );

            totalSwept += amounts[i];

            unchecked { ++i; }
        }

        emit BatchSwept(token, length, totalSwept);
    }

    /**
     * @notice Emergency rescue for tokens sent to this contract by mistake.
     */
    function rescueToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Emergency rescue for ETH sent to this contract.
     */
    function rescueEth(uint256 amount) external onlyOwner {
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");
    }
}
