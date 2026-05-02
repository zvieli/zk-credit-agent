// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

import "forge-std/Test.sol";
import "../src/AxiomV3Relayer.sol";
import "../src/CreditVerifier.sol";
import "../src/ScoreRegistry.sol";
import "../src/combined_verifier.sol";

contract MockAxiomQuery {
    function axiomQueryFee() external pure returns (uint256) {
        return 0.01 ether;
    }
    function sendQuery(
        uint64,
        bytes32,
        AxiomV2ComputeQuery calldata,
        AxiomV2Callback calldata,
        AxiomV2FeeData calldata,
        bytes32,
        address,
        bytes calldata
    ) external payable returns (uint256) {
        return 1;
    }
}

contract ZK_Debug is Test {
    using stdJson for string;

    struct Fixture {
        bytes proof;
        bytes32[] publicInputs;
        uint256 nonce;
        uint256 chainId;
        address user;
        uint256 blockNumber;
        bytes32 stateRoot;
        bytes32 accountTrieKey;
        bytes32 storageRoot;
        bytes32 storageProofKey;
        uint32 repaymentRate;
        uint32 score;
        bool isSolvent;
    }

    HonkVerifier public combinedVerifier;
    ScoreRegistry public registry;
    AxiomV3Relayer public relayer;
    CreditVerifier public verifier;
    MockAxiomQuery public mockAxiom;
    Fixture public fixture;
    address public agent = address(0xDE1);

    function _strip0x(string memory value) internal pure returns (string memory) {
        bytes memory raw = bytes(value);
        if (raw.length >= 2 && raw[0] == "0" && raw[1] == "x") {
            bytes memory trimmed = new bytes(raw.length - 2);
            for (uint256 index = 2; index < raw.length; index++) {
                trimmed[index - 2] = raw[index];
            }
            return string(trimmed);
        }
        return value;
    }

    function setUp() public {
        combinedVerifier = new HonkVerifier();
        registry = new ScoreRegistry();
        mockAxiom = new MockAxiomQuery();
        
        relayer = new AxiomV3Relayer(address(mockAxiom), address(0));
        verifier = new CreditVerifier(address(relayer), address(registry), address(combinedVerifier));
        relayer.setCreditVerifier(address(verifier));
        
        registry.setAuthorized(address(verifier), true);

        string memory json = vm.readFile("test/data/combined_proof.hex");
        fixture.proof = json.readBytes(".combinedProof.proof");
        fixture.publicInputs = json.readBytes32Array(".combinedProof.publicInputs");

        fixture.nonce = json.readUint(".scoreInputs.metadata.nonce");
        fixture.chainId = json.readUint(".scoreInputs.metadata.chainId");
        fixture.user = json.readAddress(".scoreInputs.metadata.userAddress");
        fixture.blockNumber = json.readUint(".scoreInputs.metadata.blockNumber");
        fixture.stateRoot = json.readBytes32(".scoreInputs.metadata.stateRoot");
        fixture.accountTrieKey = json.readBytes32(".scoreInputs.metadata.accountTrieKey");
        fixture.storageRoot = json.readBytes32(".scoreInputs.metadata.storageRoot");
        fixture.storageProofKey = json.readBytes32(".scoreInputs.metadata.storageProofKey");
        fixture.repaymentRate = uint32(json.readUint(".scoreInputs.metadata.repaymentRate"));
        fixture.score = uint32(json.readUint(".scoreInputs.metadata.score"));
        fixture.isSolvent = json.readBool(".scoreInputs.metadata.isSolvent");

        // 1. User requests via relayer
        vm.deal(fixture.user, 1 ether);
        vm.prank(fixture.user);
        // Simplified model: Agent takes flat 0.02 ETH. rest goes to Axiom.
        // Total = 0.01 (axiom fee) + 0.02 (deposit) = 0.03
        relayer.request{value: 0.03 ether}(
            uint64(fixture.chainId),
            bytes32(0),
            AxiomV2ComputeQuery(0, 0, new bytes32[](0), ""),
            fixture.blockNumber,
            AxiomV2FeeData(0, 0, 0),
            bytes32(0),
            fixture.user,
            ""
        );

        // 2. Mock Axiom callback triggered by agent
        bytes32[] memory results = new bytes32[](1);
        results[0] = fixture.stateRoot;

        vm.deal(agent, 0.5 ether);
        // Axiom callback must come from mockAxiom address
        vm.prank(address(mockAxiom), agent); 
        relayer.axiomV2Callback(uint64(fixture.chainId), fixture.user, bytes32(0), results, abi.encode(fixture.user, fixture.blockNumber, uint256(0)));

        assertEq(relayer.verifiedRoots(fixture.blockNumber), fixture.stateRoot, "state root should be recorded");
        assertTrue(agent.balance > 0.5 ether, "agent should be refunded for callback gas + fee");
    }

    function test_verifyAndRegisterScore() public {
        bytes32 proofHash = keccak256(fixture.proof);
        uint256 agentBalanceBefore = agent.balance;

        vm.prank(agent);
        verifier.verifyAndRegisterScore(
            fixture.proof,
            fixture.publicInputs[0],
            fixture.score,
            fixture.isSolvent,
            proofHash,
            uint32(fixture.nonce),
            fixture.user,
            fixture.stateRoot,
            fixture.blockNumber
        );

        assertEq(registry.scores(fixture.user), fixture.score, "Score should be registered in registry");
        assertTrue(agent.balance > agentBalanceBefore, "agent should be refunded for verification gas + fee");
    }
}
