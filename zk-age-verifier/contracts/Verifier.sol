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
    uint256 internal constant ALPHA_X = 0x2f6fc9fdf4f4e6f1fe2c632954c35ab7c4564acebb9c02c83d368ec631bcc0ff;
    uint256 internal constant ALPHA_Y = 0x275c4d190381833d29635a363e578085048746c0f7a4b1c4058918d5490c747a;

    // Groth16 beta (G2, NEGATED so we can write e(α, -β) directly).
    uint256 internal constant BETA_NEG_X_0 = 0x2bc14739f9c799dc131482c25a7cb56f971ea80d34558ca2f0cc09a8ac2cc69d;
    uint256 internal constant BETA_NEG_X_1 = 0x11f791b6c7c3c4884d572767417edaf93d76e6b2a9df1867a2d371b943e8db83;
    uint256 internal constant BETA_NEG_Y_0 = 0x0d30ff59ba473e4bbdc0132b0fbb33419a090551709d3be9e832e743f720ce9d;
    uint256 internal constant BETA_NEG_Y_1 = 0x16b8480f86018bcb8384da7316770bd5e8b09554fc5078e761d7e8a69e541412;

    // Groth16 gamma (G2, NEGATED).
    uint256 internal constant GAMMA_NEG_X_0 = 0x0434fd71977011204813b4822c2e9f57b15a17950d0fc6b02ff363d1e6dc4c4b;
    uint256 internal constant GAMMA_NEG_X_1 = 0x1f82734a7c286790cd527d952b0a7185d8b758f0bf56d0a2fa663d0da9e66c59;
    uint256 internal constant GAMMA_NEG_Y_0 = 0x0a39494d9d335d127033589917e447239dfb291d48c5e032b12f0f8529656778;
    uint256 internal constant GAMMA_NEG_Y_1 = 0x181c3d1a8e1f3726741e4e1be64bc30327a58e092c99ca287cfc1e5ce143cb0f;

    // Groth16 delta (G2, NEGATED).
    uint256 internal constant DELTA_NEG_X_0 = 0x147262e7fb64304623058e7381243b6a4b62035bacf37a5b92f303e8b1c94ef1;
    uint256 internal constant DELTA_NEG_X_1 = 0x0fb6a5381aee746fb39b8cccffac372e6bb889013d7f6ccecbeb769cccee9b55;
    uint256 internal constant DELTA_NEG_Y_0 = 0x1eb993354a4a8493c720fcd4f3471b9831e4d52573cb6c2b66275a5132594190;
    uint256 internal constant DELTA_NEG_Y_1 = 0x1c633b28b5d60b25f2b6faac7ce9648c1d4801c14eb4e45b76527a0b40f264fe;

    // K[0] (constant term of the public-input MSM).
    uint256 internal constant K0_X = 0x0ddcee79778bab266779222bb4aa7867684aaa43d2e224fc61d9a41dc9c514cf;
    uint256 internal constant K0_Y = 0x0015dab1bffedad64ce4d1b98a94450627017529cc62a1887c7e8c024addc7b2;

    // K[1..1+N_PUB_EXTENDED] — one G1 point per extended public input.
    // CODEGEN: emit N_PUB_EXTENDED entries (PUB_0_X, PUB_0_Y, ..., PUB_{N-1}_*).
    //<BEGIN_CODEGEN:PUB_BASES>
    uint256 internal constant PUB_0_X = 0x1102bc90fe1dda421bb2e9e939b6e82756bd0a273f63cb91ba17707f540306db; // K[1] — public input #0
    uint256 internal constant PUB_0_Y = 0x1b37d1a9080439767905d4eca25d4dc740e2c7555142c6d942215288d8a3b1fe; // K[1] — public input #0
    uint256 internal constant PUB_1_X = 0x10a8bd275b94f8dc55b9914cbbe5edc087623fb06e393fddade3648471968da6; // K[2] — public input #1
    uint256 internal constant PUB_1_Y = 0x000aacb7214a1d50a884cdcebae7b9e1fcc837c73f7528fc5f00c864debdaee7; // K[2] — public input #1
    uint256 internal constant PUB_2_X = 0x07279462bfb31b82a84c1b6eba802cfcdee12ca46f4aacf4898f484428fa0ba9; // K[3] — public input #2
    uint256 internal constant PUB_2_Y = 0x05e03ae43839bfdc57817c7b0a398c21535d8582561e34a42af876a5871e2d66; // K[3] — public input #2
    uint256 internal constant PUB_3_X = 0x2bec048a1d77762bbcc982ced98ba1826527d69d32f283674216fd594084c1fb; // K[4] — public input #3
    uint256 internal constant PUB_3_Y = 0x23634a47875df7005d7ab7605f98f342a1b73c7abf83f1ea1cbc2b4dd0ee0ee3; // K[4] — public input #3
    uint256 internal constant PUB_4_X = 0x0477c9656c7a2cb88f54d5399677a88dd25ae49266f5973822548ec5641e7350; // K[5] — public input #4
    uint256 internal constant PUB_4_Y = 0x0b724021ec370d3dfa3c42b862db010495aab5bad62ef671a68ea24853a56e22; // K[5] — public input #4
    uint256 internal constant PUB_5_X = 0x1618a7d87e24efcd319047089b2d95770dda5674470a6c707660091112b860b0; // K[6] — public input #5
    uint256 internal constant PUB_5_Y = 0x0a6a3854cf552ac34d61053ed43c32de1691bfca2525810dd38cbf6daae27154; // K[6] — public input #5
    uint256 internal constant PUB_6_X = 0x18fa300f708d5f36d4b642e78a2c30e7bf12ef6385d8bf82caaa48cf82736fe5; // K[7] — public input #6
    uint256 internal constant PUB_6_Y = 0x0e4d58b539dfb4eec43789bfb121a7736382a8cba5d0b954216dc05c6a18d0a4; // K[7] — public input #6
    uint256 internal constant PUB_7_X = 0x19bece4322226754ad31ed7d97ac70955621394d9b0c006ab388afc3d6f466d4; // K[8] — public input #7
    uint256 internal constant PUB_7_Y = 0x14ff43643ba45bcacc4d52a379ab75cec50fc1b6af6275448c004793d7d2f461; // K[8] — public input #7
    uint256 internal constant PUB_8_X = 0x25cb1dde1b3188ba86fab328c35e40e8ac11f644d00f7a54e14dd215b348e240; // K[9] — challenge #0
    uint256 internal constant PUB_8_Y = 0x1ffbaf448026c843b7693b55b24778b4b86fadb178aaf43913fe63d9ab865b80; // K[9] — challenge #0
    uint256 internal constant PUB_9_X = 0x2f764b8c1bed24c683eee9a441b6ca545dccf06c1171024a4cf615b4caacc13f; // K[10] — challenge #1
    uint256 internal constant PUB_9_Y = 0x02e43d6113e5e9782fbed878e9b4ede92a3d2ef4004c2ad8a35f08d5e0973a63; // K[10] — challenge #1
    //<END_CODEGEN:PUB_BASES>

    // Pedersen verifying key (single-commitment template).
    // G is in G2; GSigmaNeg = -σ·G also in G2.
    uint256 internal constant PEDERSEN_G_X_0          = 0x205c57229c49d94b8074c9d3b33498294c7cff5075daed2eab7ee66d48bd7f54;
    uint256 internal constant PEDERSEN_G_X_1          = 0x2f9731607ae1c26475b56c61d823155bd1505187b0f336c3281d9eddaaeac64b;
    uint256 internal constant PEDERSEN_G_Y_0          = 0x20d08ef5e1ee0544063884cb1a5edd1b7734abbdb867bbefa4b19e9abb7c67c7;
    uint256 internal constant PEDERSEN_G_Y_1          = 0x00378cec3cffc2f26786c1763303eef0c3c6268ed737c6079dc46e733c0e5bcc;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_X_0 = 0x219a0ea2276debe9456cecbe135bc99c26a1b2f19783bbf33afe7c6806e56c9e;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_X_1 = 0x29835f52e925e8514b3ba91dde27e86dd566142f09f5762f3e94bb64ce31c82b;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_Y_0 = 0x09404089e24287391bfc94b549b0f8b32f18a0f0b5711b9136764d7c392ed8cc;
    uint256 internal constant PEDERSEN_GSIGMA_NEG_Y_1 = 0x13be48554f9b4f6fdb68715b757fef30c13fe4930a27212afa26208aed6a7804;

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
