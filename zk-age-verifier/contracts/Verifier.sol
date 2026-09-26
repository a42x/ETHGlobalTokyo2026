// SPDX-License-Identifier: MIT
//
// Provekit Groth16 + BSB22 on-chain verifier.
//
// STATUS: FIRST CUT — NOT AUDITED. DO NOT DEPLOY TO MAINNET.
//
// Verifies proofs produced by `provekit/groth16/` (the Rust Groth16+BSB22
// prover in this repository). The on-chain check mirrors
// `provekit_groth16::verifier::verify` — which is the authoritative spec.
//
// Four protocol-specific choices worth flagging up front:
//
//   1. BSB22 challenge hash. Challenges are derived with Keccak-256 to
//      match the EVM-native `KECCAK256` opcode (gas-cheap). Two shapes:
//        * single-challenge:  challenge = keccak256(dst || msg) mod R
//        * multi-challenge:   root      = keccak256(dst || msg)
//                             out[i]    = keccak256(root || I2OSP(i, 1)) mod R
//      See `_hashToFr` / `_hashToFrMulti`. The Rust counterparts
//      (`hash_to_fr`, `hash_to_fr_multi`) produce identical bytes.
//
//   2. Hash-input byte order. The Rust prover serialises G1 coordinates
//      and Fr values with arkworks `serialize_uncompressed` /
//      `serialize_compressed`, which is little-endian. EVM-native encoding
//      is big-endian, so the contract byte-reverses each 32-byte word
//      before feeding it into the challenge hash. See `_reverseBytes32`.
//
//   3. Proof byte layout uses EIP-197 ordering for G2 (X.c1, X.c0, Y.c1,
//      Y.c0), big-endian. The off-chain marshaller `provekit-cli
//      export-evm-proof` (see `tooling/cli/src/cmd/export_evm_proof.rs`)
//      emits proofs in exactly that layout — re-serialise from arkworks
//      before feeding the bytes into `verifyProof`.
//
//   4. RLC batching ("poor man's SNARKpack",
//      https://xn--2-umb.com/23/groth16-batch/). The Groth16 pairing
//      equation (4 pairings) and the Pedersen commitment equation (2
//      pairings) are folded into ONE pairing precompile call of 6 pairs
//      via a Fiat-Shamir scalar `r`:
//        e(Ar, Bs)·e(Krs, -δ)·e(α, -β)·e(k_sum, -γ)
//                 · e(r·C, -σG) · e(r·PoK, G)  ==  1
//      Soundness: by bilinearity `e(P,Q)^r = e(r·P, Q)`, so the combined
//      identity equals `P_groth16 · P_pedersen^r`; if either factor were
//      ≠ 1, the product equals 1 for at most one `r ∈ F_R`. The prover
//      cannot adaptively choose `r` because it is bound to all proof
//      bytes and public inputs via keccak256 (see `_deriveRlcChallenge`).
//      Saves one precompile invocation (≈45k gas of base cost) plus
//      avoids re-pairing intermediate field elements.
//
// Template shape (v1):
//   - exactly ONE Pedersen commitment over private wires
//   - one or more derived challenges per commitment (N_CHALLENGE)
//   - uncompressed proof points (no on-chain decompression)
//
// Multi-commitment and compressed-proof variants are out of scope here;
// see the EXTENSIONS footer for the migration map.
//
// All `// CODEGEN:` markers are placeholders substituted by the codegen
// tool `provekit-cli export-solidity` (see
// `tooling/cli/src/cmd/export_solidity.rs`), which reads a `.pkv`,
// precomputes the negated VK points (-β, -γ, -δ, -σ·G), and rewrites this
// template into a circuit-specific contract.

pragma solidity ^0.8.20;

contract ProvekitGroth16Verifier {
    // ------------------------------------------------------------------
    // Field constants (BN254).
    // ------------------------------------------------------------------

    /// (P - 1) / 2 where P is the BN254 base field prime. Threshold for
    /// arkworks' SWFlags::YIsNegative flag: y > P_HALF means the serialized
    /// affine point gets 0x80 OR'd into the high byte of Y.
    uint256 internal constant P_HALF =
        0x183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3;

    /// Scalar field prime R (BN254).
    uint256 internal constant R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    // ------------------------------------------------------------------
    // Precompile addresses.
    // ------------------------------------------------------------------

    uint256 internal constant PRECOMPILE_ECADD   = 0x06;
    uint256 internal constant PRECOMPILE_ECMUL   = 0x07;
    uint256 internal constant PRECOMPILE_PAIRING = 0x08;

    // ------------------------------------------------------------------
    // Circuit parameters.
    // ------------------------------------------------------------------

    /// Number of EXPLICIT public inputs the circuit takes (not counting
    /// the ONE_WIRE or BSB22 derived challenges).
    /// CODEGEN: substitute from VerifyingKey.
    uint256 internal constant N_PUB = 8;

    /// Number of BSB22 Pedersen commitments in the proof.
    /// CODEGEN: substitute from VerifyingKey. v1 template assumes 1.
    uint256 internal constant N_COMMIT = 1;

    /// Number of derived challenges per commitment. v1 template assumes 1.
    /// CODEGEN: substitute from `num_challenges_per_commitment[0]`.
    uint256 internal constant N_CHALLENGE = 2;

    /// Length of `extended_public` = N_PUB + N_COMMIT * N_CHALLENGE. Equal to
    /// `vk.g1_k.len() - 1` (the `-1` strips the constant-1 ONE_WIRE entry).
    /// Required by the codegen tool; not referenced from contract code.
    /// CODEGEN: substitute from VerifyingKey.
    uint256 internal constant N_PUB_EXTENDED = 10;

    /// Number of `input[]` entries that are hashed into the BSB22 commitment
    /// challenge. Matches `len(vk.public_and_commitment_committed[0])`.
    ///
    /// CODEGEN: substitute per circuit. The committed list is a subset of
    /// `input[]`; the indices used live in `_deriveCommitmentChallenge` and
    /// must be regenerated together with this constant.
    /// Default template assumes ALL N_PUB inputs are committed.
    uint256 internal constant N_COMMITTED = 8;

    // ------------------------------------------------------------------
    // BSB22 domain separation tags (from `provekit_groth16::lib.rs`).
    // ------------------------------------------------------------------

    /// DST for per-commitment BSB22 challenges. ASCII bytes "bsb22-commitment".
    bytes internal constant DST_COMMITMENT = "bsb22-commitment";

    /// DST for the RLC scalar that batches the Groth16 + Pedersen pairing
    /// checks into a single precompile call. Must NOT collide with any
    /// other Fiat-Shamir DST used in the prover/verifier (in particular
    /// DST_COMMITMENT and the future "G16-BSB22" multi-commitment DST).
    bytes internal constant DST_RLC = "groth16-pedersen-rlc";

    // EXTEND: multi-commitment folding uses DST "G16-BSB22" — add when
    // implementing the multi-commitment path.

    // ------------------------------------------------------------------
    // Verifying key constants. CODEGEN: substitute all of these per
    // circuit. The values below are placeholders.
    //
    // β, γ, δ are stored pre-negated so the pairing equation can be written
    // directly as e(α, -β) · e(k_sum, -γ) · e(Krs, -δ) · e(Ar, Bs) == 1.
    // The Rust verifier does the same precomputation at deserialisation
    // (see `VerifyingKey::precompute` in `provekit/groth16/src/types.rs`);
    // the codegen tool runs it once and bakes the negated coordinates in.
    // ------------------------------------------------------------------

    // Groth16 alpha (G1, positive).
    uint256 internal constant ALPHA_X = 0x2a57bf4ceb624ccce3c661e3af9f509f307f490d8abfed6f131209f7234ec4b8;
    uint256 internal constant ALPHA_Y = 0x132214919a0b94bcf5190e88899716664af2f57253522c9b572115e67d65ecf0;

    // Groth16 beta (G2, NEGATED so we can write e(α, -β) directly).
    uint256 internal constant BETA_NEG_X_0 = 0x0df541819bd826c272b0c7556f941a59a5ecc39058259f34f8663c6bd9220450;
    uint256 internal constant BETA_NEG_X_1 = 0x264692c92721dc6ade9de80721701565dc399874d3a7c77b37b3a26d5138ba4e;
    uint256 internal constant BETA_NEG_Y_0 = 0x1891d16bc6cdcde28fbc9ac78023ae33759e0c3543dffb2e77c80ca806f1fa00;
    uint256 internal constant BETA_NEG_Y_1 = 0x17ab486017ef52004776a7818505b49e09691a0a70d4dd2ce532940b7b539690;

    // Groth16 gamma (G2, NEGATED).
    uint256 internal constant GAMMA_NEG_X_0 = 0x13d3b35c7feb75117027dfa985d8458a715d4140954a3b38baf88ac85f0d1915;
    uint256 internal constant GAMMA_NEG_X_1 = 0x03d0f7ec7abe9ad11218d1a586299fa54fa78d35e6c93bb0c66a8526bb4c0ea9;
    uint256 internal constant GAMMA_NEG_Y_0 = 0x2b417bca970f8551214bfb5f50adb80334ed41223e1e88271387df4cdd4eb3a8;
    uint256 internal constant GAMMA_NEG_Y_1 = 0x224764143cdfbb7218a3f151d6c96a98d6e0cbc9a0a99568d34a8b23cf07a48c;

    // Groth16 delta (G2, NEGATED).
    uint256 internal constant DELTA_NEG_X_0 = 0x21d15f0c01dc9fa4c7a655ea34d0f0e73f34c6cf19cdb811da868e06eb8b1d8c;
    uint256 internal constant DELTA_NEG_X_1 = 0x20b3e5a034282f8c2e8f4f4679eb28e49b5bd853b64218ae9e9de6e18307b9d8;
    uint256 internal constant DELTA_NEG_Y_0 = 0x0b16889315564c611f63159e11f8b06ace8009fa68075f99e205903930ccd792;
    uint256 internal constant DELTA_NEG_Y_1 = 0x1d6c2a1dc8221a54f8c473a7b67b332199cc521d35c93acddbf53b75a4ec85b1;

    // K[0] (constant term of the public-input MSM).
    uint256 internal constant K0_X = 0x29398b7eb50b8d1fb91ac901343c60fc9ad5155cb928f5a1c94d935980fef97d;
    uint256 internal constant K0_Y = 0x10042a5538be12a5c918cdff1fe480fe1a163d08e8b76bdaadb423131b3575c5;

    // K[1..1+N_PUB_EXTENDED] — one G1 point per extended public input.
    // CODEGEN: emit N_PUB_EXTENDED entries (PUB_0_X, PUB_0_Y, ..., PUB_{N-1}_*).
    //<BEGIN_CODEGEN:PUB_BASES>
    uint256 internal constant PUB_0_X = 0x06cf58f4803b0434b082aab45684d9ea776c3dfc7f12ff0e15798bebccc3fe14; // K[1] — public input #0
    uint256 internal constant PUB_0_Y = 0x1bcdef2b649b9aab776adc695fe88c833dd18d71bb1f18a29cd31f6b814b1980; // K[1] — public input #0
    uint256 internal constant PUB_1_X = 0x2d93e35d985ed511bbe8e6eb399e5af5129c91e5bfe15755a0751b3e2fbaada9; // K[2] — public input #1
    uint256 internal constant PUB_1_Y = 0x24c78e352f33a142757889ba5c358f83d7e8cb8a50043e832e35433193e106a6; // K[2] — public input #1
    uint256 internal constant PUB_2_X = 0x12b82861b35346fb1b516159f6300720664d7ea1c4fe4fd956d10ec3aaaaea90; // K[3] — public input #2
    uint256 internal constant PUB_2_Y = 0x2ef45a6cacc17d02f0f3518d9aac8b7873fca5541eeb9cb94cc779addc4e35e9; // K[3] — public input #2
    uint256 internal constant PUB_3_X = 0x28cf4dc17e04a8fc8e381a87b9c3fadfb93e2848e5c1b3067e33d001164dc1be; // K[4] — public input #3
    uint256 internal constant PUB_3_Y = 0x1419c7cc388781dc4c324618d2dfb91e99b4462b421758b92cf1778a30bb598e; // K[4] — public input #3
    uint256 internal constant PUB_4_X = 0x0240cbc809e5c046a237ad14a0d2a7b4fb688d624ae5ee28f8f178fc7df8d1c5; // K[5] — public input #4
    uint256 internal constant PUB_4_Y = 0x2c826c38e730a19a231d44c14ae61863b9e3cf9f590d5e8319474bba8be7ddcf; // K[5] — public input #4
    uint256 internal constant PUB_5_X = 0x03d503827b0a5b033a3541e6676b6ebc861e7880191fc633ed14cb1a5761a758; // K[6] — public input #5
    uint256 internal constant PUB_5_Y = 0x0f9cd4bb566771644609af4c7cbda1303011493ef3d1635bdc504c30e9bc15cb; // K[6] — public input #5
    uint256 internal constant PUB_6_X = 0x10eac1ce6a64155712b86d3b65f7c46758387ac523432a26baee17fb0cbaeeed; // K[7] — public input #6
    uint256 internal constant PUB_6_Y = 0x22e47b2573be448ef6d302c647487a72e5c6db0a6bd3e5186baed12b7facac78; // K[7] — public input #6
    uint256 internal constant PUB_7_X = 0x06a529a2f92736cec75bf4037ccbbf251f7ea59a9d829b8871a562ad85386e42; // K[8] — public input #7
    uint256 internal constant PUB_7_Y = 0x222d4d395199a3c5c502b44447709eb61391982f601535460db968917b46033e; // K[8] — public input #7
    uint256 internal constant PUB_8_X = 0x23b3eabf3f33db872aca9eec886a38596d31465feb6990677515db245776048c; // K[9] — challenge #0
    uint256 internal constant PUB_8_Y = 0x2be0c6a1dc016479d46dfd3b9648449d594a45ceb14ed167909e972d954c5418; // K[9] — challenge #0
    uint256 internal constant PUB_9_X = 0x13edd7a83f635d0db1e2cf02f7e11f978d2921ce438bfc0db920bd1dbbe83d9d; // K[10] — challenge #1
    uint256 internal constant PUB_9_Y = 0x02426c1bd31189ffa9b23a440ec60de263f82aac6acaa0ef9b2ef1a3a6ef7ece; // K[10] — challenge #1
    //<END_CODEGEN:PUB_BASES>

    // Pedersen verifying key (single-commitment template).
    // G is in G2; GSigmaNeg = -σ·G also in G2.
    uint256 internal constant PEDERSEN_G_X_0          = 0x15827778420187059e1d163c7db0da25d016665254b2b823c8d9b6789f6c198a;
    uint256 internal constant PEDERSEN_G_X_1          = 0x2ec9c24c017da4082d76639a7d070b16710a1644261ca1f246dce111101522f1;
    uint256 internal constant PEDERSEN_G_Y_0          = 0x07bd038b4fe229d21f149338b15b61b337779e158d2ca14199cc7c492b485d2a;
    uint256 internal constant PEDERSEN_G_Y_1          = 0x18f38c287c2ac7f088b2e825c439f58de949764b4acf853c9095cc18f2b3fc9d;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_X_0 = 0x1de4cfcd0ef6ddf81e65acc007ee3de75a481c589319fe529cbd1b0d71dbea87;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_X_1 = 0x0eafcd4ae01c6154ea031bc40f7bc7d5ddb1e22dc1f552240b29350c425ff795;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_Y_0 = 0x1f87c45d9bbc10e76524677d790bea95729adc049f69f153fc1e74b93b5e4709;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_Y_1 = 0x1585e77e3fb9880ba08afe761128b10317cf3a9d529186a8157cb4a36e401c2a;

    // ------------------------------------------------------------------
    // Errors.
    // ------------------------------------------------------------------

    error ProofInvalid();
    error ProofLengthInvalid();
    error PublicInputNotInField();
    error ProofPointAtInfinity();

    // ==================================================================
    //                   Public entry point
    // ==================================================================

    /// Verify a Groth16+BSB22 proof.
    ///
    /// `proof` byte layout (all coordinates big-endian, all G2 components
    /// in EIP-197 order — produced by `provekit-cli export-evm-proof`):
    ///   bytes   0 ..  64 : Ar           (G1: X, Y)
    ///   bytes  64 .. 192 : Bs           (G2: X.c1, X.c0, Y.c1, Y.c0)
    ///   bytes 192 .. 256 : Krs          (G1: X, Y)
    ///   bytes 256 .. 256 + 64·N_COMMIT       : Commitments (G1 each)
    ///   bytes 256 + 64·N_COMMIT ..  +64      : CommitmentPok (G1)
    /// Total length: 256 + 64·(N_COMMIT + 1).
    ///
    /// `input` carries only the EXPLICIT public inputs (N_PUB of them);
    /// the BSB22 challenge wires are derived on chain in
    /// `_deriveCommitmentChallenges`.
    function verifyProof(
        bytes calldata proof,
        uint256[N_PUB] calldata input
    ) external view {
        // Expected length: 256 + 64·(N_COMMIT + 1).
        if (proof.length != 256 + 64 * (N_COMMIT + 1)) revert ProofLengthInvalid();

        // Field-range checks on input[] are folded into `_msmStep` (every
        // public input flows through the MSM, where `s >= R` reverts with
        // `PublicInputNotInField`). Derived challenges from `_hashToFr` /
        // `_hashToFrMulti` are already reduced mod R by construction.

        // Only materialise the coords used outside the final pairing call.
        // Ar / Bs / Krs flow into the pairing buffer only, so we leave them
        // in calldata and `calldatacopy` them straight into `pairings[0..8]`
        // when the buffer is laid out below. Keeping them off the Solidity
        // stack reduces simultaneous-locals pressure in this function from
        // ~20 to ~12 — see the top-of-file note on stack budget.
        uint256 cX;
        uint256 cY;
        uint256 pokX;
        uint256 pokY;
        assembly ("memory-safe") {
            cX   := calldataload(add(proof.offset, 0x100))
            cY   := calldataload(add(proof.offset, 0x120))
            pokX := calldataload(add(proof.offset, 0x140))
            pokY := calldataload(add(proof.offset, 0x160))
        }

        // Point-at-infinity rejection.
        //
        // EIP-196/197 precompiles accept (0,0) (resp. (0,0,0,0)) as the
        // identity element. The Rust verifier (`Proof::is_valid` in
        // `provekit/groth16/src/types.rs`) rejects zero proof points
        // outright — accepting them widens the surface for malformed or
        // malicious proofs (e.g. with Ar = ∞ the pairing equation collapses
        // to one fewer factor). Mirror that here. Curve-membership of
        // non-zero points is enforced by the ECMUL/ECADD/pairing
        // precompiles downstream.
        _rejectInfinityArBsKrs(proof);
        if ((cX   | cY  ) == 0) revert ProofPointAtInfinity();
        if ((pokX | pokY) == 0) revert ProofPointAtInfinity();

        // RLC-batched pairing identity (see top-of-file note 4):
        //   e(Ar, Bs) · e(Krs, -δ) · e(α, -β) · e(k_sum, -γ)
        //            · e(r·C, -σG) · e(r·PoK, G) == 1
        //
        // `r` is derived AFTER all prover-controlled values have been
        // observed (proof bytes + public inputs), so the prover cannot
        // adaptively pick points that exploit the combination. Soundness:
        // if either original check fails, the combined check passes for at
        // most one `r ∈ F_R` (probability ≤ 1/R).
        //
        // The buffer is filled top-down (Ar/Bs/Krs from calldata, then VK
        // constants, then k_sum, then the two RLC factors via ECMUL output
        // written in-place — see the assembly block below). On failure of
        // any sub-call, the AND-chained `success` collapses to 0 and we
        // revert. After batching, the pairing precompile cannot distinguish
        // which sub-check failed, so the collapsed error path is by design.
        uint256[36] memory pairings;

        // e(Ar, Bs) and Krs.G1: bytes 0..192 of `proof` already lay out
        // exactly as the EIP-197 input expects (Ar.X, Ar.Y, Bs.X.c1,
        // Bs.X.c0, Bs.Y.c1, Bs.Y.c0, Krs.X, Krs.Y — all big-endian) — so a
        // single calldatacopy fills pairings[0..8] without naming any coord.
        assembly ("memory-safe") {
            calldatacopy(pairings,             proof.offset,             0xC0)
            calldatacopy(add(pairings, 0xC0),  add(proof.offset, 0xC0),  0x40)
        }

        // e(Krs, -δ): G2 side from VK constants.
        pairings[8]  = DELTA_NEG_X_1;
        pairings[9]  = DELTA_NEG_X_0;
        pairings[10] = DELTA_NEG_Y_1;
        pairings[11] = DELTA_NEG_Y_0;

        // e(α, -β)
        pairings[12] = ALPHA_X;
        pairings[13] = ALPHA_Y;
        pairings[14] = BETA_NEG_X_1;
        pairings[15] = BETA_NEG_X_0;
        pairings[16] = BETA_NEG_Y_1;
        pairings[17] = BETA_NEG_Y_0;

        // e(kSum, -γ). BSB22 derivation + MSM live in their own scope so
        // `challenges`, `kSumX`, `kSumY` drop off the stack before the RLC
        // stage — frees slots for `r` and assembly temporaries.
        //
        // Which `input[]` entries feed `_deriveCommitmentChallenges` (and
        // their order) is determined by
        // `VerifyingKey.public_and_commitment_committed[0]`; see the
        // CODEGEN block inside that helper. `_publicInputMSM` builds
        // k_sum = K[0] + Σᵢ extended_public[i]·K[1+i] + Σⱼ commitments[j],
        // mirroring `provekit_groth16::verifier::verify`.
        {
            uint256[N_CHALLENGE] memory challenges = _deriveCommitmentChallenges(cX, cY, input);
            (uint256 kSumX, uint256 kSumY) = _publicInputMSM(input, challenges, cX, cY);
            pairings[18] = kSumX;
            pairings[19] = kSumY;
        }
        pairings[20] = GAMMA_NEG_X_1;
        pairings[21] = GAMMA_NEG_X_0;
        pairings[22] = GAMMA_NEG_Y_1;
        pairings[23] = GAMMA_NEG_Y_0;

        uint256 r = _deriveRlcChallenge(proof, input);
        // Reject the degenerate r == 0 (would erase the Pedersen factor
        // from the combined check). Probability of a hash output landing at
        // 0 mod R is ~1/R and unreachable by a computationally bounded
        // adversary; revert defensively rather than rebase.
        if (r == 0) revert ProofInvalid();

        // Fuse the two RLC ECMULs into the pairing buffer. For each factor
        // we stage (px, py, r) in three consecutive slots, call ECMUL with
        // output (0x40) overlapping the first two slots (px/py become rx/ry
        // in place), then overwrite the trailing scalar slot plus the next
        // three with the G2 coordinates. Avoids the per-ECMUL `uint256[3]`
        // buffer and the rcX/rcY/rpokX/rpokY stack locals of the prior
        // implementation.
        bool success;
        uint256 result;
        assembly ("memory-safe") {
            // e(r·C, -σG): pairings[24..30].
            let p := add(pairings, 0x300)
            mstore(p, cX)
            mstore(add(p, 0x20), cY)
            mstore(add(p, 0x40), r)
            success := staticcall(gas(), PRECOMPILE_ECMUL, p, 0x60, p, 0x40)
            mstore(add(p, 0x40), PEDERSEN_GSIGMA_NEG_X_1)
            mstore(add(p, 0x60), PEDERSEN_GSIGMA_NEG_X_0)
            mstore(add(p, 0x80), PEDERSEN_GSIGMA_NEG_Y_1)
            mstore(add(p, 0xA0), PEDERSEN_GSIGMA_NEG_Y_0)

            // e(r·PoK, G): pairings[30..36].
            p := add(pairings, 0x3C0)
            mstore(p, pokX)
            mstore(add(p, 0x20), pokY)
            mstore(add(p, 0x40), r)
            success := and(success, staticcall(gas(), PRECOMPILE_ECMUL, p, 0x60, p, 0x40))
            mstore(add(p, 0x40), PEDERSEN_G_X_1)
            mstore(add(p, 0x60), PEDERSEN_G_X_0)
            mstore(add(p, 0x80), PEDERSEN_G_Y_1)
            mstore(add(p, 0xA0), PEDERSEN_G_Y_0)

            // 36 words · 32 bytes = 0x480 input length, 32-byte bool output.
            success := and(success, staticcall(gas(), PRECOMPILE_PAIRING, pairings, 0x480, pairings, 0x20))
            result := mload(pairings)
        }
        if (!success || result != 1) revert ProofInvalid();
    }

    /// Reject (0,0) / (0,0,0,0) for Ar, Bs, Krs without lifting their
    /// coordinates onto the Solidity stack. Each `or` collapses one point
    /// to a single "is zero?" word; the three checks remain per-point (not
    /// a single coarse OR across all 8 words) to preserve the original
    /// semantics.
    function _rejectInfinityArBsKrs(bytes calldata proof) internal pure {
        uint256 arOr;
        uint256 bsOr;
        uint256 krsOr;
        assembly ("memory-safe") {
            arOr := or(
                calldataload(proof.offset),
                calldataload(add(proof.offset, 0x20))
            )
            bsOr := or(
                or(
                    calldataload(add(proof.offset, 0x40)),
                    calldataload(add(proof.offset, 0x60))
                ),
                or(
                    calldataload(add(proof.offset, 0x80)),
                    calldataload(add(proof.offset, 0xA0))
                )
            )
            krsOr := or(
                calldataload(add(proof.offset, 0xC0)),
                calldataload(add(proof.offset, 0xE0))
            )
        }
        if (arOr == 0 || bsOr == 0 || krsOr == 0) revert ProofPointAtInfinity();
    }

    // ==================================================================
    //               BSB22 challenge derivation
    // ==================================================================

    /// Compute the BSB22 challenge(s) for the single commitment.
    ///
    /// Hash input (arkworks little-endian throughout):
    ///   serialize_g1(C) || serialize_fr(input[i0]) || ...
    ///                  || serialize_fr(input[i_{N_COMMITTED-1}])
    /// The indices (i0, i1, ...) come from
    /// `vk.public_and_commitment_committed[0]` — a subset of `input[]`,
    /// NOT necessarily the whole array — in the order recorded by the VK.
    ///
    /// Reduction:
    ///   * N_CHALLENGE == 1:  challenge = keccak256("bsb22-commitment" || msg) mod R
    ///                        (one round; matches Rust `hash_to_fr`)
    ///   * N_CHALLENGE  > 1:  root      = keccak256("bsb22-commitment" || msg)
    ///                        out[i]    = keccak256(root || I2OSP(i, 1)) mod R
    ///                        (matches Rust `hash_to_fr_multi`)
    ///
    /// Authoritative spec: `derive_commitment_challenge`, `hash_to_fr`, and
    /// `hash_to_fr_multi` in `provekit/groth16/src/prover.rs`, plus the
    /// branch in `provekit::groth16::verifier::verify` that selects between
    /// them based on `num_challenges_per_commitment[i]`.
    function _deriveCommitmentChallenges(
        uint256 cX,
        uint256 cY,
        uint256[N_PUB] calldata input
    ) internal pure returns (uint256[N_CHALLENGE] memory) {
        // Build the hash input in arkworks little-endian.
        // Length: 64 (G1) + 32 · N_COMMITTED.
        bytes memory msgBuf = new bytes(64 + 32 * N_COMMITTED);

        // Commitment in arkworks LE.
        //
        // arkworks `serialize_uncompressed` for SW affine writes X with
        // EmptyFlags and Y with SWFlags::from_y_sign(). For a valid
        // (non-infinity) commitment that flag is YIsNegative (= 0x80) when
        // y > (P-1)/2, OR'd into the highest byte of Y's little-endian
        // encoding. Folding the flag into bit 255 of cY before the byte
        // reverse places it exactly there (msgBuf[63]). Skipping this makes
        // the on-chain hash diverge from the prover's hash whenever cY is
        // in the upper half of the field — i.e. ~half of all valid proofs.
        uint256 cYFlagged = cY > P_HALF ? cY | (uint256(1) << 255) : cY;
        _writeReversedAt(msgBuf, 0,  cX);
        _writeReversedAt(msgBuf, 32, cYFlagged);

        // Public-committed inputs in arkworks LE.
        //
        // CODEGEN: emit exactly N_COMMITTED `_writeReversedAt` calls — one
        // per entry of `vk.public_and_commitment_committed[0]`, in the
        // order recorded in the VK. Index conversion: the VK stores
        // 1-based absolute witness indices (`0 = ONE_WIRE`, `1 =
        // public_witness[0]`, ...); the codegen tool subtracts 1 so each
        // emitted call indexes `input[]` 0-based (see
        // `tooling/cli/src/cmd/export_solidity.rs::CircuitParams`).
        //
        // The Rust verifier reads these same values via
        // `extended_public[idx - 1]`; emitting the wrong subset — or the
        // right subset in the wrong order — silently produces a different
        // challenge and makes every valid proof fail.
        //
        // Default placeholder below assumes committed = [input[0]]; the
        // codegen tool overwrites this block whole.
        //<BEGIN_CODEGEN:COMMITTED_INDICES>
        _writeReversedAt(msgBuf, 64 + 32 * 0, input[0]); // committed[0] = input[0]
        _writeReversedAt(msgBuf, 64 + 32 * 1, input[1]); // committed[1] = input[1]
        _writeReversedAt(msgBuf, 64 + 32 * 2, input[2]); // committed[2] = input[2]
        _writeReversedAt(msgBuf, 64 + 32 * 3, input[3]); // committed[3] = input[3]
        _writeReversedAt(msgBuf, 64 + 32 * 4, input[4]); // committed[4] = input[4]
        _writeReversedAt(msgBuf, 64 + 32 * 5, input[5]); // committed[5] = input[5]
        _writeReversedAt(msgBuf, 64 + 32 * 6, input[6]); // committed[6] = input[6]
        _writeReversedAt(msgBuf, 64 + 32 * 7, input[7]); // committed[7] = input[7]
        //<END_CODEGEN:COMMITTED_INDICES>

        // Match the Rust verifier: when num_challenges <= 1, the prover and
        // off-chain verifier use `derive_commitment_challenge` (a single
        // keccak round via `hash_to_fr`); otherwise they use the counter
        // chain `hash_to_fr_multi`. The on-chain split below mirrors that.
        // N_CHALLENGE is a compile-time constant, so the dead branch is
        // pruned.
        uint256[N_CHALLENGE] memory out;
        if (N_CHALLENGE == 1) {
            out[0] = _hashToFr(msgBuf, DST_COMMITMENT);
            return out;
        }
        return _hashToFrMulti(msgBuf, DST_COMMITMENT);
    }

    // ==================================================================
    //               RLC scalar (Fiat-Shamir for pairing batching)
    // ==================================================================

    /// Derive the random-linear-combination scalar `r ∈ F_R` that folds
    /// the Pedersen pairing factor into the Groth16 pairing equation.
    ///
    /// Hash domain:
    ///     r = keccak256(DST_RLC || proof || input) mod R
    ///
    /// All prover-chosen values flow into the hash:
    ///   * `proof` — Ar, Bs, Krs, C, PoK in their EVM big-endian layout
    ///   * `input` — the EXPLICIT public inputs (the derived BSB22
    ///     challenges and k_sum are deterministic functions of `proof`
    ///     and `input`, so hashing them again would be redundant)
    ///
    /// This pins `r` to the prover's commitments before they are
    /// "interpreted" through the pairing, eliminating adaptive attacks
    /// (cf. Fiat-Shamir transform applied to the interactive batch-
    /// verification protocol).
    ///
    /// Bias note: the same ~2^-126 statistical bias as elsewhere in this
    /// contract (256-bit hash output reduced mod a 254-bit prime) — well
    /// inside the soundness margin for a single Fiat-Shamir scalar.
    function _deriveRlcChallenge(
        bytes calldata proof,
        uint256[N_PUB] calldata input
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(DST_RLC, proof, input))) % R;
    }

    // ==================================================================
    //               Public-input MSM
    // ==================================================================

    /// k_sum = K[0] + Σᵢ extended_public[i] · K[1+i] + Σⱼ commitments[j]
    ///
    /// extended_public = [input[0], …, input[N_PUB-1],
    ///                    challenges[0], …, challenges[N_CHALLENGE-1]].
    /// Each commitment is added directly to the running sum after the MSM;
    /// for the single-commitment template that's just one extra ECADD.
    function _publicInputMSM(
        uint256[N_PUB] calldata input,
        uint256[N_CHALLENGE] memory challenges,
        uint256 cX,
        uint256 cY
    ) internal view returns (uint256 x, uint256 y) {
        // Working buffer holds the running sum.
        uint256[5] memory buf;
        buf[0] = K0_X;
        buf[1] = K0_Y;

        // ECMUL/ECADD for each entry of extended_public.
        // We list the K-points inline (CODEGEN should unroll for arbitrary N).
        //<BEGIN_CODEGEN:MSM_STEPS>
        _msmStep(buf, PUB_0_X, PUB_0_Y, input[0]);
        _msmStep(buf, PUB_1_X, PUB_1_Y, input[1]);
        _msmStep(buf, PUB_2_X, PUB_2_Y, input[2]);
        _msmStep(buf, PUB_3_X, PUB_3_Y, input[3]);
        _msmStep(buf, PUB_4_X, PUB_4_Y, input[4]);
        _msmStep(buf, PUB_5_X, PUB_5_Y, input[5]);
        _msmStep(buf, PUB_6_X, PUB_6_Y, input[6]);
        _msmStep(buf, PUB_7_X, PUB_7_Y, input[7]);
        _msmStep(buf, PUB_8_X, PUB_8_Y, challenges[0]);
        _msmStep(buf, PUB_9_X, PUB_9_Y, challenges[1]);
        //<END_CODEGEN:MSM_STEPS>

        // Add commitment(s) to k_sum.
        _ecAddInto(buf, cX, cY);

        x = buf[0];
        y = buf[1];
    }

    /// buf[0..2] += K · s  (via ECMUL then ECADD).
    function _msmStep(
        uint256[5] memory buf,
        uint256 kx,
        uint256 ky,
        uint256 s
    ) internal view {
        if (s >= R) revert PublicInputNotInField();

        bool success;
        assembly ("memory-safe") {
            let p := add(buf, 0x40)
            mstore(p, kx)
            mstore(add(p, 0x20), ky)
            mstore(add(p, 0x40), s)
            // ECMUL: (kx, ky, s) -> (rx, ry)
            success := staticcall(gas(), PRECOMPILE_ECMUL, p, 0x60, p, 0x40)
            // ECADD: buf[0..2] += [p..p+64]
            success := and(success, staticcall(gas(), PRECOMPILE_ECADD, buf, 0x80, buf, 0x40))
        }
        if (!success) revert ProofInvalid();
    }

    /// buf[0..2] += (px, py).
    function _ecAddInto(
        uint256[5] memory buf,
        uint256 px,
        uint256 py
    ) internal view {
        bool success;
        assembly ("memory-safe") {
            mstore(add(buf, 0x40), px)
            mstore(add(buf, 0x60), py)
            success := staticcall(gas(), PRECOMPILE_ECADD, buf, 0x80, buf, 0x40)
        }
        if (!success) revert ProofInvalid();
    }

    // ==================================================================
    //               BSB22 hash-to-Fr primitives
    // ==================================================================

    /// Counter-chain hash to N_CHALLENGE field elements. Matches
    /// `provekit_groth16::prover::hash_to_fr_multi`:
    ///   root   = keccak256(dst || msg)
    ///   out[i] = keccak256(root || I2OSP(i, 1)) mod R    for i = 0..N
    ///
    /// One outer hash over `msg` (which may be large), then N cheap
    /// 33-byte hashes — total cost stays close to a single keccak even
    /// for moderately large N.
    ///
    /// Bias: each `out[i]` is uniform over [0, 2^256) before reduction.
    /// Reducing a 256-bit value mod R (254-bit) leaves ~2^-126
    /// statistical bias — negligible for BSB22 challenge use.
    function _hashToFrMulti(
        bytes memory msgBuf,
        bytes memory dst
    ) internal pure returns (uint256[N_CHALLENGE] memory out) {
        bytes32 root = keccak256(abi.encodePacked(dst, msgBuf));
        for (uint256 i = 0; i < N_CHALLENGE; i++) {
            out[i] = uint256(keccak256(abi.encodePacked(root, uint8(i)))) % R;
        }
    }

    /// Single-round hash to one field element:
    ///   keccak256(dst || msg) mod R
    /// Matches `provekit_groth16::prover::hash_to_fr`. Used both for the
    /// single-challenge commitment path (above) and — once implemented —
    /// for the multi-commitment folding challenge with dst "G16-BSB22".
    function _hashToFr(bytes memory msgBuf, bytes memory dst) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(dst, msgBuf))) % R;
    }

    // ==================================================================
    //               Byte-reversal helpers
    // ==================================================================

    /// Write `value` (an EVM uint256, big-endian) into `buf[offset..offset+32]`
    /// in REVERSED (little-endian) byte order. Used to convert EVM-side
    /// G1 coordinates and Fr values to arkworks' on-the-wire layout before
    /// hashing.
    function _writeReversedAt(bytes memory buf, uint256 offset, uint256 value) internal pure {
        uint256 rev = _reverseBytes32(value);
        assembly ("memory-safe") {
            mstore(add(add(buf, 0x20), offset), rev)
        }
    }

    /// Reverse the byte order of a 32-byte word (BE ↔ LE).
    /// Constant-time bitwise reversal in 12 ops.
    function _reverseBytes32(uint256 x) internal pure returns (uint256 r) {
        r = x;
        r = ((r >> 8)  & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) |
            ((r        & 0x00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF00FF) << 8);
        r = ((r >> 16) & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) |
            ((r        & 0x0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF0000FFFF) << 16);
        r = ((r >> 32) & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) |
            ((r        & 0x00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFF) << 32);
        r = ((r >> 64) & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) |
            ((r        & 0x0000000000000000FFFFFFFFFFFFFFFF0000000000000000FFFFFFFFFFFFFFFF) << 64);
        r = (r >> 128) | (r << 128);
    }
}
