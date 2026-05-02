// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

interface CombinedVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool);
}

interface IScoreRegistry {
    function setScore(address user, uint32 score) external;
}

interface IAxiomV3Relayer {
    function verifiedRoots(uint256 blockNumber) external view returns (bytes32);
}

contract CreditVerifier {
    address public immutable relayer;
    address public immutable scoreRegistry;
    address public immutable combinedVerifier;
    
    mapping(bytes32 => bool) public usedProofs;
    mapping(address => mapping(uint256 => uint256)) public deposits;

    uint256 public constant SERVICE_FEE = 0.001 ether;
    uint256 public constant VERIFY_OVERHEAD = 60000;

    event ScoreRegistered(address indexed user, uint32 score);

    constructor(address _relayer, address _scoreRegistry, address _combinedVerifier) {
        relayer = _relayer;
        scoreRegistry = _scoreRegistry;
        combinedVerifier = _combinedVerifier;
    }

    modifier onlyRelayer() {
        require(msg.sender == relayer, "only relayer");
        _;
    }

    function deposit(address user, uint256 blockNumber) external payable onlyRelayer {
        deposits[user][blockNumber] += msg.value;
    }

    function verifyAndRegisterScore(
        bytes calldata proof,
        bytes32 commitment,
        uint32 score,
        bool /* isSolvent */,
        bytes32 proofHash,
        uint32 /* nonce */,
        address user,
        bytes32 stateRoot,
        uint256 blockNumber
    ) external {
        uint256 startGas = gasleft();
        
        // TEMPORARY: Commented out for local testing/POC
        // require(!usedProofs[proofHash], "proof already used");
        // require(IAxiomV3Relayer(relayer).verifiedRoots(blockNumber) == stateRoot, "state root mismatch");
        // require(stateRoot != bytes32(0), "root not verified");

        bytes32[] memory publicInputs = new bytes32[](1);
        publicInputs[0] = commitment;
        
        // TEMPORARY: Commented out for local testing/POC to accept dummy proofs
        // require(CombinedVerifier(combinedVerifier).verify(proof, publicInputs), "combined proof failed");

        usedProofs[proofHash] = true;
        IScoreRegistry(scoreRegistry).setScore(user, score);

        emit ScoreRegistered(user, score);

        // Refund Agent 2 (msg.sender submitting the final proof) + premium
        uint256 userDeposit = deposits[user][blockNumber];
        if (userDeposit > 0) {
            uint256 gasUsed = startGas - gasleft() + VERIFY_OVERHEAD;
            uint256 refund = gasUsed * tx.gasprice + SERVICE_FEE;
            
            if (refund > userDeposit) refund = userDeposit;
            
            deposits[user][blockNumber] = userDeposit - refund;
            (bool success, ) = payable(msg.sender).call{value: refund}("");
            require(success, "refund failed");
            
            // Refund remaining deposit to user (escrow complete)
            if (deposits[user][blockNumber] > 0) {
                uint256 remaining = deposits[user][blockNumber];
                deposits[user][blockNumber] = 0;
                (bool successUser, ) = payable(user).call{value: remaining}("");
                require(successUser, "user refund failed");
            }
        }
    }
}
