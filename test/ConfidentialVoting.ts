import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  owner: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = await ethers.getContractFactory("ConfidentialVoting");
  const contract = await factory.deploy();
  const contractAddress = await contract.getAddress();
  return { contract, contractAddress };
}

describe("ConfidentialVoting", function () {
  let signers: Signers;
  let contract: Awaited<ReturnType<typeof deployFixture>>["contract"];
  let contractAddress: string;

  before(async function () {
    const all: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { owner: all[0], alice: all[1], bob: all[2], carol: all[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("Skipping: these tests require the mock FHE environment");
      this.skip();
    }
    ({ contract, contractAddress } = await deployFixture());
  });

  // ─── Deployment ───────────────────────────────────────────────────────────

  it("deploys successfully and sets owner", async function () {
    expect(await contract.getAddress()).to.be.properAddress;
    expect(await contract.owner()).to.equal(signers.owner.address);
    expect(await contract.proposalCount()).to.equal(0);
  });

  // ─── createProposal ───────────────────────────────────────────────────────

  it("owner can create a proposal", async function () {
    await contract.connect(signers.owner).createProposal("Upgrade protocol?");
    expect(await contract.proposalCount()).to.equal(1);
    expect(await contract.getProposalName(0)).to.equal("Upgrade protocol?");
  });

  it("non-owner cannot create a proposal", async function () {
    await expect(
      contract.connect(signers.alice).createProposal("Rogue proposal")
    ).to.be.revertedWith("Not owner");
  });

  it("multiple proposals get sequential ids", async function () {
    await contract.connect(signers.owner).createProposal("Proposal A");
    await contract.connect(signers.owner).createProposal("Proposal B");
    expect(await contract.proposalCount()).to.equal(2);
    expect(await contract.getProposalName(1)).to.equal("Proposal B");
  });

  // ─── castVote ─────────────────────────────────────────────────────────────

  it("voter can cast an encrypted 'for' vote", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");

    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signers.alice.address)
      .add64(1n)
      .encrypt();

    const tx = await contract
      .connect(signers.alice)
      .castVote(0, encrypted.handles[0], encrypted.inputProof);
    await tx.wait();

    expect(await contract.hasVoted(signers.alice.address, 0)).to.be.true;
    expect(await contract.getTotalVoters(0)).to.equal(1);
  });

  it("voter can cast an encrypted 'against' vote", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");

    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signers.bob.address)
      .add64(0n)
      .encrypt();

    const tx = await contract
      .connect(signers.bob)
      .castVote(0, encrypted.handles[0], encrypted.inputProof);
    await tx.wait();

    expect(await contract.hasVoted(signers.bob.address, 0)).to.be.true;
    expect(await contract.getTotalVoters(0)).to.equal(1);
  });

  it("rejects double voting", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");

    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signers.alice.address)
      .add64(1n)
      .encrypt();

    await (
      await contract
        .connect(signers.alice)
        .castVote(0, encrypted.handles[0], encrypted.inputProof)
    ).wait();

    await expect(
      contract
        .connect(signers.alice)
        .castVote(0, encrypted.handles[0], encrypted.inputProof)
    ).to.be.revertedWith("Already voted");
  });

  it("rejects vote on invalid proposal", async function () {
    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signers.alice.address)
      .add64(1n)
      .encrypt();

    await expect(
      contract.connect(signers.alice).castVote(99, encrypted.handles[0], encrypted.inputProof)
    ).to.be.revertedWith("Invalid proposal");
  });

  it("rejects vote after voting ends", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await contract.connect(signers.owner).endVoting(0);

    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signers.alice.address)
      .add64(1n)
      .encrypt();

    await expect(
      contract.connect(signers.alice).castVote(0, encrypted.handles[0], encrypted.inputProof)
    ).to.be.revertedWith("Voting ended");
  });

  // ─── endVoting ────────────────────────────────────────────────────────────

  it("owner can end voting", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    expect(await contract.isVotingEnded(0)).to.be.false;

    await contract.connect(signers.owner).endVoting(0);
    expect(await contract.isVotingEnded(0)).to.be.true;
  });

  it("non-owner cannot end voting", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await expect(contract.connect(signers.alice).endVoting(0)).to.be.revertedWith("Not owner");
  });

  it("cannot end voting twice", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await contract.connect(signers.owner).endVoting(0);
    await expect(contract.connect(signers.owner).endVoting(0)).to.be.revertedWith("Already ended");
  });

  // ─── revealResults ────────────────────────────────────────────────────────

  it("only owner can reveal results", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await contract.connect(signers.owner).endVoting(0);
    await expect(
      contract.connect(signers.alice).revealResults(0)
    ).to.be.revertedWith("Not owner");
  });

  it("cannot reveal before voting ends", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await expect(
      contract.connect(signers.owner).revealResults(0)
    ).to.be.revertedWith("Voting still active");
  });

  it("cannot reveal twice", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await contract.connect(signers.owner).endVoting(0);
    await contract.connect(signers.owner).revealResults(0);
    await expect(
      contract.connect(signers.owner).revealResults(0)
    ).to.be.revertedWith("Already revealed");
  });

  it("getRevealedVotesFor reverts before reveal", async function () {
    await contract.connect(signers.owner).createProposal("Test proposal");
    await contract.connect(signers.owner).endVoting(0);
    await expect(contract.getRevealedVotesFor(0)).to.be.revertedWith("Results not yet revealed");
  });

  // ─── Full voting flow with tally decryption ───────────────────────────────

  it("correctly tallies 2 for and 1 against, owner decrypts after reveal", async function () {
    await contract.connect(signers.owner).createProposal("Adopt FHEVM?");

    // alice votes for (1)
    const aliceVote = await fhevm
      .createEncryptedInput(contractAddress, signers.alice.address)
      .add64(1n)
      .encrypt();
    await (
      await contract.connect(signers.alice).castVote(0, aliceVote.handles[0], aliceVote.inputProof)
    ).wait();

    // bob votes for (1)
    const bobVote = await fhevm
      .createEncryptedInput(contractAddress, signers.bob.address)
      .add64(1n)
      .encrypt();
    await (
      await contract.connect(signers.bob).castVote(0, bobVote.handles[0], bobVote.inputProof)
    ).wait();

    // carol votes against (0)
    const carolVote = await fhevm
      .createEncryptedInput(contractAddress, signers.carol.address)
      .add64(0n)
      .encrypt();
    await (
      await contract.connect(signers.carol).castVote(0, carolVote.handles[0], carolVote.inputProof)
    ).wait();

    expect(await contract.getTotalVoters(0)).to.equal(3);

    // End voting and reveal
    await (await contract.connect(signers.owner).endVoting(0)).wait();
    await (await contract.connect(signers.owner).revealResults(0)).wait();
    expect(await contract.areResultsRevealed(0)).to.be.true;

    // Read encrypted handles (view calls)
    const votesForHandle = await contract.getRevealedVotesFor(0);
    const votesAgainstHandle = await contract.getRevealedVotesAgainst(0);

    // Decrypt — owner was granted FHE.allow in revealResults
    const votesFor = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesForHandle,
      contractAddress,
      signers.owner,
    );
    const votesAgainst = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesAgainstHandle,
      contractAddress,
      signers.owner,
    );

    expect(votesFor).to.equal(2n);
    expect(votesAgainst).to.equal(1n);
  });

  it("tally is correct for unanimous 'against' vote", async function () {
    await contract.connect(signers.owner).createProposal("Reject everything");

    for (const voter of [signers.alice, signers.bob]) {
      const enc = await fhevm
        .createEncryptedInput(contractAddress, voter.address)
        .add64(0n)
        .encrypt();
      await (await contract.connect(voter).castVote(0, enc.handles[0], enc.inputProof)).wait();
    }

    await (await contract.connect(signers.owner).endVoting(0)).wait();
    await (await contract.connect(signers.owner).revealResults(0)).wait();

    const votesForHandle = await contract.getRevealedVotesFor(0);
    const votesAgainstHandle = await contract.getRevealedVotesAgainst(0);

    const votesFor = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesForHandle,
      contractAddress,
      signers.owner,
    );
    const votesAgainst = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesAgainstHandle,
      contractAddress,
      signers.owner,
    );

    expect(votesFor).to.equal(0n);
    expect(votesAgainst).to.equal(2n);
  });

  it("tally is correct with no votes cast", async function () {
    await contract.connect(signers.owner).createProposal("Empty proposal");
    await (await contract.connect(signers.owner).endVoting(0)).wait();
    await (await contract.connect(signers.owner).revealResults(0)).wait();

    const votesForHandle = await contract.getRevealedVotesFor(0);
    const votesAgainstHandle = await contract.getRevealedVotesAgainst(0);

    const votesFor = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesForHandle,
      contractAddress,
      signers.owner,
    );
    const votesAgainst = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      votesAgainstHandle,
      contractAddress,
      signers.owner,
    );

    expect(votesFor).to.equal(0n);
    expect(votesAgainst).to.equal(0n);
  });
});
