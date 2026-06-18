// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

import "@axiom-crypto/v2-periphery/src/AxiomV2Client.sol";

struct AxiomV2ComputeQuery {
    uint8 k;
    uint16 resultLen;
    bytes32[] vkey;
    bytes computeProof;
}

struct AxiomV2Callback {
    address target;
    bytes extraData;
}

struct AxiomV2FeeData {
    uint64 maxFeePerGas;
    uint32 callbackGasLimit;
    uint256 overrideAxiomQueryFee;
}

interface IAxiomV2Query {
    function axiomQueryFee() external view returns (uint256);
    function sendQuery(
        uint64 sourceChainId,
        bytes32 dataQueryHash,
        AxiomV2ComputeQuery calldata computeQuery,
        AxiomV2Callback calldata callback,
        AxiomV2FeeData calldata feeData,
        bytes32 userSalt,
        address refundee,
        bytes calldata dataQuery
    ) external payable returns (uint256 queryId);
}

interface ICreditVerifier {
    function deposit(address user, uint256 blockNumber) external payable;
    function depositAxiomFee(address user, uint256 blockNumber, uint256 amount) external returns (uint256);
}

contract AxiomV3Relayer is AxiomV2Client {
    mapping(uint256 => bytes32) public verifiedRoots;
    mapping(uint256 => address) public queryToUser;
    mapping(uint256 => uint256) public queryToBlock;
    mapping(uint256 => uint256) public deposits;
    mapping(uint256 => uint256) public nonceToQueryId;
    
    uint256 public nextNonce;
    address public creditVerifier;
    uint256 public constant SERVICE_FEE = 0.001 ether;
    uint256 public constant CALLBACK_OVERHEAD = 50000;

    event QueryRequested(uint256 indexed queryId, address indexed user, uint256 blockNumber);
    event AxiomResultsConsumed(uint256 indexed blockNumber, bytes32 stateRoot);

    constructor(address _axiomV2QueryAddress, address _creditVerifier) AxiomV2Client(_axiomV2QueryAddress) {
        creditVerifier = _creditVerifier;
    }

    receive() external payable {}

    function setCreditVerifier(address _creditVerifier) external {
        // In a real protocol, this would be restricted to an admin/owner
        creditVerifier = _creditVerifier;
    }

    function request(
        uint64 sourceChainId,
        bytes32 dataQueryHash,
        AxiomV2ComputeQuery calldata computeQuery,
        address user,
        uint256 blockNumber,
        AxiomV2FeeData calldata feeData,
        bytes32 userSalt,
        address refundee,
        bytes calldata dataQuery,
        uint256 pullAmount
    ) external payable returns (uint256 queryId) {
        uint256 depositRequired = 0.02 ether;
        require(msg.value == 0, "use escrow funding");
        require(pullAmount >= depositRequired + 0.01 ether, "insufficient gas deposit");

        uint256 escrowedValue = ICreditVerifier(creditVerifier).depositAxiomFee(user, blockNumber, pullAmount);
        uint256 axiomValue = escrowedValue - depositRequired;

        uint256 nonce = nextNonce++;
        queryId = IAxiomV2Query(axiomV2QueryAddress).sendQuery{value: axiomValue}(
            sourceChainId,
            dataQueryHash,
            computeQuery,
            AxiomV2Callback(address(this), abi.encode(user, blockNumber, nonce)),
            feeData,
            userSalt,
            refundee,
            dataQuery
        );
        
        nonceToQueryId[nonce] = queryId;
        queryToUser[queryId] = user;
        queryToBlock[queryId] = blockNumber;
        deposits[queryId] = depositRequired;

        emit QueryRequested(queryId, user, blockNumber);
    }

    function _axiomV2Callback(
        uint64,
        address,
        bytes32,
        bytes32[] memory results,
        bytes memory extraData
    ) internal override {
        uint256 startGas = gasleft();
        require(results.length > 0, "missing Axiom results");

        (address user, uint256 blockNumber, uint256 nonce) = abi.decode(extraData, (address, uint256, uint256));
        uint256 queryId = nonceToQueryId[nonce];
        require(queryId != 0, "invalid query nonce");

        bytes32 stateRoot = results[0];
        require(blockNumber != 0, "invalid block number");
        require(stateRoot != bytes32(0), "missing state root");

        verifiedRoots[blockNumber] = stateRoot;
        emit AxiomResultsConsumed(blockNumber, stateRoot);

        // Calculate and issue Split Refund for Axiom callback gas + premium
        uint256 gasUsed = startGas - gasleft() + CALLBACK_OVERHEAD;
        uint256 refund = gasUsed * tx.gasprice + SERVICE_FEE;
        
        uint256 depositAmount = deposits[queryId];
        if (refund > depositAmount) refund = depositAmount;
        
        // Refund the agent (tx.origin) who triggered the fulfillment
        (bool success, ) = payable(tx.origin).call{value: refund}("");
        if (!success) {
            refund = 0;
        }

        deposits[queryId] = depositAmount - refund;

        // Escrow remaining funds to the CreditVerifier for the final step
        uint256 escrowAmount = deposits[queryId];
        if (escrowAmount > address(this).balance) {
            escrowAmount = address(this).balance;
        }
        if (escrowAmount > 0) {
            deposits[queryId] = 0;
            ICreditVerifier(creditVerifier).deposit{value: escrowAmount}(user, blockNumber);
        }
    }
}
