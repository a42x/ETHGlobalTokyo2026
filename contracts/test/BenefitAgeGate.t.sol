// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvekitGroth16Verifier} from "zk-age-verifier/Verifier.sol";
import {BenefitAgeGate, BenefitAgeGateTestRoot} from "../src/BenefitAgeGate.sol";

contract BenefitAgeGateTest is Test {
    string constant FIXTURES = "../zk-age-verifier/fixtures/synthetic/";

    address verifier;
    bytes proof;
    uint256[8] inputs;
    bytes32 claimHash;
    bytes32 nonce;
    bytes32 syntheticRoot;
    uint256 referenceTime;
    uint256 expiresAt;

    function setUp() public {
        verifier = address(new ProvekitGroth16Verifier());
        proof = vm.parseBytes(vm.trim(vm.readFile(string.concat(FIXTURES, "proof.hex"))));
        string[] memory lines = vm.split(vm.trim(vm.readFile(string.concat(FIXTURES, "inputs.txt"))), "\n");
        assertEq(lines.length, 8);
        for (uint256 i; i < 8; i++) inputs[i] = vm.parseUint(lines[i]);
        claimHash = bytes32((inputs[0] << 128) | inputs[1]);
        nonce = bytes32((inputs[2] << 128) | inputs[3]);
        syntheticRoot = bytes32((inputs[4] << 128) | inputs[5]);
        referenceTime = inputs[6];
        expiresAt = inputs[7];
        vm.warp(referenceTime + 1);
    }

    function testGate() internal returns (BenefitAgeGateTestRoot) {
        return new BenefitAgeGateTestRoot(verifier, verifier.codehash, syntheticRoot);
    }

    function test_testRootGateAcceptsSyntheticProof() public {
        assertTrue(testGate().verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs));
    }

    function test_productionGateRejectsSyntheticRoot() public {
        BenefitAgeGate gate = new BenefitAgeGate(verifier, verifier.codehash);
        assertFalse(gate.verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs));
    }

    function test_testRootGateRejectsOtherRoot() public {
        BenefitAgeGateTestRoot gate = new BenefitAgeGateTestRoot(verifier, verifier.codehash, keccak256("other root"));
        assertFalse(gate.verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs));
    }

    function test_rejectsProofForAnotherClaim() public {
        bytes32 otherClaim = keccak256(abi.encode(block.chainid, address(1), bytes32("benefit"), address(2), 500e18, 20));
        assertFalse(testGate().verifyClaimAge(otherClaim, nonce, expiresAt, proof, inputs));
    }

    function test_rejectsClaimHashSwappedIntoInputs() public {
        BenefitAgeGateTestRoot gate = testGate();
        bytes32 otherClaim = keccak256("claim for a different recipient");
        uint256[8] memory swapped = inputs;
        swapped[0] = uint256(otherClaim) >> 128;
        swapped[1] = uint128(uint256(otherClaim));
        assertFalse(gate.verifyClaimAge(otherClaim, nonce, expiresAt, proof, swapped));
    }

    function test_rejectsOtherNonce() public {
        assertFalse(testGate().verifyClaimAge(claimHash, keccak256("nonce"), expiresAt, proof, inputs));
    }

    function test_rejectsExpiredProof() public {
        BenefitAgeGateTestRoot gate = testGate();
        vm.warp(expiresAt);
        assertFalse(gate.verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs));
    }

    function test_rejectsProofBeforeReferenceTime() public {
        BenefitAgeGateTestRoot gate = testGate();
        vm.warp(referenceTime - 1);
        assertFalse(gate.verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs));
    }

    function test_rejectsOtherExpiry() public {
        assertFalse(testGate().verifyClaimAge(claimHash, nonce, expiresAt + 1, proof, inputs));
    }

    function test_rejectsTamperedProof() public {
        bytes memory tampered = proof;
        tampered[0] = bytes1(uint8(tampered[0]) ^ 1);
        assertFalse(testGate().verifyClaimAge(claimHash, nonce, expiresAt, tampered, inputs));
    }

    function test_rejectsWrongProofLength() public {
        assertFalse(testGate().verifyClaimAge(claimHash, nonce, expiresAt, bytes.concat(proof, hex"00"), inputs));
    }

    function test_constructorRejectsOtherChain() public {
        vm.chainId(5042002);
        vm.expectRevert(BenefitAgeGate.UnsupportedChain.selector);
        new BenefitAgeGate(verifier, verifier.codehash);
    }

    function test_constructorAcceptsAmoy() public {
        vm.chainId(80002);
        assertEq(new BenefitAgeGate(verifier, verifier.codehash).verifier(), verifier);
    }

    function test_constructorRejectsWrongCodeHash() public {
        vm.expectRevert(BenefitAgeGate.InvalidVerifier.selector);
        new BenefitAgeGate(verifier, keccak256("not the verifier"));
    }

    function test_constructorRejectsZeroTestRoot() public {
        vm.expectRevert(BenefitAgeGateTestRoot.InvalidTestRoot.selector);
        new BenefitAgeGateTestRoot(verifier, verifier.codehash, bytes32(0));
    }
}
