import { BrowserProvider, Contract, ethers } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";

// ─── Constants ────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = "0x227189c0D8A1f732242d57b6F6ca776fcf14B1D8";
const SEPOLIA_CHAIN_ID = 11155111;

// euint64 is bytes32 in ethers ABI (SKILL.md §16)
const ABI = [
  "function owner() external view returns (address)",
  "function proposalCount() external view returns (uint256)",
  "function getProposalName(uint256) external view returns (string)",
  "function hasVoted(address, uint256) external view returns (bool)",
  "function getTotalVoters(uint256) external view returns (uint256)",
  "function isVotingEnded(uint256) external view returns (bool)",
  "function areResultsRevealed(uint256) external view returns (bool)",
  "function getRevealedVotesFor(uint256) external view returns (bytes32)",
  "function getRevealedVotesAgainst(uint256) external view returns (bytes32)",
  "function castVote(uint256, bytes32, bytes) external",
  "function endVoting(uint256) external",
  "function revealResults(uint256) external",
  "function createProposal(string) external",
];

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  walletAddress: null,
  provider: null,
  signer: null,
  contract: null,
  roContract: null, // read-only, no signer needed
  fhevmInstance: null,
  isOwner: false,
  proposals: [],
  loading: false,
  chainOk: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toHex(val) {
  if (typeof val === "string" && val.startsWith("0x")) return val;
  if (val instanceof Uint8Array || Array.isArray(val)) {
    return "0x" + Array.from(val).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return String(val);
}

function shortAddr(addr) {
  return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";
}

// ─── Toast notifications ──────────────────────────────────────────────────────
function toast(type, title, msg, durationMs = 5000) {
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <div class="toast-icon">${icons[type] || "ℹ️"}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${msg ? `<div class="toast-msg">${msg}</div>` : ""}
    </div>`;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ─── FHE overlay ──────────────────────────────────────────────────────────────
function showFheOverlay(title, msg) {
  document.getElementById("fhe-overlay-title").textContent = title;
  document.getElementById("fhe-overlay-msg").textContent = msg;
  document.getElementById("fhe-overlay").style.display = "flex";
}
function hideFheOverlay() {
  document.getElementById("fhe-overlay").style.display = "none";
}

// ─── FHEVM instance ───────────────────────────────────────────────────────────
async function getFhevmInstance() {
  if (state.fhevmInstance) return state.fhevmInstance;
  if (!window.ethereum) throw new Error("MetaMask not found");
  state.fhevmInstance = await createInstance({
    ...SepoliaConfig,
    network: window.ethereum,
  });
  return state.fhevmInstance;
}

// ─── Wallet connection ────────────────────────────────────────────────────────
async function connectWallet() {
  if (!window.ethereum) {
    toast("error", "MetaMask not found", "Please install MetaMask to use this app.");
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!accounts.length) return;
    await setupWallet(accounts[0]);
  } catch (e) {
    toast("error", "Connection failed", e.message);
  }
}

async function setupWallet(address) {
  state.walletAddress = address;
  state.provider = new BrowserProvider(window.ethereum);
  state.signer = await state.provider.getSigner();
  state.contract = new Contract(CONTRACT_ADDRESS, ABI, state.signer);

  // Read-only provider via public RPC for reliability
  const roProvider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  state.roContract = new Contract(CONTRACT_ADDRESS, ABI, roProvider);

  const network = await state.provider.getNetwork();
  state.chainOk = Number(network.chainId) === SEPOLIA_CHAIN_ID;

  const owner = await state.roContract.owner();
  state.isOwner = address.toLowerCase() === owner.toLowerCase();

  updateHeader();
  checkNetwork();

  if (state.chainOk) {
    document.getElementById("not-connected").style.display = "none";
    document.getElementById("content").style.display = "block";
    if (state.isOwner) document.getElementById("owner-panel").style.display = "block";
    await loadProposals();
  }
}

function updateHeader() {
  const { walletAddress } = state;
  document.getElementById("wallet-addr").textContent = shortAddr(walletAddress);
  document.getElementById("wallet-status").style.display = "flex";
  document.getElementById("connect-btn").textContent = "Connected";
  document.getElementById("connect-btn").disabled = true;
  document.getElementById("hero-connect-btn").textContent = "Connected";
  document.getElementById("hero-connect-btn").disabled = true;
}

function checkNetwork() {
  const warn = document.getElementById("network-warning");
  if (!state.chainOk) {
    warn.style.display = "flex";
    document.getElementById("content").style.display = "none";
  } else {
    warn.style.display = "none";
  }
}

async function switchNetwork() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  } catch (e) {
    toast("error", "Switch failed", "Please manually switch to Sepolia in MetaMask.");
  }
}

// ─── Load proposals ───────────────────────────────────────────────────────────
async function loadProposals() {
  const grid = document.getElementById("proposals-grid");
  const noP = document.getElementById("no-proposals");
  const loading = document.getElementById("proposals-loading");

  grid.innerHTML = "";
  loading.style.display = "block";
  noP.style.display = "none";

  try {
    const count = Number(await state.roContract.proposalCount());
    if (count === 0) {
      loading.style.display = "none";
      noP.style.display = "block";
      return;
    }

    const proposals = await Promise.all(
      Array.from({ length: count }, (_, i) => loadProposal(i))
    );
    state.proposals = proposals;
    loading.style.display = "none";
    renderProposals();
  } catch (e) {
    loading.style.display = "none";
    toast("error", "Failed to load proposals", e.message);
  }
}

async function loadProposal(id) {
  const [name, totalVoters, votingEnded, resultsRevealed, userHasVoted] =
    await Promise.all([
      state.roContract.getProposalName(id),
      state.roContract.getTotalVoters(id),
      state.roContract.isVotingEnded(id),
      state.roContract.areResultsRevealed(id),
      state.walletAddress ? state.roContract.hasVoted(state.walletAddress, id) : Promise.resolve(false),
    ]);

  return {
    id,
    name,
    totalVoters: Number(totalVoters),
    votingEnded,
    resultsRevealed,
    userHasVoted,
    votesFor: null,
    votesAgainst: null,
    decryptError: null,
  };
}

// ─── Render proposals ──────────────────────────────────────────────────────────
function renderProposals() {
  const grid = document.getElementById("proposals-grid");
  grid.innerHTML = "";
  for (const p of state.proposals) {
    grid.appendChild(renderCard(p));
  }
}

function renderCard(p) {
  const card = document.createElement("div");
  card.className = "proposal-card";
  card.id = `card-${p.id}`;

  const statusBadge = p.resultsRevealed
    ? `<span class="badge badge-revealed">Revealed</span>`
    : p.votingEnded
    ? `<span class="badge badge-ended">Ended</span>`
    : `<span class="badge badge-active">Active</span>`;

  const votedBadge = p.userHasVoted
    ? `<span class="badge badge-voted">✓ Voted</span>`
    : "";

  let voteSection = "";
  if (!p.votingEnded && !p.userHasVoted) {
    voteSection = `
      <div class="vote-section">
        <div class="vote-label">Cast Encrypted Vote</div>
        <div class="vote-buttons">
          <button class="btn vote-btn-for" onclick="window._voteFor(${p.id})">👍 For</button>
          <button class="btn vote-btn-against" onclick="window._voteAgainst(${p.id})">👎 Against</button>
        </div>
      </div>`;
  } else if (!p.votingEnded && p.userHasVoted) {
    voteSection = `<div class="vote-section"><div class="vote-label">✓ Your vote has been recorded (encrypted)</div></div>`;
  }

  let resultsSection = "";
  if (p.resultsRevealed) {
    if (p.votesFor !== null && p.votesAgainst !== null) {
      const total = Number(p.votesFor) + Number(p.votesAgainst);
      const forPct  = total ? Math.round((Number(p.votesFor) / total) * 100) : 0;
      const agPct   = total ? Math.round((Number(p.votesAgainst) / total) * 100) : 0;
      resultsSection = `
        <div class="results-section">
          <div class="vote-label">Final Tally</div>
          <div class="result-row">
            <span class="result-label" style="color:var(--green)">For</span>
            <div class="result-bar-wrap">
              <div class="result-bar result-bar-for" style="width:${forPct}%"></div>
            </div>
            <span class="result-count" style="color:var(--green)">${p.votesFor}</span>
          </div>
          <div class="result-row">
            <span class="result-label" style="color:var(--red)">Against</span>
            <div class="result-bar-wrap">
              <div class="result-bar result-bar-against" style="width:${agPct}%"></div>
            </div>
            <span class="result-count" style="color:var(--red)">${p.votesAgainst}</span>
          </div>
        </div>`;
    } else if (p.decryptError) {
      resultsSection = `
        <div class="results-section">
          <div class="vote-label">Final Tally</div>
          <p class="decrypt-note">⚠️ Decryption requires the owner's wallet. ${p.decryptError}</p>
          ${state.isOwner ? `<button class="btn btn-sm btn-purple" onclick="window._decryptResults(${p.id})">Decrypt Tally</button>` : ""}
        </div>`;
    } else if (state.isOwner) {
      resultsSection = `
        <div class="results-section">
          <div class="vote-label">Final Tally (owner only)</div>
          <button class="btn btn-sm btn-purple" onclick="window._decryptResults(${p.id})">🔓 Decrypt Tally</button>
        </div>`;
    } else {
      resultsSection = `
        <div class="results-section">
          <div class="vote-label">Results Revealed</div>
          <p class="decrypt-note">Waiting for owner to decrypt and display the final counts.</p>
        </div>`;
    }
  }

  let adminSection = "";
  if (state.isOwner) {
    let ownerBtns = "";
    if (!p.votingEnded) {
      ownerBtns = `<button class="btn btn-sm btn-danger" onclick="window._endVoting(${p.id})">⏹ End Voting</button>`;
    } else if (!p.resultsRevealed) {
      ownerBtns = `<button class="btn btn-sm btn-purple" onclick="window._revealResults(${p.id})">🔓 Reveal Results</button>`;
    }
    if (ownerBtns) {
      adminSection = `
        <div class="admin-section">
          <div class="admin-label">Owner Actions</div>
          <div class="btn-group">${ownerBtns}</div>
        </div>`;
    }
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-id">#${p.id}</div>
    </div>
    <div class="card-meta">
      ${statusBadge}
      ${votedBadge}
      <span class="card-voters">${p.totalVoters} voter${p.totalVoters !== 1 ? "s" : ""}</span>
    </div>
    ${voteSection}
    ${resultsSection}
    ${adminSection}
  `;
  return card;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Vote actions ─────────────────────────────────────────────────────────────
async function castVote(proposalId, voteValue) {
  if (!state.signer) return toast("error", "Not connected", "Connect your wallet first.");
  if (!state.chainOk) return toast("error", "Wrong network", "Switch to Sepolia.");

  showFheOverlay("Encrypting Vote…", "Creating FHE-encrypted ballot. This may take a few seconds.");
  try {
    const instance = await getFhevmInstance();

    const checksumContract = ethers.getAddress(CONTRACT_ADDRESS);
    const checksumUser = ethers.getAddress(state.walletAddress);

    const encrypted = await instance
      .createEncryptedInput(checksumContract, checksumUser)
      .add64(voteValue)
      .encrypt();

    const handle = toHex(encrypted.handles[0]);
    const inputProof = toHex(encrypted.inputProof);

    showFheOverlay("Sending Transaction…", "FHE operations on Sepolia take 5–30 seconds. Please wait.");

    // Never rely on gas estimation on Sepolia (SKILL.md §10)
    const tx = await state.contract.castVote(proposalId, handle, inputProof, {
      gasLimit: 1_000_000n,
    });
    const etherscanLink = `<a href="https://sepolia.etherscan.io/tx/${tx.hash}" target="_blank">View on Etherscan</a>`;
    toast("info", "Transaction sent", etherscanLink, 8000);

    await tx.wait();
    hideFheOverlay();
    toast("success", "Vote cast!", "Your encrypted vote has been recorded on-chain.");

    // Refresh this proposal
    const updated = await loadProposal(proposalId);
    state.proposals[proposalId] = updated;
    renderProposals();
  } catch (e) {
    hideFheOverlay();
    const msg = e.code === "ACTION_REJECTED" ? "Transaction rejected." : e.message?.slice(0, 160);
    toast("error", "Vote failed", msg);
  }
}

// ─── Owner: end voting ────────────────────────────────────────────────────────
async function endVoting(proposalId) {
  if (!state.isOwner) return;
  showFheOverlay("Ending Voting…", "Sending transaction to close the proposal.");
  try {
    const tx = await state.contract.endVoting(proposalId, { gasLimit: 200_000n });
    await tx.wait();
    hideFheOverlay();
    toast("success", "Voting ended", `Proposal #${proposalId} is now closed.`);
    const updated = await loadProposal(proposalId);
    state.proposals[proposalId] = updated;
    renderProposals();
  } catch (e) {
    hideFheOverlay();
    toast("error", "Transaction failed", e.message?.slice(0, 160));
  }
}

// ─── Owner: reveal results ────────────────────────────────────────────────────
async function revealResults(proposalId) {
  if (!state.isOwner) return;
  showFheOverlay("Revealing Results…", "Granting decryption access to tallies on-chain.");
  try {
    const tx = await state.contract.revealResults(proposalId, { gasLimit: 500_000n });
    await tx.wait();
    hideFheOverlay();
    toast("success", "Results revealed!", "You can now decrypt the tally with your wallet.");
    const updated = await loadProposal(proposalId);
    state.proposals[proposalId] = updated;
    renderProposals();
    // Immediately prompt owner to decrypt
    await decryptResults(proposalId);
  } catch (e) {
    hideFheOverlay();
    toast("error", "Transaction failed", e.message?.slice(0, 160));
  }
}

// ─── Owner: decrypt tally ─────────────────────────────────────────────────────
async function decryptResults(proposalId) {
  if (!state.isOwner) return;

  showFheOverlay("Preparing Decryption…", "Fetching encrypted handles from contract.");
  try {
    const [votesForHandle, votesAgainstHandle] = await Promise.all([
      state.roContract.getRevealedVotesFor(proposalId),
      state.roContract.getRevealedVotesAgainst(proposalId),
    ]);

    const instance = await getFhevmInstance();
    const checksumContract = ethers.getAddress(CONTRACT_ADDRESS);
    const checksumUser = ethers.getAddress(state.walletAddress);

    // Generate keypair for this session
    const keypair = instance.generateKeypair();
    const startTimestamp = Math.floor(Date.now() / 1000);
    const durationDays = 10;

    const eip712 = instance.createEIP712(
      keypair.publicKey,
      [checksumContract],
      startTimestamp,
      durationDays,
    );

    showFheOverlay("Sign Decrypt Request…", "Please sign the decryption request in your wallet.");

    const { domain, types: allTypes, message } = eip712;
    const { EIP712Domain: _unused, ...signTypes } = allTypes;

    // chainId MUST be Number not BigInt (SKILL.md §9)
    const signature = await state.signer.signTypedData(
      { ...domain, chainId: Number(domain.chainId) },
      signTypes,
      message,
    );

    showFheOverlay("Decrypting…", "Contacting Zama KMS to decrypt the tally. This may take a few seconds.");

    // Strip 0x prefix from signature (SKILL.md §9)
    const result = await instance.userDecrypt(
      [
        { handle: votesForHandle, contractAddress: checksumContract },
        { handle: votesAgainstHandle, contractAddress: checksumContract },
      ],
      keypair.privateKey,
      keypair.publicKey,
      signature.replace("0x", ""),
      [checksumContract],
      checksumUser,
      startTimestamp,
      durationDays,
    );

    hideFheOverlay();

    state.proposals[proposalId].votesFor = result[votesForHandle] ?? result[votesForHandle.toLowerCase()];
    state.proposals[proposalId].votesAgainst = result[votesAgainstHandle] ?? result[votesAgainstHandle.toLowerCase()];
    state.proposals[proposalId].decryptError = null;

    toast("success", "Tally decrypted!", "The final vote count is now visible.");
    renderProposals();
  } catch (e) {
    hideFheOverlay();
    const isUserRejected = e.code === "ACTION_REJECTED" || e.message?.includes("rejected");
    if (!isUserRejected) {
      const p = state.proposals[proposalId];
      p.decryptError = "Try again or run the local decrypt script.";
      renderProposals();
    }
    toast("error", "Decryption failed", isUserRejected ? "Signature rejected." : e.message?.slice(0, 160));
  }
}

// ─── Owner: create proposal ────────────────────────────────────────────────────
async function createProposal() {
  const input = document.getElementById("proposal-name");
  const name = input.value.trim();
  if (!name) return toast("error", "Empty name", "Please enter a proposal description.");
  if (!state.isOwner) return;

  showFheOverlay("Creating Proposal…", "Sending transaction.");
  try {
    const tx = await state.contract.createProposal(name, { gasLimit: 300_000n });
    await tx.wait();
    hideFheOverlay();
    input.value = "";
    toast("success", "Proposal created!", `"${name}" is now live.`);
    await loadProposals();
  } catch (e) {
    hideFheOverlay();
    toast("error", "Transaction failed", e.message?.slice(0, 160));
  }
}

// ─── Wire up global handlers (used by inline onclick in cards) ─────────────────
window._voteFor = (id) => castVote(id, 1n);
window._voteAgainst = (id) => castVote(id, 0n);
window._endVoting = (id) => endVoting(id);
window._revealResults = (id) => revealResults(id);
window._decryptResults = (id) => decryptResults(id);

// ─── Event listeners ──────────────────────────────────────────────────────────
function setupListeners() {
  document.getElementById("connect-btn").addEventListener("click", connectWallet);
  document.getElementById("hero-connect-btn").addEventListener("click", connectWallet);
  document.getElementById("switch-network-btn").addEventListener("click", switchNetwork);
  document.getElementById("refresh-btn").addEventListener("click", loadProposals);
  document.getElementById("create-proposal-btn").addEventListener("click", createProposal);
  document.getElementById("proposal-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProposal();
  });

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", ([addr]) => {
      if (addr) setupWallet(addr);
      else location.reload();
    });
    window.ethereum.on("chainChanged", () => location.reload());
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  setupListeners();
  if (!window.ethereum) return;
  const accounts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
  if (accounts.length) await setupWallet(accounts[0]);
}

boot().catch(console.error);
