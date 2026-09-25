// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvekitGroth16Verifier} from "zk-age-verifier/Verifier.sol";
import {BenefitAgeGateTestRoot} from "../src/BenefitAgeGate.sol";
import {BenefitOffice, IClaimAgeGate, IERC20Like} from "../src/BenefitOffice.sol";

contract TestToken is IERC20Like {
    mapping(address => uint256) public balanceOf;
    bool public failTransfers;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Accepts exactly one (claimHash, nonce, expiresAt) triple.
contract StubGate is IClaimAgeGate {
    bytes32 public acceptedClaim;
    bytes32 public acceptedNonce;
    uint256 public acceptedExpiry;

    function accept(bytes32 claimHash, bytes32 nonce, uint256 expiresAt) external {
        (acceptedClaim, acceptedNonce, acceptedExpiry) = (claimHash, nonce, expiresAt);
    }

    function verifyClaimAge(bytes32 claimHash, bytes32 nonce, uint256 expiresAt, bytes calldata, uint256[8] calldata)
        external
        view
        returns (bool)
    {
        return claimHash == acceptedClaim && nonce == acceptedNonce && expiresAt == acceptedExpiry;
    }
}

contract BenefitOfficeTest is Test {
    bytes32 constant YOUTH = keccak256("youth-support-2026");
    uint256 constant AMOUNT = 500e18;
    bytes32 constant NONCE = keccak256("nonce");
    uint256 constant EXPIRES = 2_000_000_000;

    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    TestToken jpyc;
    StubGate gate;
    BenefitOffice office;
    bytes proof = new bytes(384);
    uint256[8] inputs;

    event BenefitPaid(bytes32 indexed benefitId, address indexed recipient, bytes32 claimHash, uint256 amountWei);

    function setUp() public {
        jpyc = new TestToken();
        gate = new StubGate();
        office = new BenefitOffice(jpyc, gate, operator);
        office.registerBenefit(YOUTH, AMOUNT, 20);
        jpyc.mint(address(office), 10_000e18);
    }

    function acceptFor(address recipient) internal {
        gate.accept(office.claimHashOf(YOUTH, recipient), NONCE, EXPIRES);
    }

    function claimAs(address caller, address recipient) internal {
        vm.prank(caller);
        office.claim(YOUTH, recipient, NONCE, EXPIRES, proof, inputs);
    }

    function test_claimHashMatchesWorker() public {
        assertEq(YOUTH, 0xab7d61ea757e2ca73a35cce44be9780742454bff7d5121d9ffe96a134c3ef529);
        vm.chainId(80002);
        deployCodeTo("BenefitOffice.sol:BenefitOffice", abi.encode(address(jpyc), address(gate), operator), address(0xAA));
        vm.prank(address(this));
        BenefitOffice(address(0xAA)).registerBenefit(YOUTH, AMOUNT, 20);
        assertEq(
            BenefitOffice(address(0xAA)).claimHashOf(YOUTH, address(0xBB)),
            0x4aadeccb12600868c6ebceb2136f8e71852ee6b0f4f6c827474455003275a2a4
        );
    }

    function test_claimPaysOnce() public {
        acceptFor(alice);
        bytes32 claimHash = office.claimHashOf(YOUTH, alice);
        vm.expectEmit(address(office));
        emit BenefitPaid(YOUTH, alice, claimHash, AMOUNT);
        claimAs(operator, alice);
        assertEq(jpyc.balanceOf(alice), 500e18);
        assertEq(jpyc.balanceOf(address(office)), 9_500e18);
        assertTrue(office.paid(YOUTH, alice));
    }

    function test_secondClaimReverts() public {
        acceptFor(alice);
        claimAs(operator, alice);
        vm.expectRevert(BenefitOffice.AlreadyPaid.selector);
        claimAs(operator, alice);
        assertEq(jpyc.balanceOf(alice), 500e18);
        assertEq(jpyc.balanceOf(address(office)), 9_500e18);
    }

    function test_rejectedProofPaysNothing() public {
        vm.expectRevert(BenefitOffice.ProofRejected.selector);
        claimAs(operator, alice);
        assertFalse(office.paid(YOUTH, alice));
        assertEq(jpyc.balanceOf(alice), 0);
    }

    function test_proofForOneRecipientCannotPayAnother() public {
        acceptFor(alice);
        vm.expectRevert(BenefitOffice.ProofRejected.selector);
        claimAs(operator, bob);
        claimAs(operator, alice);
        assertEq(jpyc.balanceOf(bob), 0);
        assertEq(jpyc.balanceOf(alice), 500e18);
    }

    function test_registerRejectsOtherMinAgeZeroAmountAndStrangers() public {
        vm.expectRevert(BenefitOffice.UnsupportedMinAge.selector);
        office.registerBenefit(keccak256("senior-2026"), 1000e18, 65);
        vm.expectRevert(BenefitOffice.ZeroAmount.selector);
        office.registerBenefit(keccak256("welcome-2026"), 0, 20);
        vm.prank(alice);
        vm.expectRevert(BenefitOffice.NotOwner.selector);
        office.registerBenefit(keccak256("welcome-2026"), 100e18, 20);
        assertEq(office.benefitAmount(keccak256("senior-2026")), 0);
        assertEq(office.benefitAmount(keccak256("welcome-2026")), 0);
    }

    function test_onlyCurrentOperatorClaims() public {
        acceptFor(alice);
        vm.expectRevert(BenefitOffice.NotOperator.selector);
        claimAs(alice, alice);

        address next = makeAddr("next operator");
        office.setOperator(next);
        vm.expectRevert(BenefitOffice.NotOperator.selector);
        claimAs(operator, alice);
        claimAs(next, alice);
        assertEq(jpyc.balanceOf(alice), 500e18);

        vm.expectRevert(BenefitOffice.ZeroAddress.selector);
        office.setOperator(address(0));
        vm.prank(alice);
        vm.expectRevert(BenefitOffice.NotOwner.selector);
        office.setOperator(alice);
    }

    event PaidReset(bytes32 indexed benefitId, address indexed recipient);

    function test_ownerResetLetsTheSameWalletClaimAgain() public {
        acceptFor(alice);
        claimAs(operator, alice);
        vm.expectRevert(BenefitOffice.AlreadyPaid.selector);
        claimAs(operator, alice);

        vm.expectEmit(address(office));
        emit PaidReset(YOUTH, alice);
        office.resetPaid(YOUTH, alice);
        assertFalse(office.paid(YOUTH, alice));

        claimAs(operator, alice);
        assertEq(jpyc.balanceOf(alice), 1_000e18);
        assertEq(jpyc.balanceOf(address(office)), 9_000e18);
        assertTrue(office.paid(YOUTH, alice));
    }

    function test_onlyOwnerCanResetPaid() public {
        acceptFor(alice);
        claimAs(operator, alice);
        vm.prank(operator);
        vm.expectRevert(BenefitOffice.NotOwner.selector);
        office.resetPaid(YOUTH, alice);
        vm.prank(alice);
        vm.expectRevert(BenefitOffice.NotOwner.selector);
        office.resetPaid(YOUTH, alice);
        assertTrue(office.paid(YOUTH, alice));
    }

    function test_unknownBenefitReverts() public {
        vm.prank(operator);
        vm.expectRevert(BenefitOffice.UnknownBenefit.selector);
        office.claim(keccak256("unknown"), alice, NONCE, EXPIRES, proof, inputs);
    }

    function test_withdrawOnlyOwner() public {
        office.withdraw(1_000e18);
        assertEq(jpyc.balanceOf(address(this)), 1_000e18);
        assertEq(jpyc.balanceOf(address(office)), 9_000e18);
        vm.prank(alice);
        vm.expectRevert(BenefitOffice.NotOwner.selector);
        office.withdraw(1);
    }

    function test_failedTransferLeavesClaimUnpaid() public {
        acceptFor(alice);
        jpyc.setFailTransfers(true);
        vm.expectRevert(BenefitOffice.TransferFailed.selector);
        claimAs(operator, alice);
        assertFalse(office.paid(YOUTH, alice));
    }

    function test_officeBindsItsOwnClaimHashWithRealVerifier() public {
        string memory fixtures = "../zk-age-verifier/fixtures/synthetic/";
        bytes memory fixtureProof = vm.parseBytes(vm.trim(vm.readFile(string.concat(fixtures, "proof.hex"))));
        string[] memory lines = vm.split(vm.trim(vm.readFile(string.concat(fixtures, "inputs.txt"))), "\n");
        uint256[8] memory fixtureInputs;
        for (uint256 i; i < 8; i++) fixtureInputs[i] = vm.parseUint(lines[i]);
        bytes32 fixtureClaim = bytes32((fixtureInputs[0] << 128) | fixtureInputs[1]);
        bytes32 fixtureNonce = bytes32((fixtureInputs[2] << 128) | fixtureInputs[3]);
        bytes32 fixtureRoot = bytes32((fixtureInputs[4] << 128) | fixtureInputs[5]);

        address verifier = address(new ProvekitGroth16Verifier());
        BenefitAgeGateTestRoot realGate = new BenefitAgeGateTestRoot(verifier, verifier.codehash, fixtureRoot);
        BenefitOffice realOffice = new BenefitOffice(jpyc, IClaimAgeGate(address(realGate)), operator);
        realOffice.registerBenefit(YOUTH, AMOUNT, 20);
        jpyc.mint(address(realOffice), AMOUNT);
        vm.warp(fixtureInputs[6] + 1);

        assertTrue(realGate.verifyClaimAge(fixtureClaim, fixtureNonce, fixtureInputs[7], fixtureProof, fixtureInputs));
        vm.prank(operator);
        vm.expectRevert(BenefitOffice.ProofRejected.selector);
        realOffice.claim(YOUTH, alice, fixtureNonce, fixtureInputs[7], fixtureProof, fixtureInputs);
        assertEq(jpyc.balanceOf(alice), 0);
    }
}
