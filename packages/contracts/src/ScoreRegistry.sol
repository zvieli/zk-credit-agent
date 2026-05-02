// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

contract ScoreRegistry {
    mapping(address => uint32) public scores;
    address public immutable owner;
    mapping(address => bool) public authorized;

    modifier onlyAuthorized() {
        require(msg.sender == owner || authorized[msg.sender], "not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setAuthorized(address target, bool status) external {
        require(msg.sender == owner, "only owner");
        authorized[target] = status;
    }

    function setScore(address user, uint32 score) external onlyAuthorized {
        scores[user] = score;
    }
}
