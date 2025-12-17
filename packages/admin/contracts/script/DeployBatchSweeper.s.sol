// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BatchSweeper} from "../src/BatchSweeper.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract DeployBatchSweeper is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        console.log("Deploying BatchSweeper with account:", deployerAddress);

        vm.startBroadcast(deployerPrivateKey);

        BatchSweeper sweeper = new BatchSweeper(deployerAddress);
        console.log("BatchSweeper deployed to:", address(sweeper));

        // Deploy MockUSDC for testing
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC deployed to:", address(usdc));

        vm.stopBroadcast();
    }
}
