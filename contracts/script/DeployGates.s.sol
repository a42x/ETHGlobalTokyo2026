// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BenefitAgeGate, BenefitAgeGateTestRoot} from "../src/BenefitAgeGate.sol";

/// Deploys the J-LIS gate and the synthetic-root demo gate against the
/// verifier recorded in zk-age-verifier/deployments/amoy.json.
contract DeployGates is Script {
    function run() external {
        string memory deployment = vm.readFile("../zk-age-verifier/deployments/amoy.json");
        address verifier = vm.parseJsonAddress(deployment, ".verifier");
        bytes32 codeHash = vm.parseJsonBytes32(deployment, ".runtimeCodeHash");
        string[] memory lines =
            vm.split(vm.trim(vm.readFile("../zk-age-verifier/fixtures/synthetic/inputs.txt")), "\n");
        bytes32 syntheticRoot = bytes32((vm.parseUint(lines[4]) << 128) | vm.parseUint(lines[5]));

        vm.startBroadcast();
        BenefitAgeGate gate = new BenefitAgeGate(verifier, codeHash);
        BenefitAgeGateTestRoot testGate = new BenefitAgeGateTestRoot(verifier, codeHash, syntheticRoot);
        vm.stopBroadcast();

        console.log("BenefitAgeGate", address(gate));
        console.log("BenefitAgeGateTestRoot", address(testGate));
    }
}
