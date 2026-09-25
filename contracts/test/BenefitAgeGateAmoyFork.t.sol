// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BenefitAgeGate, BenefitAgeGateTestRoot} from "../src/BenefitAgeGate.sol";

/// Runs only with AMOY_RPC_URL set. Uses the verifier already deployed on
/// Amoy, not a local copy.
contract BenefitAgeGateAmoyForkTest is Test {
    string constant ZK = "../zk-age-verifier/";

    function test_deployedAmoyVerifierThroughGates() public {
        string memory rpc = vm.envOr("AMOY_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 80002);

        string memory deployment = vm.readFile(string.concat(ZK, "deployments/amoy.json"));
        address verifier = vm.parseJsonAddress(deployment, ".verifier");
        bytes32 codeHash = vm.parseJsonBytes32(deployment, ".runtimeCodeHash");
        assertEq(verifier.codehash, codeHash, "Amoy verifier matches the recorded deployment");

        bytes memory proof = vm.parseBytes(vm.trim(vm.readFile(string.concat(ZK, "fixtures/synthetic/proof.hex"))));
        string[] memory lines = vm.split(vm.trim(vm.readFile(string.concat(ZK, "fixtures/synthetic/inputs.txt"))), "\n");
        uint256[8] memory inputs;
        for (uint256 i; i < 8; i++) inputs[i] = vm.parseUint(lines[i]);
        bytes32 claimHash = bytes32((inputs[0] << 128) | inputs[1]);
        bytes32 nonce = bytes32((inputs[2] << 128) | inputs[3]);
        bytes32 syntheticRoot = bytes32((inputs[4] << 128) | inputs[5]);

        BenefitAgeGate gate = new BenefitAgeGate(verifier, codeHash);
        BenefitAgeGateTestRoot testGate = new BenefitAgeGateTestRoot(verifier, codeHash, syntheticRoot);
        vm.warp(inputs[6] + 1);

        assertTrue(testGate.verifyClaimAge(claimHash, nonce, inputs[7], proof, inputs), "synthetic proof accepted");
        assertFalse(gate.verifyClaimAge(claimHash, nonce, inputs[7], proof, inputs), "J-LIS gate rejects synthetic root");
        assertFalse(testGate.verifyClaimAge(keccak256("other claim"), nonce, inputs[7], proof, inputs), "other claim rejected");
    }
}
