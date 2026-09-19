// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";
import {ArbiterRegistry} from "../src/ArbiterRegistry.sol";

/**
 * @title Deploy — ArbiterRegistry → Escrow → wiring.
 *
 * Local (anvil):
 *   anvil
 *   forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast
 *
 * Base Sepolia:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 * The printed addresses go straight into the backend .env:
 *   CHAIN_MODE=real CHAIN_ID=84532 ESCROW_ADDRESS=... ARBITER_REGISTRY_ADDRESS=...
 */
contract Deploy is Script {
    function run() external returns (ArbiterRegistry registry, Escrow escrow) {
        vm.startBroadcast();

        registry = new ArbiterRegistry("EscrowLance Arbiter", "ELARB", msg.sender);
        escrow = new Escrow(registry, msg.sender);
        registry.setEscrow(address(escrow));

        vm.stopBroadcast();

        console2.log("ARBITER_REGISTRY_ADDRESS=%s", address(registry));
        console2.log("ESCROW_ADDRESS=%s", address(escrow));
        console2.log("DEPLOYER=%s (admin/owner)", msg.sender);
    }
}
