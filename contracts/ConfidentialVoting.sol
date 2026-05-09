// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialVoting
/// @notice Voters cast encrypted ballots; the owner ends voting and reveals the final tally.
contract ConfidentialVoting is ZamaEthereumConfig {
    address public owner;

    struct Proposal {
        string name;
        euint64 votesFor;
        euint64 votesAgainst;
        uint256 totalVoters;
        bool votingEnded;
        bool resultsRevealed;
    }

    uint256 public proposalCount;

    // proposalId => Proposal
    mapping(uint256 => Proposal) private _proposals;
    // voter => proposalId => voted
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    // Stored in constructor — never use FHE.asEuint64(0) inline (SKILL.md §4)
    euint64 private _encryptedZero;
    euint64 private _encryptedOne;

    event ProposalCreated(uint256 indexed proposalId, string name);
    event VoteCast(address indexed voter, uint256 indexed proposalId);
    event VotingEnded(uint256 indexed proposalId);
    event ResultsRevealed(uint256 indexed proposalId);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        _encryptedZero = FHE.asEuint64(0);
        _encryptedOne = FHE.asEuint64(1);
        FHE.allowThis(_encryptedZero);
        FHE.allowThis(_encryptedOne);
    }

    /// @notice Owner creates a new proposal.
    function createProposal(string calldata name) external onlyOwner {
        uint256 id = proposalCount++;
        _proposals[id].name = name;
        _proposals[id].votesFor = FHE.asEuint64(0);
        _proposals[id].votesAgainst = FHE.asEuint64(0);
        FHE.allowThis(_proposals[id].votesFor);
        FHE.allowThis(_proposals[id].votesAgainst);
        emit ProposalCreated(id, name);
    }

    /// @notice Cast an encrypted vote: 1 = for, 0 = against.
    /// @param proposalId   Proposal to vote on.
    /// @param encryptedVote  User-encrypted euint64 (1 = for, 0 = against).
    /// @param inputProof   ZKP proof for the encrypted input.
    function castVote(
        uint256 proposalId,
        externalEuint64 encryptedVote,
        bytes calldata inputProof
    ) external {
        require(proposalId < proposalCount, "Invalid proposal");
        require(!_proposals[proposalId].votingEnded, "Voting ended");
        require(!hasVoted[msg.sender][proposalId], "Already voted");

        euint64 vote = FHE.fromExternal(encryptedVote, inputProof);

        // Interpret vote: non-zero → for, zero → against
        euint64 voteFor = FHE.select(FHE.ne(vote, _encryptedZero), _encryptedOne, _encryptedZero);
        euint64 voteAgainst = FHE.select(FHE.eq(vote, _encryptedZero), _encryptedOne, _encryptedZero);

        // Re-grant after every FHE storage update (SKILL.md §20 — stale handle anti-pattern)
        _proposals[proposalId].votesFor = FHE.add(_proposals[proposalId].votesFor, voteFor);
        FHE.allowThis(_proposals[proposalId].votesFor);

        _proposals[proposalId].votesAgainst = FHE.add(_proposals[proposalId].votesAgainst, voteAgainst);
        FHE.allowThis(_proposals[proposalId].votesAgainst);

        hasVoted[msg.sender][proposalId] = true;
        _proposals[proposalId].totalVoters++;

        emit VoteCast(msg.sender, proposalId);
    }

    /// @notice Owner closes voting on a proposal.
    function endVoting(uint256 proposalId) external onlyOwner {
        require(proposalId < proposalCount, "Invalid proposal");
        require(!_proposals[proposalId].votingEnded, "Already ended");
        _proposals[proposalId].votingEnded = true;
        emit VotingEnded(proposalId);
    }

    /// @notice Owner reveals the final tally.
    ///         Grants the owner FHE access to both encrypted counters so they can
    ///         decrypt off-chain via EIP-712 userDecrypt.
    function revealResults(uint256 proposalId) external onlyOwner {
        require(proposalId < proposalCount, "Invalid proposal");
        require(_proposals[proposalId].votingEnded, "Voting still active");
        require(!_proposals[proposalId].resultsRevealed, "Already revealed");

        // Grant owner decryption access to both tallies
        FHE.allow(_proposals[proposalId].votesFor, msg.sender);
        FHE.allow(_proposals[proposalId].votesAgainst, msg.sender);

        _proposals[proposalId].resultsRevealed = true;
        emit ResultsRevealed(proposalId);
    }

    // ─── View / getter functions ───────────────────────────────────────────

    function getProposalName(uint256 proposalId) external view returns (string memory) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].name;
    }

    function getTotalVoters(uint256 proposalId) external view returns (uint256) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].totalVoters;
    }

    function isVotingEnded(uint256 proposalId) external view returns (bool) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].votingEnded;
    }

    function areResultsRevealed(uint256 proposalId) external view returns (bool) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].resultsRevealed;
    }

    /// @notice Returns the encrypted votes-for handle after owner has revealed results.
    ///         The returned bytes32 can be decrypted by the owner via EIP-712 userDecrypt.
    function getRevealedVotesFor(uint256 proposalId) external view returns (euint64) {
        require(_proposals[proposalId].resultsRevealed, "Results not yet revealed");
        return _proposals[proposalId].votesFor;
    }

    /// @notice Returns the encrypted votes-against handle after owner has revealed results.
    function getRevealedVotesAgainst(uint256 proposalId) external view returns (euint64) {
        require(_proposals[proposalId].resultsRevealed, "Results not yet revealed");
        return _proposals[proposalId].votesAgainst;
    }
}
