// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IClaimAgeGate {
    function verifyClaimAge(
        bytes32 claimHash, bytes32 nonce, uint256 expiresAt,
        bytes calldata proof, uint256[8] calldata inputs
    ) external view returns (bool);
}

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Testnet demo. Pays a registered JPYC benefit once per recipient when the
/// gate accepts an age proof bound to this office's own claim hash.
/// Only the operator (the benefit-office Worker) may submit claims.
/// The gate's trust assumptions apply: single-party setup, unaudited,
/// no certificate revocation check.
/// Call `claim` with eth_call first: a tampered proof makes the verifier
/// consume all forwarded gas before the gate returns false.
contract BenefitOffice {
    uint256 public constant MIN_AGE = 20;

    IERC20Like public immutable jpyc;
    IClaimAgeGate public immutable gate;
    address public immutable owner;
    address public operator;

    mapping(bytes32 benefitId => uint256 amount) public benefitAmount;
    mapping(bytes32 benefitId => mapping(address recipient => bool)) public paid;

    event BenefitRegistered(bytes32 indexed benefitId, uint256 amountWei);
    event OperatorChanged(address operator);
    event BenefitPaid(bytes32 indexed benefitId, address indexed recipient, bytes32 claimHash, uint256 amountWei);

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error UnsupportedMinAge();
    error ZeroAmount();
    error UnknownBenefit();
    error AlreadyPaid();
    error ProofRejected();
    error TransferFailed();

    constructor(IERC20Like jpyc_, IClaimAgeGate gate_, address operator_) {
        if (address(jpyc_) == address(0) || address(gate_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        jpyc = jpyc_;
        gate = gate_;
        owner = msg.sender;
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    /// The circuit proves exactly age >= 20, so no other minimum can be offered.
    function registerBenefit(bytes32 id, uint256 amountWei, uint256 minAge) external onlyOwner {
        if (minAge != MIN_AGE) revert UnsupportedMinAge();
        if (amountWei == 0) revert ZeroAmount();
        benefitAmount[id] = amountWei;
        emit BenefitRegistered(id, amountWei);
    }

    function claimHashOf(bytes32 benefitId, address recipient) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), benefitId, recipient, benefitAmount[benefitId], MIN_AGE));
    }

    function claim(
        bytes32 benefitId, address recipient, bytes32 nonce, uint256 expiresAt,
        bytes calldata proof, uint256[8] calldata inputs
    ) external {
        if (msg.sender != operator) revert NotOperator();
        uint256 amount = benefitAmount[benefitId];
        if (amount == 0) revert UnknownBenefit();
        if (recipient == address(0)) revert ZeroAddress();
        if (paid[benefitId][recipient]) revert AlreadyPaid();
        bytes32 claimHash = claimHashOf(benefitId, recipient);
        if (!gate.verifyClaimAge(claimHash, nonce, expiresAt, proof, inputs)) revert ProofRejected();
        paid[benefitId][recipient] = true;
        if (!jpyc.transfer(recipient, amount)) revert TransferFailed();
        emit BenefitPaid(benefitId, recipient, claimHash, amount);
    }

    function withdraw(uint256 amount) external onlyOwner {
        if (!jpyc.transfer(owner, amount)) revert TransferFailed();
    }
}
