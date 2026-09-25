// SPDX-License-Identifier: Apache-2.0
// Adapted from ZeroKeyMate contracts/src/MateAgeGate.sol (Apache-2.0).
pragma solidity ^0.8.24;

interface IAgeGroth16Verifier {
    function verifyProof(bytes calldata proof, uint256[8] calldata inputs) external view;
}

/// Testnet-only age check for a benefit claim. The caller supplies its own
/// recomputed claim hash, not a hash chosen by the prover.
/// It proves the narrow physical JPKI signing-certificate profile and age >= 20.
/// Certificate revocation is NOT checked. This is not a completed eKYC service.
contract BenefitAgeGate {
    address public immutable verifier;
    bytes32 public immutable verifierCodeHash;
    uint256 public constant MINIMUM_AGE = 20;
    uint256 public constant CLAIM_DURATION = 900;

    error UnsupportedChain();
    error InvalidVerifier();

    constructor(address verifier_, bytes32 expectedCodeHash) {
        if (block.chainid != 80002 && block.chainid != 31337) revert UnsupportedChain();
        if (verifier_.code.length == 0 || expectedCodeHash == bytes32(0)
            || verifier_.codehash != expectedCodeHash) revert InvalidVerifier();
        verifier = verifier_;
        verifierCodeHash = expectedCodeHash;
    }

    function verifyClaimAge(
        bytes32 claimHash, bytes32 nonce, uint256 expiresAt,
        bytes calldata proof, uint256[8] calldata inputs
    ) external view returns (bool) {
        if (claimHash == bytes32(0) || nonce == bytes32(0) || proof.length != 384
            || expiresAt <= block.timestamp || expiresAt < CLAIM_DURATION
            || verifier.codehash != verifierCodeHash) return false;
        uint256 referenceTime = expiresAt - CLAIM_DURATION;
        if (referenceTime > block.timestamp || inputs[6] != referenceTime || inputs[7] != expiresAt
            || inputs[0] != uint256(claimHash) >> 128 || inputs[1] != uint128(uint256(claimHash))
            || inputs[2] != uint256(nonce) >> 128 || inputs[3] != uint128(uint256(nonce))
            || inputs[4] > type(uint128).max || inputs[5] > type(uint128).max) return false;
        bytes32 rootHash = bytes32((inputs[4] << 128) | inputs[5]);
        if (!_rootValid(rootHash, referenceTime, expiresAt)) return false;
        try IAgeGroth16Verifier(verifier).verifyProof(proof, inputs) { return true; }
        catch { return false; }
    }

    // SHA-256 of the 256-byte, big-endian RSA modulus from fingerprint-pinned
    // official J-LIS signing roots (see ZeroKeyMate docs/SOURCES.md).
    // No caller, card, model, admin or server can add a trust root at runtime.
    function _rootValid(bytes32 rootHash, uint256 start, uint256 end) internal view virtual returns (bool) {
        if (rootHash == 0xa5fad04a2d6cbb52ce03a55106a6e23be4fa4a771bb0bf81401833afc410b15e)
            return start >= 1568504516 && end <= 1884092399;
        if (rootHash == 0x9ec2093f1d4c86f0e22cd2b45140428437eba9591e979fa688428b71c241011c)
            return start >= 1689468627 && end <= 2005052399;
        return false;
    }
}

/// DEMO ONLY. Accepts exactly one non-J-LIS root fixed at deployment, for
/// synthetic fixtures or dev JPKI test cards. A proof accepted here says
/// nothing about a real My Number card.
contract BenefitAgeGateTestRoot is BenefitAgeGate {
    bytes32 public immutable testRoot;

    error InvalidTestRoot();

    constructor(address verifier_, bytes32 expectedCodeHash, bytes32 testRoot_)
        BenefitAgeGate(verifier_, expectedCodeHash)
    {
        if (testRoot_ == bytes32(0)) revert InvalidTestRoot();
        testRoot = testRoot_;
    }

    function _rootValid(bytes32 rootHash, uint256, uint256) internal view override returns (bool) {
        return rootHash == testRoot;
    }
}

/// DEMO ONLY. Accepts the JPKI test-environment ("JPKI-TEST") signing roots
/// that issue test My Number cards, and nothing else. A proof accepted here
/// says nothing about a real card. Roots are the four currently valid
/// self-signed test signing CAs in a42x/jpki-api certificates/development
/// (sig_ca_8, sig_ca_1, sig_ca_14, sig_ca_10), hashed like the J-LIS pins:
/// SHA-256 of the 256-byte big-endian RSA modulus.
contract BenefitAgeGateJpkiTest is BenefitAgeGate {
    constructor(address verifier_, bytes32 expectedCodeHash) BenefitAgeGate(verifier_, expectedCodeHash) {}

    function _rootValid(bytes32 rootHash, uint256 start, uint256 end) internal pure override returns (bool) {
        if (rootHash == 0x8a0336e52507e05b637f095492aee59d3d78823981bf9054ff28a93b727afa47)
            return start >= 1552091889 && end <= 1867676399;
        if (rootHash == 0x7b3b001af9630b60d7bc356383e0223e554785ddde24692953371a219eea7021)
            return start >= 1563405277 && end <= 1878994799;
        if (rootHash == 0x5b189b626b422dee7067e63d729b7c682f0fa30eed909a2537b95134f3c3f75d)
            return start >= 1679537567 && end <= 1995116399;
        if (rootHash == 0x91a09ca3b8f065d5462ef8e6a807d77612fc9db055af7f7769457e349595b5d1)
            return start >= 1724883819 && end <= 2040389999;
        return false;
    }
}
