import { useState, useEffect, useRef } from "react";
import { BrowserProvider, Contract, ethers } from "ethers";
// SDK loaded from local bundle — no relayer URL dependency for WASM init
let createInstance = null;
let SepoliaConfig  = null;

async function loadSDK() {
  if (createInstance) return;
  const m = await import("./sdk-bundle.js");
  createInstance = m.createInstance;
  SepoliaConfig  = m.SepoliaConfig;
  if (m.initSDK) await m.initSDK();
}

const CONTRACT_ADDRESS = "0x227189c0D8A1f732242d57b6F6ca776fcf14B1D8";
const SEPOLIA_CHAIN_ID = 11155111;

const ABI = [
  "function owner() external view returns (address)",
  "function proposalCount() external view returns (uint256)",
  "function getProposalName(uint256) external view returns (string)",
  "function hasVoted(address, uint256) external view returns (bool)",
  "function getTotalVoters(uint256) external view returns (uint256)",
  "function isVotingEnded(uint256) external view returns (bool)",
  "function areResultsRevealed(uint256) external view returns (bool)",
  "function castVote(uint256, bytes32, bytes) external",
  "function endVoting(uint256) external",
  "function revealResults(uint256) external",
  "function createProposal(string) external",
];

const roProvider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const roContract = new Contract(CONTRACT_ADDRESS, ABI, roProvider);

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

// ─── ProposalCard ─────────────────────────────────────────────────────────────

function ProposalCard({ p, account, isOwner, onVoteFor, onVoteAgainst, onEndVoting, onRevealResults }) {
  const statusBadge = p.resultsRevealed
    ? <span className="badge badge-revealed">Revealed</span>
    : p.votingEnded
    ? <span className="badge badge-ended">Ended</span>
    : <span className="badge badge-active">Active</span>;

  let voteSection = null;
  if (!p.votingEnded && !p.userHasVoted && account) {
    voteSection = (
      <div className="vote-section">
        <div className="vote-label">Cast Encrypted Vote</div>
        <div className="vote-buttons">
          <button className="btn vote-btn-for" onClick={() => onVoteFor(p.id)}>👍 For</button>
          <button className="btn vote-btn-against" onClick={() => onVoteAgainst(p.id)}>👎 Against</button>
        </div>
      </div>
    );
  } else if (!p.votingEnded && p.userHasVoted) {
    voteSection = (
      <div className="vote-section">
        <div className="vote-label">✓ Your vote has been recorded (encrypted)</div>
      </div>
    );
  }

  let resultsSection = null;
  if (p.resultsRevealed) {
    if (p.votesFor !== null && p.votesAgainst !== null) {
      const total  = Number(p.votesFor) + Number(p.votesAgainst);
      const forPct = total ? Math.round((Number(p.votesFor) / total) * 100) : 0;
      const agPct  = total ? Math.round((Number(p.votesAgainst) / total) * 100) : 0;
      resultsSection = (
        <div className="results-section">
          <div className="vote-label">Final Tally</div>
          <div className="result-row">
            <span className="result-label" style={{ color: "var(--green)" }}>For</span>
            <div className="result-bar-wrap">
              <div className="result-bar result-bar-for" style={{ width: `${forPct}%` }} />
            </div>
            <span className="result-count" style={{ color: "var(--green)" }}>{String(p.votesFor)}</span>
          </div>
          <div className="result-row">
            <span className="result-label" style={{ color: "var(--red)" }}>Against</span>
            <div className="result-bar-wrap">
              <div className="result-bar result-bar-against" style={{ width: `${agPct}%` }} />
            </div>
            <span className="result-count" style={{ color: "var(--red)" }}>{String(p.votesAgainst)}</span>
          </div>
        </div>
      );
    } else {
      resultsSection = (
        <div className="results-section">
          <div className="vote-label">✅ Voting Complete</div>
          <p className="decrypt-note" style={{ color: "var(--green)", margin: 0 }}>
            Results have been revealed on-chain.
          </p>
        </div>
      );
    }
  }

  const ownerBtn = isOwner && !p.votingEnded
    ? <button className="btn btn-sm btn-danger" onClick={() => onEndVoting(p.id)}>⏹ End Voting</button>
    : isOwner && p.votingEnded && !p.resultsRevealed
    ? <button className="btn btn-sm btn-purple" onClick={() => onRevealResults(p.id)}>🔓 Reveal Results</button>
    : null;

  return (
    <div className="proposal-card">
      <div className="card-top">
        <div className="card-title">{p.name}</div>
        <div className="card-id">#{p.id}</div>
      </div>
      <div className="card-meta">
        {statusBadge}
        {p.userHasVoted && <span className="badge badge-voted">✓ Voted</span>}
        <span className="card-voters">{p.totalVoters} voter{p.totalVoters !== 1 ? "s" : ""}</span>
      </div>
      {voteSection}
      {resultsSection}
      {ownerBtn && (
        <div className="admin-section">
          <div className="admin-label">Owner Actions</div>
          <div className="btn-group">{ownerBtn}</div>
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [account, setAccount]           = useState("");
  const [signer, setSigner]             = useState(null);
  const [contract, setContract]         = useState(null);
  const [isOwner, setIsOwner]           = useState(false);
  const [chainOk, setChainOk]           = useState(false);
  const [proposals, setProposals]       = useState([]);
  const [proposalName, setProposalName] = useState("");
  const [overlay, setOverlay]           = useState({ visible: false, title: "", msg: "" });
  const [toasts, setToasts]             = useState([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);

  const signerRef   = useRef(null);
  const contractRef = useRef(null);
  const accountRef  = useRef("");
  const fhevmRef    = useRef(null);
  const toastId     = useRef(0);

  signerRef.current   = signer;
  contractRef.current = contract;
  accountRef.current  = account;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function addToast(type, title, msg, ms = 5000) {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, type, title, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms);
  }

  const showOverlay = (title, msg) => setOverlay({ visible: true, title, msg });
  const hideOverlay = () => setOverlay((o) => ({ ...o, visible: false }));

  async function getFhevmInstance() {
    if (fhevmRef.current) return fhevmRef.current;
    await loadSDK();
    fhevmRef.current = await createInstance({
      ...SepoliaConfig,
      network: "https://ethereum-sepolia-rpc.publicnode.com",
    });
    return fhevmRef.current;
  }

  // ─── Proposal loading ──────────────────────────────────────────────────────

  async function loadOneProposal(id, addr) {
    const [name, totalVoters, votingEnded, resultsRevealed, userHasVoted] = await Promise.all([
      roContract.getProposalName(id),
      roContract.getTotalVoters(id),
      roContract.isVotingEnded(id),
      roContract.areResultsRevealed(id),
      addr ? roContract.hasVoted(addr, id) : Promise.resolve(false),
    ]);

    const votesFor = null;
    const votesAgainst = null;

    return {
      id,
      name,
      totalVoters: Number(totalVoters),
      votingEnded,
      resultsRevealed,
      userHasVoted,
      votesFor,
      votesAgainst,
    };
  }

  async function loadProposals(addr) {
    setProposalsLoading(true);
    try {
      const count = Number(await roContract.proposalCount());
      const list  = await Promise.all(
        Array.from({ length: count }, (_, i) => loadOneProposal(i, addr))
      );
      setProposals(list);
    } catch (e) {
      addToast("error", "Failed to load proposals", e.message);
    } finally {
      setProposalsLoading(false);
    }
  }

  // ─── Wallet ────────────────────────────────────────────────────────────────

  async function setupWallet(address) {
    const _provider = new BrowserProvider(window.ethereum);
    const _signer   = await _provider.getSigner();
    const _contract = new Contract(CONTRACT_ADDRESS, ABI, _signer);
    const network   = await _provider.getNetwork();
    const correct   = Number(network.chainId) === SEPOLIA_CHAIN_ID;
    const owner     = await roContract.owner();

    setAccount(address);
    setSigner(_signer);
    setContract(_contract);
    setChainOk(correct);
    setIsOwner(address.toLowerCase() === owner.toLowerCase());
    fhevmRef.current = null;

    if (correct) await loadProposals(address);
  }

  async function connectWallet() {
    if (!window.ethereum) {
      addToast("error", "MetaMask not found", "Please install MetaMask.");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts.length) await setupWallet(accounts[0]);
    } catch (e) {
      addToast("error", "Connection failed", e.message);
    }
  }

  async function switchNetwork() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xaa36a7" }],
      });
    } catch {
      addToast("error", "Switch failed", "Please manually switch to Sepolia in MetaMask.");
    }
  }

  // ─── Vote ──────────────────────────────────────────────────────────────────

  async function castVote(proposalId, voteValue) {
    if (!signerRef.current) return addToast("error", "Not connected", "Connect your wallet first.");
    if (!chainOk)           return addToast("error", "Wrong network", "Switch to Sepolia.");

    showOverlay("Encrypting Vote…", "Creating FHE-encrypted ballot. This may take a few seconds.");
    try {
      const instance = await getFhevmInstance();
      const addr     = ethers.getAddress(CONTRACT_ADDRESS);
      const user     = ethers.getAddress(accountRef.current);

      const encrypted = await instance
        .createEncryptedInput(addr, user)
        .add64(voteValue)
        .encrypt();

      const handle     = toHex(encrypted.handles[0]);
      const inputProof = toHex(encrypted.inputProof);

      showOverlay("Sending Transaction…", "FHE operations on Sepolia take 5–30 seconds. Please wait.");

      const tx = await contractRef.current.castVote(proposalId, handle, inputProof, {
        gasLimit: 1_000_000n,
      });
      addToast(
        "info",
        "Transaction sent",
        `<a href="https://sepolia.etherscan.io/tx/${tx.hash}" target="_blank">View on Etherscan</a>`,
        8000,
      );
      await tx.wait();
      hideOverlay();
      addToast("success", "Vote cast!", "Your encrypted vote has been recorded on-chain.");

      const updated = await loadOneProposal(proposalId, accountRef.current);
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? updated : p)));
    } catch (e) {
      hideOverlay();
      addToast(
        "error",
        "Vote failed",
        e.code === "ACTION_REJECTED" ? "Transaction rejected." : e.message?.slice(0, 160),
      );
    }
  }

  // ─── Owner: end voting ─────────────────────────────────────────────────────

  async function endVoting(proposalId) {
    showOverlay("Ending Voting…", "Sending transaction to close the proposal.");
    try {
      const tx = await contractRef.current.endVoting(proposalId, { gasLimit: 200_000n });
      await tx.wait();
      hideOverlay();
      addToast("success", "Voting ended", `Proposal #${proposalId} is now closed.`);
      const updated = await loadOneProposal(proposalId, accountRef.current);
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? updated : p)));
    } catch (e) {
      hideOverlay();
      addToast("error", "Transaction failed", e.message?.slice(0, 160));
    }
  }

  // ─── Owner: reveal results ─────────────────────────────────────────────────

  async function revealResults(proposalId) {
    showOverlay("Revealing Results…", "Sending transaction. This may take a few seconds.");
    try {
      const tx = await contractRef.current.revealResults(proposalId, { gasLimit: 1_000_000n });
      await tx.wait();
      hideOverlay();
      addToast("success", "Results revealed!", "Tally is now available.");
      const updated = await loadOneProposal(proposalId, accountRef.current);
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? updated : p)));
    } catch (e) {
      hideOverlay();
      addToast("error", "Transaction failed", e.message?.slice(0, 160));
    }
  }

  // ─── Owner: create proposal ────────────────────────────────────────────────

  async function createProposal() {
    const name = proposalName.trim();
    if (!name) return addToast("error", "Empty name", "Please enter a proposal description.");

    showOverlay("Creating Proposal…", "Sending transaction.");
    try {
      const tx = await contractRef.current.createProposal(name, { gasLimit: 300_000n });
      await tx.wait();
      hideOverlay();
      setProposalName("");
      addToast("success", "Proposal created!", `"${name}" is now live.`);
      await loadProposals(accountRef.current);
    } catch (e) {
      hideOverlay();
      addToast("error", "Transaction failed", e.message?.slice(0, 160));
    }
  }

  // ─── Auto-connect & wallet events ─────────────────────────────────────────

  useEffect(() => {
    if (!window.ethereum) return;

    window.ethereum
      .request({ method: "eth_accounts" })
      .then((accounts) => { if (accounts.length) setupWallet(accounts[0]); })
      .catch(console.error);

    const onAccounts = ([addr]) => (addr ? setupWallet(addr) : window.location.reload());
    const onChain    = ()       => window.location.reload();

    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccounts);
      window.ethereum.removeListener("chainChanged", onChain);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div id="app">
      {/* Header */}
      <header>
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">🔒</span>
            <div className="logo-text">
              <span className="logo-title">Confidential Voting</span>
              <span className="logo-sub">Powered by FHEVM · Sepolia</span>
            </div>
          </div>
          <div className="header-right">
            {account && (
              <div className="wallet-status">
                <div className="wallet-dot" />
                <span>{shortAddr(account)}</span>
              </div>
            )}
            <button className="btn btn-primary" onClick={connectWallet} disabled={Boolean(account)}>
              {account ? "Connected" : "Connect Wallet"}
            </button>
          </div>
        </div>
      </header>

      <main>
        {/* Wrong network warning */}
        {account && !chainOk && (
          <div className="alert alert-warning">
            ⚠️ Please switch to <strong>Sepolia</strong> testnet to use this app.
            <button className="btn btn-sm btn-outline" onClick={switchNetwork}>Switch Network</button>
          </div>
        )}

        {/* Not-connected hero */}
        {!account && (
          <div className="hero">
            <div className="hero-icon">🔒</div>
            <h1>Private Voting on Ethereum</h1>
            <p>
              Cast encrypted votes using Fully Homomorphic Encryption. Only the final
              tally is ever revealed — individual votes remain private forever.
            </p>
            <button className="btn btn-primary btn-lg" onClick={connectWallet}>Connect Wallet</button>
          </div>
        )}

        {/* Main content */}
        {account && chainOk && (
          <>
            {/* Owner panel */}
            {isOwner && (
              <section className="owner-section">
                <div className="panel">
                  <div className="panel-header">
                    <span className="badge badge-owner">Owner</span>
                    <h2>Create Proposal</h2>
                  </div>
                  <div className="create-form">
                    <input
                      type="text"
                      className="input"
                      placeholder="e.g. Should we upgrade the protocol?"
                      maxLength={120}
                      value={proposalName}
                      onChange={(e) => setProposalName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && createProposal()}
                    />
                    <button className="btn btn-primary" onClick={createProposal}>+ Create</button>
                  </div>
                </div>
              </section>
            )}

            {/* Proposals list */}
            <section className="proposals-section">
              <div className="section-header">
                <h2>Proposals</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => loadProposals(account)}>
                  ↻ Refresh
                </button>
              </div>

              {proposalsLoading ? (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Loading proposals…</p>
                </div>
              ) : proposals.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📋</div>
                  <p>No proposals yet.</p>
                  <p className="text-muted">The contract owner can create a proposal above.</p>
                </div>
              ) : (
                <div className="proposals-grid">
                  {proposals.map((p) => (
                    <ProposalCard
                      key={p.id}
                      p={p}
                      account={account}
                      isOwner={isOwner}
                      onVoteFor={(id) => castVote(id, 1n)}
                      onVoteAgainst={(id) => castVote(id, 0n)}
                      onEndVoting={endVoting}
                      onRevealResults={revealResults}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Toast notifications */}
      <div id="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <div className="toast-icon">
              {t.type === "success" ? "✅" : t.type === "error" ? "❌" : "ℹ️"}
            </div>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.msg && <div className="toast-msg" dangerouslySetInnerHTML={{ __html: t.msg }} />}
            </div>
          </div>
        ))}
      </div>

      {/* FHE operation overlay */}
      {overlay.visible && (
        <div className="fhe-overlay">
          <div className="fhe-modal">
            <div className="fhe-spinner" />
            <div className="fhe-title">{overlay.title}</div>
            <div className="fhe-msg">{overlay.msg}</div>
          </div>
        </div>
      )}
    </div>
  );
}
