// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvekitGroth16Verifier} from "zk-age-verifier/Verifier.sol";
import {BenefitAgeGateJpkiTest} from "../src/BenefitAgeGate.sol";

contract JpkiTestRootProbe is BenefitAgeGateJpkiTest {
    constructor(address verifier_, bytes32 codeHash) BenefitAgeGateJpkiTest(verifier_, codeHash) {}

    function rootValid(bytes32 rootHash, uint256 start, uint256 end) external pure returns (bool) {
        return _rootValid(rootHash, start, end);
    }
}

contract BenefitAgeGateJpkiTestTest is Test {
    JpkiTestRootProbe probe;
    address verifier;

    function setUp() public {
        verifier = address(new ProvekitGroth16Verifier());
        probe = new JpkiTestRootProbe(verifier, verifier.codehash);
    }

    function test_acceptsEachTestRootInsideItsValidity() public view {
        assertTrue(probe.rootValid(0x8a0336e52507e05b637f095492aee59d3d78823981bf9054ff28a93b727afa47, 1790000000, 1790000900));
        assertTrue(probe.rootValid(0x7b3b001af9630b60d7bc356383e0223e554785ddde24692953371a219eea7021, 1790000000, 1790000900));
        assertTrue(probe.rootValid(0x5b189b626b422dee7067e63d729b7c682f0fa30eed909a2537b95134f3c3f75d, 1790000000, 1790000900));
        assertTrue(probe.rootValid(0x91a09ca3b8f065d5462ef8e6a807d77612fc9db055af7f7769457e349595b5d1, 1790000000, 1790000900));
    }

    function test_rejectsWindowsOutsideRootValidity() public view {
        assertFalse(probe.rootValid(0x8a0336e52507e05b637f095492aee59d3d78823981bf9054ff28a93b727afa47, 1867676000, 1867676400));
        assertFalse(probe.rootValid(0x91a09ca3b8f065d5462ef8e6a807d77612fc9db055af7f7769457e349595b5d1, 1724883818, 1724884718));
    }

    function test_rejectsProductionJlisAndSyntheticRoots() public view {
        assertFalse(probe.rootValid(0xa5fad04a2d6cbb52ce03a55106a6e23be4fa4a771bb0bf81401833afc410b15e, 1790000000, 1790000900));
        assertFalse(probe.rootValid(0x9ec2093f1d4c86f0e22cd2b45140428437eba9591e979fa688428b71c241011c, 1790000000, 1790000900));
        assertFalse(probe.rootValid(0x856b48145522368c129f328bf5de7d9ecd104b333116b134eabffc505ee17e91, 1790000000, 1790000900));
    }

    function test_expiredTestRootsAreNotAccepted() public view {
        assertFalse(probe.rootValid(0x6543596415f591ae000000000000000000000000000000000000000000000000, 1700000000, 1700000900));
    }

    function test_rejectsSyntheticFixtureProof() public {
        string memory fixtures = "../zk-age-verifier/fixtures/synthetic/";
        bytes memory proof = vm.parseBytes(vm.trim(vm.readFile(string.concat(fixtures, "proof.hex"))));
        string[] memory lines = vm.split(vm.trim(vm.readFile(string.concat(fixtures, "inputs.txt"))), "\n");
        uint256[8] memory inputs;
        for (uint256 i; i < 8; i++) inputs[i] = vm.parseUint(lines[i]);
        vm.warp(inputs[6] + 1);
        assertFalse(
            probe.verifyClaimAge(
                bytes32((inputs[0] << 128) | inputs[1]), bytes32((inputs[2] << 128) | inputs[3]), inputs[7], proof, inputs
            )
        );
    }
}
