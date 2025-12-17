// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BatchSweeper} from "../src/BatchSweeper.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract BatchSweeperTest is Test {
    BatchSweeper public sweeper;
    MockUSDC public usdc;

    address public hotWallet;
    uint256 public hotWalletKey;

    address public user1;
    uint256 public user1Key;

    address public user2;
    uint256 public user2Key;

    address public user3;
    uint256 public user3Key;

    function setUp() public {
        // Set up hot wallet (sweeper operator)
        hotWalletKey = 0x1;
        hotWallet = vm.addr(hotWalletKey);

        // Set up user wallets
        user1Key = 0x2;
        user1 = vm.addr(user1Key);

        user2Key = 0x3;
        user2 = vm.addr(user2Key);

        user3Key = 0x4;
        user3 = vm.addr(user3Key);

        // Deploy contracts
        sweeper = new BatchSweeper(hotWallet);
        usdc = new MockUSDC();

        // Mint USDC to user wallets (simulating deposits)
        usdc.mint(user1, 100e6); // 100 USDC
        usdc.mint(user2, 50e6);  // 50 USDC
        usdc.mint(user3, 25e6);  // 25 USDC
    }

    function testBatchSweep() public {
        // Prepare batch arrays
        address[] memory owners = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        uint256[] memory deadlines = new uint256[](3);
        uint8[] memory v = new uint8[](3);
        bytes32[] memory r = new bytes32[](3);
        bytes32[] memory s = new bytes32[](3);

        owners[0] = user1;
        owners[1] = user2;
        owners[2] = user3;

        amounts[0] = 100e6;
        amounts[1] = 50e6;
        amounts[2] = 25e6;

        // Set deadline to 1 hour from now
        uint256 deadline = block.timestamp + 1 hours;
        deadlines[0] = deadline;
        deadlines[1] = deadline;
        deadlines[2] = deadline;

        // Generate permits for each user
        (v[0], r[0], s[0]) = _getPermitSignature(
            user1Key,
            address(sweeper),
            amounts[0],
            0, // nonce
            deadline
        );

        (v[1], r[1], s[1]) = _getPermitSignature(
            user2Key,
            address(sweeper),
            amounts[1],
            0, // nonce
            deadline
        );

        (v[2], r[2], s[2]) = _getPermitSignature(
            user3Key,
            address(sweeper),
            amounts[2],
            0, // nonce
            deadline
        );

        // Execute batch sweep as hot wallet
        vm.prank(hotWallet);
        sweeper.batchSweep(
            address(usdc),
            owners,
            amounts,
            deadlines,
            v,
            r,
            s
        );

        // Verify balances
        assertEq(usdc.balanceOf(user1), 0, "User1 should have 0 balance");
        assertEq(usdc.balanceOf(user2), 0, "User2 should have 0 balance");
        assertEq(usdc.balanceOf(user3), 0, "User3 should have 0 balance");
        assertEq(usdc.balanceOf(hotWallet), 175e6, "Hot wallet should have 175 USDC");
        assertEq(usdc.balanceOf(address(sweeper)), 0, "Sweeper should have 0 balance");
    }

    function testBatchSweepArrayLengthMismatch() public {
        address[] memory owners = new address[](2);
        uint256[] memory amounts = new uint256[](3); // Mismatch
        uint256[] memory deadlines = new uint256[](2);
        uint8[] memory v = new uint8[](2);
        bytes32[] memory r = new bytes32[](2);
        bytes32[] memory s = new bytes32[](2);

        vm.prank(hotWallet);
        vm.expectRevert(BatchSweeper.ArrayLengthMismatch.selector);
        sweeper.batchSweep(
            address(usdc),
            owners,
            amounts,
            deadlines,
            v,
            r,
            s
        );
    }

    function testRescueToken() public {
        // Send tokens to sweeper by mistake
        usdc.mint(address(sweeper), 100e6);

        assertEq(usdc.balanceOf(address(sweeper)), 100e6);

        // Rescue as owner
        vm.prank(hotWallet);
        sweeper.rescueToken(address(usdc), 100e6);

        assertEq(usdc.balanceOf(address(sweeper)), 0);
        assertEq(usdc.balanceOf(hotWallet), 100e6);
    }

    function testRescueETH() public {
        // Send ETH to sweeper
        vm.deal(address(sweeper), 1 ether);

        assertEq(address(sweeper).balance, 1 ether);

        uint256 hotWalletBalanceBefore = hotWallet.balance;

        // Rescue as owner
        vm.prank(hotWallet);
        sweeper.rescueEth(1 ether);

        assertEq(address(sweeper).balance, 0);
        assertEq(hotWallet.balance, hotWalletBalanceBefore + 1 ether);
    }

    // Helper function to generate EIP-2612 permit signatures
    function _getPermitSignature(
        uint256 privateKey,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                vm.addr(privateKey),
                spender,
                value,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                structHash
            )
        );

        (v, r, s) = vm.sign(privateKey, digest);
    }
}
