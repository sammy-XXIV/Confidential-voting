// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialVoting
/// @notice Voters cast encrypted ballots; the owner ends voting and triggers public KMS decryption.
contract ConfidentialVoting is ZamaEthereumConfig {
    address public owner;

    struct Proposal {
        string name;
        euint64 votesFor;
        euint64 votesAgainst;
        uint256 totalVoters;
        bool votingEnded;
        bool decryptionPending;
        bool resultsRevealed;
        uint64 revealedVotesFor;
        uint64 revealedVotesAgainst;
    }

    uint256 public proposalCount;

    mapping(uint256 => Proposal) private _proposals;
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    euint64 private _encryptedZero;
    euint64 private _encryptedOne;

    event ProposalCreated(uint256 indexed proposalId, string name);
    event VoteCast(address indexed voter, uint256 indexed proposalId);
    event VotingEnded(uint256 indexed proposalId);
    event DecryptionRequested(uint256 indexed proposalId, bytes32 forHandle, bytes32 againstHandle);
    event ResultsRevealed(uint256 indexed proposalId, uint64 votesFor, uint64 votesAgainst);

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

    function createProposal(string calldata name) external onlyOwner {
        uint256 id = proposalCount++;
        _proposals[id].name = name;
        _proposals[id].votesFor = FHE.asEuint64(0);
        _proposals[id].votesAgainst = FHE.asEuint64(0);
        FHE.allowThis(_proposals[id].votesFor);
        FHE.allowThis(_proposals[id].votesAgainst);
        emit ProposalCreated(id, name);
    }

    function castVote(
        uint256 proposalId,
        externalEuint64 encryptedVote,
        bytes calldata inputProof
    ) external {
        require(proposalId < proposalCount, "Invalid proposal");
        require(!_proposals[proposalId].votingEnded, "Voting ended");
        require(!hasVoted[msg.sender][proposalId], "Already voted");

        euint64 vote = FHE.fromExternal(encryptedVote, inputProof);

        euint64 voteFor = FHE.select(FHE.ne(vote, _encryptedZero), _encryptedOne, _encryptedZero);
        euint64 voteAgainst = FHE.select(FHE.eq(vote, _encryptedZero), _encryptedOne, _encryptedZero);

        _proposals[proposalId].votesFor = FHE.add(_proposals[proposalId].votesFor, voteFor);
        FHE.allowThis(_proposals[proposalId].votesFor);

        _proposals[proposalId].votesAgainst = FHE.add(_proposals[proposalId].votesAgainst, voteAgainst);
        FHE.allowThis(_proposals[proposalId].votesAgainst);

        hasVoted[msg.sender][proposalId] = true;
        _proposals[proposalId].totalVoters++;

        emit VoteCast(msg.sender, proposalId);
    }

    function endVoting(uint256 proposalId) external onlyOwner {
        require(proposalId < proposalCount, "Invalid proposal");
        require(!_proposals[proposalId].votingEnded, "Already ended");
        _proposals[proposalId].votingEnded = true;
        emit VotingEnded(proposalId);
    }

    /// @notice Step 1: owner marks both tallies for public KMS decryption.
    ///         Emits handles so the frontend can request decryption from the KMS relayer.
    function revealResults(uint256 proposalId) external onlyOwner {
        require(proposalId < proposalCount, "Invalid proposal");
        require(_proposals[proposalId].votingEnded, "Voting still active");
        require(!_proposals[proposalId].decryptionPending, "Decryption already pending");
        require(!_proposals[proposalId].resultsRevealed, "Already revealed");

        euint64 forHandle = FHE.makePubliclyDecryptable(_proposals[proposalId].votesFor);
        euint64 againstHandle = FHE.makePubliclyDecryptable(_proposals[proposalId].votesAgainst);

        _proposals[proposalId].votesFor = forHandle;
        _proposals[proposalId].votesAgainst = againstHandle;
        _proposals[proposalId].decryptionPending = true;

        emit DecryptionRequested(
            proposalId,
            euint64.unwrap(forHandle),
            euint64.unwrap(againstHandle)
        );
    }

    /// @notice Step 2: anyone submits the KMS decryption result on-chain.
    ///         The contract verifies KMS signatures and stores plaintext tallies.
    /// @param proposalId     Proposal whose tallies are being revealed.
    /// @param handlesList    [forHandle, againstHandle] as bytes32 array (order must match abiEncodedCleartexts).
    /// @param abiEncodedCleartexts  abi.encode(uint64 votesFor, uint64 votesAgainst).
    /// @param decryptionProof       KMS proof returned by instance.publicDecrypt().
    function submitDecryptionResult(
        uint256 proposalId,
        bytes32[] calldata handlesList,
        bytes calldata abiEncodedCleartexts,
        bytes calldata decryptionProof
    ) external {
        require(proposalId < proposalCount, "Invalid proposal");
        require(_proposals[proposalId].decryptionPending, "Decryption not requested");
        require(!_proposals[proposalId].resultsRevealed, "Already revealed");
        require(handlesList.length == 2, "Expected 2 handles");

        // Verify handles match what we stored
        bytes32 forHandle = euint64.unwrap(_proposals[proposalId].votesFor);
        bytes32 againstHandle = euint64.unwrap(_proposals[proposalId].votesAgainst);
        require(handlesList[0] == forHandle && handlesList[1] == againstHandle, "Handle mismatch");

        // Verify KMS signatures — reverts if invalid
        FHE.checkSignatures(handlesList, abiEncodedCleartexts, decryptionProof);

        (uint64 votesFor, uint64 votesAgainst) = abi.decode(abiEncodedCleartexts, (uint64, uint64));

        _proposals[proposalId].revealedVotesFor = votesFor;
        _proposals[proposalId].revealedVotesAgainst = votesAgainst;
        _proposals[proposalId].decryptionPending = false;
        _proposals[proposalId].resultsRevealed = true;

        emit ResultsRevealed(proposalId, votesFor, votesAgainst);
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

    function isDecryptionPending(uint256 proposalId) external view returns (bool) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].decryptionPending;
    }

    function areResultsRevealed(uint256 proposalId) external view returns (bool) {
        require(proposalId < proposalCount, "Invalid proposal");
        return _proposals[proposalId].resultsRevealed;
    }

    /// @notice Returns the raw bytes32 handle for the for-tally (for use with publicDecrypt).
    function getVotesForHandle(uint256 proposalId) external view returns (bytes32) {
        require(proposalId < proposalCount, "Invalid proposal");
        return euint64.unwrap(_proposals[proposalId].votesFor);
    }

    /// @notice Returns the raw bytes32 handle for the against-tally.
    function getVotesAgainstHandle(uint256 proposalId) external view returns (bytes32) {
        require(proposalId < proposalCount, "Invalid proposal");
        return euint64.unwrap(_proposals[proposalId].votesAgainst);
    }

    /// @notice Returns the plaintext vote tally once results are revealed.
    function getRevealedVotesFor(uint256 proposalId) external view returns (uint64) {
        require(_proposals[proposalId].resultsRevealed, "Results not yet revealed");
        return _proposals[proposalId].revealedVotesFor;
    }

    function getRevealedVotesAgainst(uint256 proposalId) external view returns (uint64) {
        require(_proposals[proposalId].resultsRevealed, "Results not yet revealed");
        return _proposals[proposalId].revealedVotesAgainst;
    }
}
