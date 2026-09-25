// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BenefitOffice, IClaimAgeGate, IERC20Like} from "../src/BenefitOffice.sol";

/// BENEFIT_AGE_GATE (required) picks the gate this office trusts for good.
/// BENEFIT_OPERATOR defaults to the deployer until the Worker's EOA is known;
/// the owner can change it later with setOperator.
/// BENEFIT_FUNDING (wei, default 0) is transferred from the deployer's JPYC.
contract DeployBenefitOffice is Script {
    bytes32 constant YOUTH = keccak256("youth-support-2026");

    function run() external {
        IClaimAgeGate gate = IClaimAgeGate(vm.envAddress("BENEFIT_AGE_GATE"));
        IERC20Like jpyc = IERC20Like(vm.envOr("JPYC_ADDRESS", address(0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29)));
        vm.startBroadcast();
        address operator = vm.envOr("BENEFIT_OPERATOR", msg.sender);
        BenefitOffice office = new BenefitOffice(jpyc, gate, operator);
        office.registerBenefit(YOUTH, 500e18, 20);
        uint256 funding = vm.envOr("BENEFIT_FUNDING", uint256(0));
        if (funding != 0) require(jpyc.transfer(address(office), funding), "funding transfer failed");
        vm.stopBroadcast();

        console.log("BenefitOffice", address(office));
        console.log("gate", address(gate));
        console.log("operator", operator);
    }
}
