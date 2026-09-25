// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BenefitAgeGateJpkiTest} from "../src/BenefitAgeGate.sol";

contract DeployJpkiTestGate is Script {
    function run() external {
        string memory deployment = vm.readFile("../zk-age-verifier/deployments/amoy.json");
        address verifier = vm.parseJsonAddress(deployment, ".verifier");
        bytes32 codeHash = vm.parseJsonBytes32(deployment, ".runtimeCodeHash");
        vm.startBroadcast();
        BenefitAgeGateJpkiTest gate = new BenefitAgeGateJpkiTest(verifier, codeHash);
        vm.stopBroadcast();
        console.log("BenefitAgeGateJpkiTest", address(gate));
    }
}
