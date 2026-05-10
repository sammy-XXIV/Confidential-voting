# FHEVM Smart Contract Development — AI Agent Skill

## How to Use This Skill

**For AI agents (Claude Code, Cursor, Windsurf, Aider):**
Load this file as context before writing any FHEVM contract. Read all sections before generating code. Every anti-pattern here caused a real production failure — do not skip them.

**Mandatory pre-code checklist:**
- Read Section 4 (encrypted zero in constructor) before any contract
- Read Section 6 (ACL) before any function that stores encrypted values
- Read Section 9 (decryption) before any frontend decrypt flow
- Read Section 13 (anti-patterns) before finalizing any contract
- Run `node fhevm-lint.js contracts/` after writing — fix all errors before deploying

**For developers:**
Give this file to your AI agent as a system prompt or project context. The agent will have full FHEVM proficiency for the session. Pair with `fhevm-lint.js` to audit agent output before Sepolia deployment.

**What this skill covers:**
Encrypted types · FHE operations · Access control · Input proofs · Decryption patterns · Frontend integration · Testing · Common anti-patterns · Production debugging · Known limitations

---

## 1. Core Concepts

### What FHEVM Is

Zama FHEVM allows Solidity contracts to compute directly on encrypted data. Users encrypt values client-side. The contract processes ciphertexts without ever seeing plaintext. Results stay encrypted until the authorized user decrypts them via wallet signature.

### The Mental Model

```
User Browser → encrypt(amount) → ciphertext handle
                                        ↓
                              Confidential Contract
                                        ↓
                         FHE coprocessor computes on ciphertext
                                        ↓
                         Encrypted result stored onchain
                                        ↓
                    Only authorized user can decrypt via EIP-712
```

### What You Can and Cannot Do

**Can do:**
- Compute on encrypted integers: add, subtract, multiply, compare
- Store encrypted values in contract storage
- Grant/revoke access to encrypted handles
- Return encrypted handles to authorized users
- Use `FHE.select` for conditional logic on encrypted booleans

**Cannot do:**
- `require()` on an encrypted boolean — contract cannot branch on encrypted results
- Read encrypted values in plaintext inside the contract
- Use `FHE.div` — it does not exist in the library
- Subtract encrypted values without risk of underflow — use `FHE.min` first

---

## 2. Setup

### Installation

```bash
mkdir my-fhevm-project && cd my-fhevm-project
git clone https://github.com/zama-ai/fhevm-hardhat-template .
npm install
```

### Environment Variables

```bash
# .env
PRIVATE_KEY=your_deployer_private_key
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

### Hardhat Config

```typescript
import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-ethers";
import type { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    sepolia: {
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    },
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
};

export default config;
```

---

## 3. Encrypted Types

### Available Types

```solidity
euint8    // encrypted 8-bit integer
euint16   // encrypted 16-bit integer
euint32   // encrypted 32-bit integer
euint64   // encrypted 64-bit integer — most common for token amounts
euint128  // encrypted 128-bit integer
euint256  // encrypted 256-bit integer
ebool     // encrypted boolean
eaddress  // encrypted address
ebytes64  // encrypted bytes

// External types — used for function parameters from users
externalEuint64  // user-supplied encrypted input
externalEbool    // user-supplied encrypted boolean
```

### Choosing the Right Type

- Token amounts with 8 decimals (cWETH) — use `euint64`
- Token amounts with 18 decimals — use `euint128` or `euint256`
- Boolean flags — use `ebool`
- Always use the smallest type that fits — lower gas cost

---

## 4. Contract Structure

### Required Imports

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { IERC7984 } from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
```

### Base Contract

Always inherit `ZamaEthereumConfig`:

```solidity
contract MyContract is ZamaEthereumConfig {
    // your code
}
```

### Storing Encrypted Zero — CRITICAL

Never use `FHE.asEuint64(0)` inline for comparisons. Inline calls create new handles without ACL permissions, causing unreliable comparison results.

Always store encrypted zero in the constructor:

```solidity
euint64 private _encryptedZero;

constructor() {
    _encryptedZero = FHE.asEuint64(0);
    FHE.allowThis(_encryptedZero);
}
```

Use `_encryptedZero` everywhere instead of `FHE.asEuint64(0)`.

---

## 5. FHE Operations

### Arithmetic

```solidity
euint64 sum  = FHE.add(a, b);
euint64 diff = FHE.sub(a, b);   // WARNING: underflow risk — use FHE.min first
euint64 prod = FHE.mul(a, b);
// FHE.div does NOT exist — rewrite as cross-multiplication
```

### Safe Subtraction Pattern

```solidity
// WRONG — underflow risk
euint64 result = FHE.sub(debt, repayAmount);

// CORRECT — cap repay at actual debt
euint64 actualRepay = FHE.min(repayAmount, debt);
euint64 result = FHE.sub(debt, actualRepay);
```

### Division Workaround — CRITICAL

`FHE.div` does not exist. Rewrite all division as cross-multiplication:

```solidity
// WRONG — will not compile
euint64 maxBorrow = FHE.div(FHE.mul(collateral, 66), 100);

// CORRECT — multiply both sides
ebool withinLTV = FHE.le(
    FHE.mul(debt, FHE.asEuint64(100)),
    FHE.mul(collateral, FHE.asEuint64(66))
);
```

### Comparisons

```solidity
ebool eq  = FHE.eq(a, b);
ebool ne  = FHE.ne(a, b);
ebool lt  = FHE.lt(a, b);
ebool le  = FHE.le(a, b);
ebool gt  = FHE.gt(a, b);
ebool ge  = FHE.ge(a, b);
```

### Boolean Operations

```solidity
ebool and = FHE.and(a, b);
ebool or  = FHE.or(a, b);
ebool not = FHE.not(a);
```

### Conditional Selection — replaces if/else on encrypted values

```solidity
// FHE.select(condition, valueIfTrue, valueIfFalse)
euint64 result = FHE.select(condition, trueValue, falseValue);

// Example: only transfer if condition is true, else transfer 0
euint64 toSend = FHE.select(isEligible, amount, _encryptedZero);
```

### Min/Max

```solidity
euint64 minimum = FHE.min(a, b);
euint64 maximum = FHE.max(a, b);
```

### Bit Operations

```solidity
euint64 shifted  = FHE.shl(value, FHE.asEuint64(3));
euint64 shifted  = FHE.shr(value, FHE.asEuint64(3));
euint64 rotated  = FHE.rotl(value, FHE.asEuint64(3));
euint64 rotated  = FHE.rotr(value, FHE.asEuint64(3));
```

### Random Numbers

```solidity
euint64 rand = FHE.randEuint64();
euint64 rand = FHE.randEuint64Bounded(uint64(100));
```

### Coming Soon — Do Not Use Yet

```solidity
FHE.div()       // Division — not available
FHE.rem()       // Remainder — not available
FHE.safeAdd()   // Safe add — not available
FHE.safeSub()   // Safe sub — not available
FHE.safeMul()   // Safe mul — not available
eint8…256       // Signed integers — not available
```

---

## 6. Access Control — ACL

Every encrypted handle must be explicitly granted permission before it can be used.

### Required Permissions

```solidity
FHE.allowThis(handle);                    // contract uses handle in future txs
FHE.allow(handle, userAddress);           // user can decrypt handle
FHE.allow(handle, address(contract));     // another contract can use handle
FHE.allowTransient(handle, address(token)); // token can use handle in same tx
```

### Full Pattern for Storing Encrypted Position

```solidity
function openPosition(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
    euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

    FHE.allowTransient(amount, address(collateralToken));
    euint64 received = collateralToken.confidentialTransferFrom(
        msg.sender, address(this), amount
    );

    _positions[msg.sender].collateral = received;

    FHE.allowThis(_positions[msg.sender].collateral);
    FHE.allow(_positions[msg.sender].collateral, msg.sender);
}
```

### Common ACL Mistakes

```solidity
// WRONG — forgot allowThis
_positions[msg.sender].collateral = received;

// WRONG — forgot allowTransient before token transfer
collateralToken.confidentialTransferFrom(msg.sender, address(this), amount);

// WRONG — forgot allow(user)
FHE.allowThis(handle);
// Missing: FHE.allow(handle, msg.sender);
```

---

## 7. Input Proofs

### Why Input Proofs Exist

When a user encrypts a value client-side and sends it to the contract, the contract receives a ciphertext it cannot read. Without additional verification, a malicious user could send a ciphertext that doesn't encrypt a valid integer — or replay someone else's ciphertext — and the contract would have no way to detect it.

An **input proof** is a Zero-Knowledge Proof (ZKP) attached alongside the ciphertext. It proves three things without revealing the plaintext:

1. **Well-formedness** — the ciphertext was correctly formed and encrypts a valid value of the claimed type
2. **Ownership** — the ciphertext was encrypted specifically for this contract address and this user's address (bound during encryption client-side)
3. **Freshness** — it was freshly generated, not replayed from another transaction or user

`FHE.fromExternal(encryptedValue, inputProof)` verifies the ZKP on-chain before the ciphertext enters the FHE computation graph. If the proof is invalid, the transaction reverts. **Never skip this call** — accepting an unverified ciphertext lets attackers inject malformed values into your FHE state.

### How It Works End-to-End

```
1. Frontend: user calls instance.createEncryptedInput(contractAddress, userAddress)
   → SDK binds the encryption to this specific contract + user pair
   → .add64(value).encrypt() returns { handles[], inputProof }

2. Frontend: passes handles[0] and inputProof to the contract function

3. Contract: FHE.fromExternal(encryptedValue, inputProof)
   → verifies the ZKP (reverts if invalid)
   → returns a trusted euint64 handle the contract can safely operate on
```

The binding to `contractAddress` and `userAddress` during encryption is what prevents replay attacks — a proof generated for contract A cannot be used on contract B, and a proof for Alice cannot be used by Bob.

### Usage

```solidity
function deposit(
    externalEuint64 encryptedAmount,
    bytes calldata inputProof
) external {
    // Verifies ZKP — reverts if proof invalid or address binding wrong
    euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
    // amount is now a trusted, contract-internal encrypted handle
}
```

```javascript
// Frontend — always pass both contractAddress AND userAddress
const encrypted = await instance
    .createEncryptedInput(
        ethers.getAddress(CONTRACT_ADDRESS),  // binding: contract
        ethers.getAddress(userAddress)        // binding: user
    )
    .add64(BigInt(amount))
    .encrypt();

// Both values must be sent to the contract
const handle     = toHex(encrypted.handles[0]);
const inputProof = toHex(encrypted.inputProof);
await contract.deposit(handle, inputProof, { gasLimit: 1_000_000n });
```

### Rules

- Always validate via `FHE.fromExternal` — never use an unverified ciphertext
- `externalEuint64` is only for user-supplied inputs — internal `euint64` handles are already trusted
- Never pass an internal `euint64` as `externalEuint64` — they are different types
- The contract address and user address passed to `createEncryptedInput` must exactly match what the contract expects — checksum them with `ethers.getAddress()`
- One `inputProof` can cover multiple encrypted inputs in the same call (call `.add64().add64().encrypt()` once, not twice)

---

## 8. Confidential Token (ERC-7984)

### Interface

```solidity
interface IERC7984 {
    function confidentialTransferFrom(address from, address to, euint64 amount) external returns (euint64);
    function confidentialTransfer(address to, euint64 amount) external returns (euint64);
    function confidentialBalanceOf(address account) external returns (euint64);
    function setOperator(address operator, uint48 until) external;
    function isOperator(address account, address operator) external view returns (bool);
}
```

### Critical: Capture Return Value

```solidity
// WRONG — trusts user-supplied amount
euint64 amount = FHE.fromExternal(encryptedAmount, proof);
collateralToken.confidentialTransferFrom(msg.sender, address(this), amount);
_positions[msg.sender].collateral = amount;

// CORRECT — cryptographically verified
euint64 amount = FHE.fromExternal(encryptedAmount, proof);
FHE.allowTransient(amount, address(collateralToken));
euint64 received = collateralToken.confidentialTransferFrom(
    msg.sender, address(this), amount
);
_positions[msg.sender].collateral = received;
```

### ERC-7984 Does NOT Support ERC20 approve()

Confidential tokens use `setOperator` instead. Calling `approve()` on cWETH reverts with no data.

```javascript
// WRONG — reverts silently
await cweth.approve(CONTRACT_ADDRESS, ethers.MaxUint256);

// CORRECT
const until = Math.floor(Date.now()/1000) + 365*24*60*60;
await cweth.setOperator(CONTRACT_ADDRESS, until);
```

### Setting Operator in Frontend

```javascript
const isApproved = await cweth.isOperator(userAddress, CONTRACT_ADDRESS);
if (!isApproved) {
    const until = Math.floor(Date.now()/1000) + 365*24*60*60;
    await (await cweth.setOperator(CONTRACT_ADDRESS, until)).wait();
}
```

---

## 9. Decryption — Backend-Mediated Pattern

### Why Frontend Decryption Fails

The browser SDK cannot handle `userDecrypt` reliably because:
- CORS blocks requests to Zama's KMS/Gateway
- BigInt values cannot be JSON serialized
- `chainId` must be `Number` not `BigInt` — causes `InvalidTypeError createEIP712`
- Signature must have `0x` prefix stripped before passing to SDK

### Solution: Backend-Mediated Decryption

Move the entire decrypt flow to the backend. Frontend only handles wallet signing.

```
1. Frontend → POST /decrypt-prepare { handle, contractAddress, userAddress }
2. Backend generates keypair + EIP-712 message
3. Backend → Frontend: { keypair, eip712, startTimestamp, durationDays }
4. Frontend: user signs EIP-712 with wallet → signature
5. Frontend → POST /decrypt-balance { handle, contractAddress, userAddress, signature, keypair, startTimestamp, durationDays }
6. Backend calls instance.userDecrypt()
7. Backend → Frontend: { balance }
```

### Backend Decrypt Endpoints

```javascript
app.post('/decrypt-prepare', async (req, res) => {
  const { handle, contractAddress, userAddress } = req.body;
  try {
    const instance = await getInstance();
    const keypair = instance.generateKeypair();
    const startTimestamp = Math.floor(Date.now() / 1000);
    const durationDays = 10;

    const eip712 = instance.createEIP712(
      keypair.publicKey,
      [contractAddress],
      startTimestamp,
      durationDays,
    );

    // CRITICAL: serialize BigInt — JSON.stringify fails on BigInt
    const serialize = (obj) => JSON.parse(
      JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v)
    );

    res.json({
      success: true,
      keypair: {
        publicKey: keypair.publicKey.toString(),
        privateKey: keypair.privateKey.toString(),
      },
      eip712: serialize(eip712),
      startTimestamp,
      durationDays,
    });
  } catch(err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

app.post('/decrypt-balance', async (req, res) => {
  const { handle, contractAddress, userAddress, signature, keypair, startTimestamp, durationDays } = req.body;
  try {
    const instance = await getInstance();
    const result = await instance.userDecrypt(
      [{ handle, contractAddress }],
      keypair.privateKey,
      keypair.publicKey,
      signature.replace('0x', ''),  // CRITICAL: strip 0x prefix
      [contractAddress],
      userAddress,
      Number(startTimestamp),       // CRITICAL: must be Number not BigInt
      Number(durationDays),
    );

    const balance = result[handle];
    res.json({ success: true, balance: balance.toString() });
  } catch(err) {
    res.status(500).json({ error: err.message, success: false });
  }
});
```

### Frontend Signing Flow

```javascript
async function decryptBalance(handle, contractAddress, userAddress) {
  const prepRes = await fetch(`${BACKEND_URL}/decrypt-prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, contractAddress, userAddress }),
  });
  const { keypair, eip712, startTimestamp, durationDays } = await prepRes.json();

  const { domain, types: allTypes, message } = eip712;
  const { EIP712Domain: _, ...signTypes } = allTypes;

  // CRITICAL: chainId must be Number not BigInt
  const signature = await signer.signTypedData(
    { ...domain, chainId: Number(domain.chainId) },
    signTypes,
    message
  );

  const decRes = await fetch(`${BACKEND_URL}/decrypt-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, contractAddress, userAddress, signature, keypair, startTimestamp, durationDays }),
  });
  const { balance } = await decRes.json();
  return balance;
}
```

### Common Decrypt Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `InvalidTypeError createEIP712` | chainId is BigInt | `Number(domain.chainId)` |
| `signature must not include 0x` | ethers adds 0x prefix | `signature.replace('0x', '')` |
| `Cannot serialize BigInt` | keypair values are BigInt | serialize with custom replacer |
| `handle not found in result` | handle format mismatch | ensure same hex string in both calls |
| `ACL permission denied` | contract never called `FHE.allow` | add `FHE.allow(handle, userAddress)` in getter |

### Getting Handle from Contract

```solidity
// Cannot be view — FHE.allow modifies state
function getCollateralHandle(address user) external returns (euint64) {
    require(_positions[user].exists, "No position");
    FHE.allow(_positions[user].collateral, msg.sender);
    return _positions[user].collateral;
}
```

---

## 10. Deployment

### Deploy Script

```typescript
import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    const MyContract = await ethers.getContractFactory("MyContract");
    const contract = await MyContract.deploy(CWETH_ADDRESS, CWETH_ADDRESS);
    await contract.waitForDeployment();
    console.log("Deployed at:", await contract.getAddress());
}

main().catch(console.error);
```

```bash
npx hardhat run deploy/script.ts --network sepolia
```

### CRITICAL: estimateGas Blocked on Sepolia

The FHEVM Hardhat plugin blocks `estimateGas` on Sepolia. Any post-deployment interaction using Hardhat tasks fails.

Use plain Node.js instead:

```javascript
// deploy/interact.mjs
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// Always set explicit gasLimit
const tx = await contract.someFunction(args, { gasLimit: 1_000_000 });
await tx.wait();
```

### CRITICAL: Clean Before Sepolia Deploy

```bash
npx hardhat clean
npx hardhat compile --network sepolia
npx hardhat run deploy/script.ts --network sepolia
```

Skipping `clean` causes internal exceptions on Sepolia.

### Etherscan Verification — Impossible

FHEVM contracts cannot be verified on Etherscan. The plugin transforms bytecode during compilation. Link your GitHub source instead.

---

## 11. Frontend Integration

### Install SDK

```bash
npm install @zama-fhe/relayer-sdk
```

### Encrypt User Input

```javascript
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk';

const instance = await createInstance({
    ...SepoliaConfig,
    network: window.ethereum,
});

const encrypted = await instance
    .createEncryptedInput(contractAddress, userAddress)
    .add64(BigInt(amountInSmallestUnit))
    .encrypt();

const handle = '0x' + Buffer.from(encrypted.handles[0]).toString('hex');
const inputProof = '0x' + Buffer.from(encrypted.inputProof).toString('hex');

await contract.deposit(handle, inputProof, { gasLimit: 1_000_000n });
```

### Gas Limits

```javascript
{ gasLimit: 1_000_000n }   // deposits, simple ops
{ gasLimit: 2_000_000n }   // borrow, repay with FHE math
{ gasLimit: 3_000_000n }   // liquidation, multiple FHE ops
```

---

## 12. Testing Patterns

| Mode | Encryption | Speed | Usage |
|------|------------|-------|-------|
| Hardhat in-memory | Mock | Very fast | Unit tests, CI |
| Hardhat Node | Mock | Fast | Frontend integration |
| Sepolia | Real | Slow | Production validation |

### Mode 1 — Hardhat In-Memory

```bash
npx hardhat test --network hardhat
```

Mock encryption — tests contract logic, not encryption correctness.

### Mode 2 — Hardhat Node

```bash
# Terminal 1
npx hardhat node

# Terminal 2
npx hardhat deploy --network localhost
npx hardhat fhevm check-fhevm-compatibility --network localhost --address <addr>
npx hardhat test --network localhost
```

### Mode 3 — Sepolia

```bash
npx hardhat clean
npx hardhat compile --network sepolia
npx hardhat deploy --network sepolia
npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <addr>
```

### Compatibility Check

Always run after deployment:

```bash
npx hardhat fhevm check-fhevm-compatibility --network sepolia --address 0x...
```

---

## 13. Common Anti-Patterns

### FHE.div does not exist

```solidity
// WILL NOT COMPILE
euint64 result = FHE.div(FHE.mul(a, 66), 100);
// Fix: cross-multiply
ebool check = FHE.le(FHE.mul(a, 100), FHE.mul(b, 66));
```

### Inline FHE.asEuint64(0) for comparisons

```solidity
// UNRELIABLE
ebool isZero = FHE.eq(debt, FHE.asEuint64(0));
// Fix: use _encryptedZero from constructor
```

### Forgetting allowTransient before token transfer

```solidity
// REVERTS
collateralToken.confidentialTransferFrom(msg.sender, address(this), amount);
// Fix: FHE.allowTransient(amount, address(collateralToken)) first
```

### Not capturing confidentialTransferFrom return value

```solidity
// ATTACK VECTOR
collateralToken.confidentialTransferFrom(msg.sender, address(this), amount);
_balance = amount; // user-supplied, not verified
// Fix: _balance = confidentialTransferFrom(...) return value
```

### require() on encrypted boolean

```solidity
// WILL NOT COMPILE
require(FHE.lt(debt, maxBorrow), "Exceeds LTV");
// Fix: FHE.select to return 0 silently
```

### view function with FHE.allow

```solidity
// COMPILE ERROR
function getHandle() external view returns (euint64) {
    FHE.allow(handle, msg.sender); // modifies state
}
// Fix: remove view modifier
```

### ERC20 approve on confidential token

```solidity
// REVERTS — ERC-7984 does not support approve()
cweth.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
// Fix: use setOperator instead
```

---

## 14. Full Example Contract

```solidity
// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { IERC7984 } from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

contract ConfidentialVault is ZamaEthereumConfig {

    IERC7984 public immutable token;
    euint64 private _encryptedZero;

    mapping(address => euint64) private _balances;
    mapping(address => bool)    public  hasDeposit;

    event Deposited(address indexed user);
    event Withdrawn(address indexed user);

    constructor(address _token) {
        token = IERC7984(_token);
        _encryptedZero = FHE.asEuint64(0);
        FHE.allowThis(_encryptedZero);
    }

    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        FHE.allowTransient(amount, address(token));
        euint64 received = token.confidentialTransferFrom(msg.sender, address(this), amount);

        _balances[msg.sender] = FHE.add(_balances[msg.sender], received);
        hasDeposit[msg.sender] = true;

        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        emit Deposited(msg.sender);
    }

    function withdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        require(hasDeposit[msg.sender], "No deposit");

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        euint64 actualWithdraw = FHE.min(amount, _balances[msg.sender]);
        _balances[msg.sender] = FHE.sub(_balances[msg.sender], actualWithdraw);

        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);
        FHE.allow(actualWithdraw, address(token));

        token.confidentialTransfer(msg.sender, actualWithdraw);
        emit Withdrawn(msg.sender);
    }

    function getBalanceHandle(address user) external returns (euint64) {
        FHE.allow(_balances[user], msg.sender);
        return _balances[user];
    }
}
```

---

## 15. Useful Addresses (Sepolia)

| Contract | Address |
|----------|---------|
| cWETH (ERC-7984) | `0x46208622DA27d91db4f0393733C8BA082ed83158` |
| Underlying WETH | `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` |
| FHEVM Coprocessor | `0x92c920834ec8941d2c77d188936e1f7a6f49c127` |
| ACL Contract | `0xf0ffdc93b7e186bc2f8cb3daa75d86d1930a433d` |

cWETH uses **8 decimals** not 18.

---

## 16. ABI Fragment Format for ethers.js

Use `bytes32` not `euint64` in ethers.js ABI strings:

```javascript
// WRONG
'function deposit(euint64 encryptedAmount, bytes inputProof) external'

// CORRECT
'function deposit(bytes32 encryptedAmount, bytes inputProof) external'
'function getBalanceHandle(address user) external returns (bytes32)'
```

---

## 17. cWETH Decimal Handling

cWETH uses 8 decimals. Using 18-decimal functions causes 10x display errors.

```javascript
const CWETH_DECIMALS = 8;

// Parsing input
const amountWei = ethers.parseUnits(amount.toString(), CWETH_DECIMALS);

// Displaying
const display = parseFloat(ethers.formatUnits(balance, CWETH_DECIMALS)).toFixed(4);
```

---

## 18. cWETH Faucet Pattern

Standard ERC20 mint does not work. Use the 3-step wrap flow:

```javascript
// Step 1: Mint underlying WETH
await weth.mint(signer.address, ethers.parseUnits('0.5', 18));

// Step 2: Approve WETH for cWETH contract
await weth.approve(CWETH_ADDRESS, ethers.parseUnits('0.5', 18));

// Step 3: Wrap to cWETH
await cweth.wrap(recipientAddress, ethers.parseUnits('0.5', 18));
```

---

## 19. SDK and Backend Integration

### SDK Import Paths

```javascript
// Node.js backend
const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');

// Browser
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk';

// Cloudflare Workers — DOES NOT WORK
// Use Node.js on Render instead
```

### Use SepoliaConfig — Don't Hardcode

```javascript
const instance = await createInstance({
  ...SepoliaConfig,
  network: 'https://ethereum-sepolia-rpc.publicnode.com',
});
```

### Working RPC URL

```
https://ethereum-sepolia-rpc.publicnode.com  ✅
https://eth-sepolia.public.blastapi.io       ❌ 403 Forbidden
```

### Address Checksumming Required

```javascript
const checksumContract = ethers.getAddress(contractAddress);
const checksumUser = ethers.getAddress(userAddress);
const encrypted = instance.createEncryptedInput(checksumContract, checksumUser);
```

### Handle Conversion

```javascript
const toHex = (val) => {
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  return '0x' + Buffer.from(val).toString('hex');
};

res.json({
  handle: toHex(encrypted.handles[0]),
  inputProof: toHex(encrypted.inputProof),
});
```

### SDK Version

Use `0.4.0-5`:
```bash
npm view @zama-fhe/relayer-sdk versions
```

### Full Working server.js

```javascript
const express = require('express');
const cors = require('cors');
const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

let _instance = null;
async function getInstance() {
  if (_instance) return _instance;
  _instance = await createInstance({
    ...SepoliaConfig,
    network: 'https://ethereum-sepolia-rpc.publicnode.com',
  });
  return _instance;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/encrypt', async (req, res) => {
  const { amount, contractAddress, userAddress } = req.body;
  if (!amount || !contractAddress || !userAddress)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const checksumContract = ethers.getAddress(contractAddress);
    const checksumUser = ethers.getAddress(userAddress);
    const instance = await getInstance();
    const encrypted = await instance
      .createEncryptedInput(checksumContract, checksumUser)
      .add64(BigInt(amount))
      .encrypt();
    const toHex = (val) => '0x' + Buffer.from(val).toString('hex');
    res.json({ handle: toHex(encrypted.handles[0]), inputProof: toHex(encrypted.inputProof), success: true });
  } catch(err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend on port ${PORT}`));
```

---

## 20. Stale Handle Anti-Pattern — CRITICAL

Every FHE operation creates a NEW handle. Old ACL permissions do not transfer.

```solidity
// WRONG — new handle has no permissions
_positions[msg.sender].debt = FHE.add(_positions[msg.sender].debt, amount);
// Missing re-grant

// CORRECT — re-grant after every FHE storage update
_positions[msg.sender].debt = FHE.add(_positions[msg.sender].debt, amount);
FHE.allowThis(_positions[msg.sender].debt);
FHE.allow(_positions[msg.sender].debt, msg.sender);
```

Rule: after every line that updates encrypted storage — immediately re-grant all permissions.

Symptoms of stale handles:
- User decrypts balance — shows 0 or wrong value
- Contract can't use handle in next transaction
- `FHE.eq(debt, _encryptedZero)` returns wrong result

---

## 21. Known Limitations and Workarounds

### Cannot branch on encrypted results

```solidity
// IMPOSSIBLE
require(FHE.ge(collateral, debt)); // WILL NOT COMPILE

// WORKAROUND — silent FHE.select
euint64 actualBorrow = FHE.select(withinLTV, amount, _encryptedZero);
```

### confidentialTransfer has no return value for accounting

Pool balance cannot be tracked in plaintext alongside encrypted transfers. Options:
- Remove pool counter entirely — let token balance be source of truth
- Accept user-supplied `plainAmount` for accounting only (token protects actual funds)

### Cannot check encrypted zero reliably inline

Store `_encryptedZero` in constructor. Never use `FHE.asEuint64(0)` inline.

### No oracle in pure FHE lending

Use fixed ratio collateralization instead of price feeds:
```solidity
ebool isLiquidatable = FHE.lt(
    FHE.mul(collateral, FHE.asEuint64(100)),
    FHE.mul(debt, FHE.asEuint64(150))
);
```

---

## 22. Remix-Specific Notes

Use raw GitHub URLs instead of npm imports:

```solidity
// Remix only
import "https://raw.githubusercontent.com/zama-ai/fhevm/refs/heads/main/lib/FHE.sol";
import "https://raw.githubusercontent.com/zama-ai/fhevm/refs/heads/main/config/ZamaConfig.sol";
```

To interact with deployed contract in Remix:
1. Compile the contract
2. Deploy tab → "At Address"
3. Paste deployed address

---

## 23. Render Free Tier Cold Start

Backend spins down after 50 seconds of inactivity. First request takes 30-60 seconds.

Wake backend on page load:

```javascript
async function wakeBackend() {
  try {
    await fetch(`${BACKEND_URL}/health`);
  } catch(e) {}
}
wakeBackend(); // call immediately on page load
```

---

## 24. missing revert data Error

`missing revert data (action="call", data=null, reason=null)` — contract reverted without reason string.

Most common causes on FHEVM:

1. `setOperator` not called — check `isOperator` first
2. `confidentialTransferFrom` failed — no cWETH balance
3. Position already exists — check `hasPosition` first
4. Pool empty on borrow — token has no balance to send

Debug:
```javascript
const isOp = await cweth.isOperator(userAddress, CONTRACT_ADDRESS);
console.log('isOperator:', isOp); // false = root cause
const hasPos = await contract.hasPosition(userAddress);
console.log('hasPosition:', hasPos); // true = already exists
```

---

## 25. Complete Operations Reference

### Full Type List

```solidity
euint8, euint16, euint32, euint64, euint128, euint256
eint8, eint16, eint32, eint64, eint128, eint256  // signed — coming soon
ebool
eaddress
ebytes1, ebytes4, ebytes8, ebytes16, ebytes32, ebytes64, ebytes128, ebytes256
```

### Security Guarantees

- 128 bits of security for all FHE operations
- p-fail of 2^-128
- Post-quantum resistant
- KMS uses 13 MPC nodes with threshold decryption

---

## 26. Quick Reference

| Task | Code |
|------|------|
| Import FHE | `import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol"` |
| Inherit config | `contract MyContract is ZamaEthereumConfig` |
| Decode user input | `euint64 amt = FHE.fromExternal(encAmt, proof)` |
| Allow contract | `FHE.allowThis(handle)` |
| Allow user | `FHE.allow(handle, userAddress)` |
| Allow token transfer | `FHE.allowTransient(handle, address(token))` |
| Safe subtraction | `FHE.sub(a, FHE.min(b, a))` |
| Division workaround | `FHE.le(FHE.mul(a,100), FHE.mul(b,66))` |
| Conditional transfer | `FHE.select(condition, amount, _encryptedZero)` |
| Parse cWETH amount | `ethers.parseUnits(amount, 8)` |
| Format cWETH amount | `ethers.formatUnits(balance, 8)` |
| Deploy | `npx hardhat run deploy/script.ts --network sepolia` |
| Interact post-deploy | Plain Node.js with explicit gasLimit |

---

*Built from real production bugs on Zama FHEVM Sepolia testnet.*
*Every anti-pattern here caused a real failure in production.*

---

## 27. Testing Checklist — FHEVM Contracts on Sepolia

Since you can't unit test FHE encryption results locally with real values, testing on Sepolia is the only source of truth. Use this checklist in order.

### Pre-Deploy

```bash
# 1. Check FHEVM compatibility
npx hardhat fhevm check-fhevm-compatibility --network sepolia --address <addr>

# 2. Verify compile was done for Sepolia
npx hardhat clean
npx hardhat compile --network sepolia

# 3. Check errors from compile
npx hardhat compile 2>&1 | grep "Error\|error\|Warning" | head -20
```

### Post-Deploy Script Test

Write a quick script to verify basic state:

```javascript
// test/quickCheck.mjs
import { ethers } from "ethers";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(ADDRESS, ABI, provider);

// Check basic state
console.log("Owner:", await contract.owner());
console.log("Total positions:", await contract.totalPositions());
console.log("Has position (deployer):", await contract.hasPosition(DEPLOYER));

// Check isOperator before deposit
const cweth = new ethers.Contract(CWETH, ['function isOperator(address,address) external view returns (bool)'], provider);
console.log("Is operator:", await cweth.isOperator(USER, CONTRACT));
```

### Frontend Test Flow

Test in this exact order — each step depends on the previous:

```
1. Connect wallet on Sepolia
2. Get cWETH from faucet
   - Mint WETH → Approve → Wrap
   - Check cWETH balance in wallet
3. setOperator — do this before deposit
   - Check isOperator returns true
4. Deposit cWETH
   - Check hasPosition returns true
5. Decrypt collateral balance
   - Sign EIP-712 wallet popup
   - Verify returned value matches deposit
6. Borrow within 66% LTV
   - Verify cWETH appears in wallet
7. Decrypt debt balance
   - Verify matches borrow amount
8. Repay debt
   - Verify debt balance shows 0 after decrypt
9. Close position
   - Verify collateral returned to wallet
```

### Debugging Silent Failures

FHE contracts fail silently — no revert reason. Use this debug order:

```javascript
// Step 1: Check operator
const isOp = await cweth.isOperator(userAddress, CONTRACT);
if (!isOp) console.error("ROOT CAUSE: setOperator not called");

// Step 2: Check position state
const hasPos = await contract.hasPosition(userAddress);
console.log("hasPosition:", hasPos);

// Step 3: Try static call to isolate revert
try {
  await contract.openPosition.staticCall(handle, proof, { from: userAddress });
} catch(e) {
  console.error("staticCall failed:", e.message);
}

// Step 4: Check tx on Sepolia Etherscan
// Look at input data — should show encrypted bytes not zeros
// If input data is 0x — ABI mismatch, wrong function called

// Step 5: Check backend logs on Render
// Dashboard → your service → Logs tab
// Look for encryption errors or SDK failures
```

### Verifying FHE Encryption is Working

On Sepolia Etherscan, a successful FHEVM transaction input data looks like:

```
Function: openPosition(bytes32 encryptedAmount, bytes inputProof)

MethodID: 0xb6363cf2
[0]:  000000000000000000000000000000000000000000000000...  ← 32 bytes handle
[1]:  0000000000000000000000000000000000000000000000c0  ← offset
[2]:  00000000000000000000000000000000000000000000005c  ← length
[3]:  a1b2c3d4e5f6...                                  ← encrypted proof bytes
```

If the input shows all zeros or very short data — encryption failed before the tx.

### FHE Transaction Takes Too Long

FHE operations on Sepolia take 5-30 seconds for the coprocessor to process. This is normal. Show a loading state in the frontend — never assume it timed out under 30 seconds.

```javascript
// Show loading immediately, don't timeout under 60s
showFheModal('Processing', 'FHE encryption takes 5-30 seconds...');
const tx = await contract.openPosition(handle, proof, { gasLimit: 1_000_000n });
// tx.wait() can take 30-60s on Sepolia — this is normal
await tx.wait();
closeFheModal();
```


---

## 28. fhevm-lint.js — Contract Auditor

Save as `fhevm-lint.js` in your project root. Run with `node fhevm-lint.js contracts/`.
Checks every anti-pattern in this SKILL.md. Fix all ERRORs before deploying to Sepolia.

```javascript
#!/usr/bin/env node
// fhevm-lint.js — FHEVM contract static auditor
// Usage: node fhevm-lint.js contracts/
// Checks for all anti-patterns documented in SKILL.md

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RESET  = '\x1b[0m';

const rules = [
  {
    id: 'NO_INLINE_ZERO',
    level: 'ERROR',
    desc: 'Inline FHE.asEuint64(0) — use _encryptedZero from constructor (SKILL.md §4)',
    // matches FHE.asEuint64(0) that is NOT inside a constructor body
    test: (src) => {
      const lines = src.split('\n');
      const issues = [];
      let inConstructor = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/constructor\s*\(/.test(line)) inConstructor++;
        if (inConstructor && line.includes('{')) inConstructor++;
        if (inConstructor && line.includes('}')) { inConstructor--; continue; }
        if (!inConstructor && /FHE\.asEuint\d+\(\s*0\s*\)/.test(line))
          issues.push({ line: i + 1, text: line.trim() });
      }
      return issues;
    },
  },
  {
    id: 'NO_FHE_DIV',
    level: 'ERROR',
    desc: 'FHE.div does not exist — use cross-multiplication (SKILL.md §5)',
    test: (src) => matchLines(src, /FHE\.div\s*\(/),
  },
  {
    id: 'NO_REQUIRE_EBOOL',
    level: 'ERROR',
    desc: 'require() on encrypted boolean — use FHE.select instead (SKILL.md §21)',
    test: (src) => matchLines(src, /require\s*\(\s*FHE\./),
  },
  {
    id: 'VIEW_WITH_FHE_ALLOW',
    level: 'ERROR',
    desc: 'view function contains FHE.allow — FHE.allow modifies state, remove view (SKILL.md §13)',
    test: (src) => {
      const issues = [];
      const fns = src.split(/function\s+/);
      let lineOffset = 0;
      for (const fn of fns) {
        const head = fn.split('{')[0];
        if (/\bview\b/.test(head) && /FHE\.allow/.test(fn.split('}')[0])) {
          const match = src.indexOf('function ' + fn.slice(0, 30));
          const lineNum = src.slice(0, match).split('\n').length;
          issues.push({ line: lineNum, text: ('function ' + fn.slice(0, 60)).trim() + '…' });
        }
        lineOffset += fn.split('\n').length;
      }
      return issues;
    },
  },
  {
    id: 'MISSING_ALLOW_TRANSIENT',
    level: 'ERROR',
    desc: 'confidentialTransferFrom called without FHE.allowTransient before it (SKILL.md §6)',
    test: (src) => {
      const issues = [];
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/confidentialTransferFrom/.test(lines[i])) {
          const prev = lines.slice(Math.max(0, i - 5), i).join('\n');
          if (!/FHE\.allowTransient/.test(prev))
            issues.push({ line: i + 1, text: lines[i].trim() });
        }
      }
      return issues;
    },
  },
  {
    id: 'UNCAPTURED_TRANSFER',
    level: 'ERROR',
    desc: 'confidentialTransferFrom return value not captured — use received = transferFrom(...) (SKILL.md §8)',
    test: (src) => matchLines(src, /^\s*(?:\w+\.)?confidentialTransferFrom\s*\(/),
  },
  {
    id: 'ERC20_APPROVE_ON_CWETH',
    level: 'ERROR',
    desc: 'approve() on confidential token — ERC-7984 uses setOperator() (SKILL.md §8)',
    test: (src) => matchLines(src, /\.approve\s*\(\s*(?:CONTRACT|contract|address)/i),
  },
  {
    id: 'STALE_HANDLE',
    level: 'ERROR',
    desc: 'FHE op result assigned to storage without FHE.allowThis — stale handle (SKILL.md §20)',
    test: (src) => {
      const issues = [];
      const lines = src.split('\n');
      const fheOps = /= FHE\.(add|sub|mul|select|min|max|and|or|not|shl|shr)\(/;
      for (let i = 0; i < lines.length; i++) {
        if (fheOps.test(lines[i]) && /\._\w+\s*=/.test(lines[i])) {
          const next5 = lines.slice(i + 1, i + 4).join('\n');
          if (!/FHE\.allowThis/.test(next5))
            issues.push({ line: i + 1, text: lines[i].trim() });
        }
      }
      return issues;
    },
  },
  {
    id: 'MISSING_ZAMA_CONFIG',
    level: 'ERROR',
    desc: 'Contract does not inherit ZamaEthereumConfig (SKILL.md §4)',
    test: (src) => {
      if (!/contract\s+\w+/.test(src)) return [];
      if (/is\s+.*ZamaEthereumConfig/.test(src)) return [];
      if (!/import.*FHE\.sol/.test(src)) return []; // not an FHE contract
      return [{ line: 1, text: 'Missing: contract X is ZamaEthereumConfig' }];
    },
  },
  {
    id: 'NO_ENCRYPTED_ZERO_IN_CONSTRUCTOR',
    level: 'WARN',
    desc: 'Uses FHE comparisons but no _encryptedZero in constructor (SKILL.md §4)',
    test: (src) => {
      if (!/FHE\.(eq|ne|lt|le|gt|ge)\(/.test(src)) return [];
      if (/constructor[\s\S]*?FHE\.asEuint\d+\(\s*0\s*\)/.test(src)) return [];
      return [{ line: 1, text: 'Add _encryptedZero = FHE.asEuint64(0) to constructor' }];
    },
  },
  {
    id: 'UNSAFE_SUBTRACTION',
    level: 'WARN',
    desc: 'FHE.sub without FHE.min guard — underflow risk (SKILL.md §5)',
    test: (src) => {
      const issues = [];
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/FHE\.sub\(/.test(lines[i])) {
          const prev = lines.slice(Math.max(0, i - 3), i).join('\n');
          if (!/FHE\.min\(/.test(prev) && !/FHE\.min\(/.test(lines[i]))
            issues.push({ line: i + 1, text: lines[i].trim() });
        }
      }
      return issues;
    },
  },
  {
    id: 'EUINT_IN_ABI',
    level: 'WARN',
    desc: 'euint type in ABI string — ethers.js needs bytes32 (SKILL.md §16)',
    test: (src) => matchLines(src, /['"`]function\s+\w+\([^)]*euint/),
  },
  {
    id: 'MISSING_MAKE_PUBLICLY_DECRYPTABLE',
    level: 'WARN',
    desc: 'revealResults-like function uses FHE.allow(handle, owner) — use FHE.makePubliclyDecryptable for public results (SKILL.md §33)',
    test: (src) => {
      const issues = [];
      const lines = src.split('\n');
      let inReveal = false;
      for (let i = 0; i < lines.length; i++) {
        if (/function\s+(reveal|disclose|publish)/i.test(lines[i])) inReveal = true;
        if (inReveal && /FHE\.allow\(/.test(lines[i]) && !/makePubliclyDecryptable/.test(src))
          issues.push({ line: i + 1, text: lines[i].trim() });
        if (inReveal && /^\s*\}/.test(lines[i])) inReveal = false;
      }
      return issues;
    },
  },
];

function matchLines(src, regex) {
  const issues = [];
  src.split('\n').forEach((line, i) => {
    if (regex.test(line)) issues.push({ line: i + 1, text: line.trim() });
  });
  return issues;
}

function lintFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const findings = [];
  for (const rule of rules) {
    const hits = rule.test(src);
    for (const hit of hits)
      findings.push({ ...rule, ...hit, file: filePath });
  }
  return findings;
}

function collectSolFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collectSolFiles(full));
    else if (extname(full) === '.sol') files.push(full);
  }
  return files;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const target = process.argv[2] || 'contracts';
const files  = statSync(target).isDirectory() ? collectSolFiles(target) : [target];

let errors = 0, warnings = 0;

for (const file of files) {
  const findings = lintFile(file);
  if (findings.length === 0) {
    console.log(`${GREEN}✓${RESET} ${file}`);
    continue;
  }
  console.log(`\n${file}`);
  for (const f of findings) {
    const color = f.level === 'ERROR' ? RED : YELLOW;
    const icon  = f.level === 'ERROR' ? '✗' : '⚠';
    console.log(`  ${color}${icon} [${f.id}] Line ${f.line}: ${f.desc}${RESET}`);
    console.log(`    → ${f.text}`);
    if (f.level === 'ERROR') errors++;
    else warnings++;
  }
}

console.log(`\n${'─'.repeat(60)}`);
if (errors === 0 && warnings === 0) {
  console.log(`${GREEN}All checks passed.${RESET}`);
} else {
  if (errors)   console.log(`${RED}${errors} error(s) — fix before deploying${RESET}`);
  if (warnings) console.log(`${YELLOW}${warnings} warning(s) — review before deploying${RESET}`);
}
process.exit(errors > 0 ? 1 : 0);
```

### Usage

```bash
# Lint all contracts in contracts/ folder
node fhevm-lint.js contracts/

# Lint a single file
node fhevm-lint.js contracts/ConfidentialVoting.sol
```

### What It Checks

| Rule | Level | Anti-pattern |
|------|-------|--------------|
| `NO_INLINE_ZERO` | ERROR | `FHE.asEuint64(0)` outside constructor |
| `NO_FHE_DIV` | ERROR | `FHE.div(...)` call (doesn't exist) |
| `NO_REQUIRE_EBOOL` | ERROR | `require(FHE.xxx(...))` |
| `VIEW_WITH_FHE_ALLOW` | ERROR | `view` function containing `FHE.allow` |
| `MISSING_ALLOW_TRANSIENT` | ERROR | `confidentialTransferFrom` without prior `FHE.allowTransient` |
| `UNCAPTURED_TRANSFER` | ERROR | `confidentialTransferFrom` return value discarded |
| `ERC20_APPROVE_ON_CWETH` | ERROR | `.approve(contract...)` on confidential token |
| `STALE_HANDLE` | ERROR | FHE op on storage without `FHE.allowThis` after |
| `MISSING_ZAMA_CONFIG` | ERROR | Contract missing `is ZamaEthereumConfig` |
| `NO_ENCRYPTED_ZERO_IN_CONSTRUCTOR` | WARN | Uses FHE comparisons, no `_encryptedZero` in constructor |
| `UNSAFE_SUBTRACTION` | WARN | `FHE.sub` without `FHE.min` guard |
| `EUINT_IN_ABI` | WARN | `euint` type in ethers.js ABI string |
| `MISSING_MAKE_PUBLICLY_DECRYPTABLE` | WARN | Reveal function uses `FHE.allow` instead of `makePubliclyDecryptable` |

Exit code `1` if any ERRORs — use in CI to block deploys.

---

## 29. Complete Error Lookup Table

Every error you'll hit on FHEVM — cause and fix in one place.

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `FHE.div is not a function` | `FHE.div` doesn't exist | Cross-multiply instead |
| `Function cannot be declared as view` | `FHE.allow` called inside `view` function | Remove `view` modifier |
| `TypeError: Function cannot be declared as view because this expression (potentially) modifies the state` | Same as above | Remove `view` modifier |
| `missing revert data (data=null, reason=null)` | Contract reverted silently | Check `isOperator`, `hasPosition`, token balance |
| `InvalidTypeError createEIP712` | `chainId` passed as BigInt | `Number(domain.chainId)` |
| `signature must not include 0x prefix` | Ethers adds `0x` to signatures | `signature.replace('0x', '')` |
| `Cannot serialize BigInt` | Keypair has BigInt values | Serialize with custom JSON replacer |
| `handle not found in result` | Handle format mismatch between prepare and decrypt | Use same hex string in both calls |
| `ACL permission denied` | Contract never called `FHE.allow(handle, user)` | Add `FHE.allow` in getter function |
| `no matching fragment` | Wrong ABI — using `euint64` not `bytes32` | Use `bytes32` in ethers.js ABI strings |
| `execution reverted (no data)` | Same as missing revert data | Check operator, balance, position state |
| `Contract address is not a valid address` | Lowercase address passed to SDK | `ethers.getAddress(contractAddress)` |
| `estimateGas failed` | FHEVM plugin blocks gas estimation on Sepolia | Use plain Node.js with explicit `gasLimit` |
| `ENOTFOUND relayer.testnet.zama.cloud` | Old RPC URL — DNS dead | Use `publicnode.com` RPC |
| `403 Forbidden` | Blocked RPC (`blastapi.io`) | Use `publicnode.com` RPC |
| `No such module @zama-fhe/relayer-sdk` | Cloudflare Workers can't import SDK | Use Node.js backend on Render |
| `Compilation failed` | FHEVM plugin compile issue | Run `npx hardhat clean` then recompile |
| `Internal exception` | Compiled for hardhat, deployed to Sepolia | `clean` + `compile --network sepolia` |
| `HH600: Compilation failed` | Solidity error in contract | Run `npx hardhat compile 2>&1 | grep Error` |
| `approve() reverts on cWETH` | ERC-7984 doesn't support `approve()` | Use `setOperator()` instead |
| `confidentialTransferFrom reverts` | `setOperator` not called | Call `setOperator(contract, until)` first |
| `balance shows 0 after deposit` | Stale handle — ACL permissions not re-granted | `FHE.allowThis` + `FHE.allow` after every FHE op |
| `FHE.eq returns wrong result` | Inline `FHE.asEuint64(0)` has no ACL | Use `_encryptedZero` from constructor |
| `closePosition returns 0 collateral` | Debt exists — FHE.select returned 0 | Repay all debt first |
| `borrow returns 0` | LTV exceeded — FHE.select returned 0 | Reduce borrow amount below 66% of collateral |
| `wrap() fails` | WETH not approved before wrapping | `weth.approve(CWETH_ADDRESS, amount)` first |
| `amount display is 10x wrong` | Using 18 decimals for 8-decimal cWETH | `ethers.parseUnits(amount, 8)` not `parseEther` |
| `tx takes 30+ seconds` | Normal — FHE coprocessor processing time | Show loading state, never timeout under 60s |
| `Etherscan verification fails` | FHEVM plugin transforms bytecode | Cannot verify — link GitHub source instead |

---

## 29. Complete End-to-End Script (Deploy + Fund + Verify)

A single script an AI agent can run to deploy, fund, and verify a FHEVM contract from scratch.

```javascript
// deploy/fullSetup.mjs
// Run: node deploy/fullSetup.mjs
// Deploys contract, mints cWETH, funds pool, verifies state

import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

const RPC      = "https://ethereum-sepolia-rpc.publicnode.com";
const WETH     = "0xff54739b16576FA5402F211D0b938469Ab9A5f3F";
const CWETH    = "0x46208622DA27d91db4f0393733C8BA082ed83158";
const BACKEND  = process.env.BACKEND_URL; // e.g. https://your-app.onrender.com

const CWETH_DECIMALS = 8;
const FUND_AMOUNT    = 500; // cWETH units (8 decimals)

const provider = new ethers.JsonRpcProvider(RPC);
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

console.log("Deployer:", signer.address);
console.log("Balance:", ethers.formatEther(await provider.getBalance(signer.address)), "ETH");

// ─── Step 1: Mint WETH ─────────────────────────────────────────────────────
const weth = new ethers.Contract(WETH, [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)"
], signer);

console.log("\n[1] Minting WETH...");
await (await weth.mint(signer.address, ethers.parseUnits("1", 18), { gasLimit: 200_000 })).wait();
console.log("    WETH minted");

// ─── Step 2: Wrap to cWETH ────────────────────────────────────────────────
const cweth = new ethers.Contract(CWETH, [
  "function wrap(address to, uint256 amount) external",
  "function setOperator(address operator, uint48 until) external",
  "function isOperator(address account, address operator) external view returns (bool)"
], signer);

console.log("[2] Approving WETH...");
await (await weth.approve(CWETH, ethers.parseUnits("1", 18), { gasLimit: 100_000 })).wait();

console.log("[3] Wrapping to cWETH...");
await (await cweth.wrap(signer.address, ethers.parseUnits("1", 18), { gasLimit: 200_000 })).wait();
console.log("    cWETH balance ready");

// ─── Step 3: Deploy contract ──────────────────────────────────────────────
// NOTE: Deploy via hardhat first, then pass address here
// npx hardhat clean && npx hardhat compile --network sepolia
// npx hardhat run deploy/deployVeil.ts --network sepolia
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
if (!CONTRACT_ADDRESS) throw new Error("Set CONTRACT_ADDRESS in .env");

// ─── Step 4: Set operator ─────────────────────────────────────────────────
console.log("[4] Setting operator...");
const until = Math.floor(Date.now()/1000) + 365*24*60*60;
const isOp = await cweth.isOperator(signer.address, CONTRACT_ADDRESS);
if (!isOp) {
  await (await cweth.setOperator(CONTRACT_ADDRESS, until, { gasLimit: 100_000 })).wait();
  console.log("    Operator set");
} else {
  console.log("    Already operator");
}

// ─── Step 5: Fund pool via backend encrypt ────────────────────────────────
console.log("[5] Encrypting fund amount...");
const res = await fetch(`${BACKEND}/encrypt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    amount: FUND_AMOUNT.toString(),
    contractAddress: CONTRACT_ADDRESS,
    userAddress: signer.address
  })
});
const { handle, inputProof, success } = await res.json();
if (!success) throw new Error("Encryption failed");
console.log("    Got handle:", handle.slice(0, 18) + "...");

const contract = new ethers.Contract(CONTRACT_ADDRESS, [
  "function addLiquidity(bytes32 encryptedAmount, bytes inputProof) external",
  "function totalPositions() external view returns (uint256)",
  "function hasPosition(address) external view returns (bool)"
], signer);

console.log("[6] Funding pool...");
const tx = await contract.addLiquidity(handle, inputProof, { gasLimit: 1_000_000 });
await tx.wait();
console.log("    Pool funded! Tx:", tx.hash);

// ─── Step 6: Verify state ─────────────────────────────────────────────────
console.log("\n[7] Verifying state...");
console.log("    Total positions:", (await contract.totalPositions()).toString());
console.log("    Has position (deployer):", await contract.hasPosition(signer.address));
console.log("    isOperator:", await cweth.isOperator(signer.address, CONTRACT_ADDRESS));

console.log("\nSetup complete. Contract ready at:", CONTRACT_ADDRESS);
console.log("Sepolia Etherscan:", `https://sepolia.etherscan.io/address/${CONTRACT_ADDRESS}`);
```

---

## 30. TypeScript Types for Hardhat Config

```typescript
// hardhat.config.ts — full typed version
import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import type { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL 
  ?? "https://ethereum-sepolia-rpc.publicnode.com";

if (!PRIVATE_KEY) console.warn("WARNING: PRIVATE_KEY not set in .env");

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      // Local mock FHE — fast, for unit tests
    },
    sepolia: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
      url: SEPOLIA_RPC,
      // CRITICAL: never set gasPrice/gasLimit here
      // estimateGas is blocked by FHEVM plugin on Sepolia
      // Always set gasLimit per-transaction instead
    },
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun", // CRITICAL: must be cancun for FHEVM
    },
  },
  // Etherscan verification will fail for FHEVM contracts
  // Include anyway for non-FHEVM contracts in same project
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
};

export default config;
```

**package.json dependencies:**

```json
{
  "devDependencies": {
    "@fhevm/hardhat-plugin": "^0.1.0",
    "@nomicfoundation/hardhat-ethers": "^3.0.0",
    "@nomicfoundation/hardhat-verify": "^2.0.0",
    "hardhat": "^2.22.0",
    "typescript": "^5.0.0",
    "ts-node": "^10.9.0"
  },
  "dependencies": {
    "@fhevm/solidity": "^0.1.0",
    "@openzeppelin/confidential-contracts": "^0.1.0",
    "ethers": "^6.7.0"
  }
}
```


---

## 31. React dApp Template Setup

The official Zama React template is the recommended starting point for full-stack FHEVM dApps.

### Clone and Setup

```bash
git clone https://github.com/zama-ai/fhevm-react-template
cd fhevm-react-template

# Initialize submodules — includes fhevm-hardhat-template
git submodule update --init --recursive

# Install dependencies (uses pnpm)
pnpm install
```

### Monorepo Structure

```
fhevm-react-template/
├── packages/
│   ├── fhevm-hardhat-template/  # Smart contracts + deployment
│   ├── fhevm-sdk/               # FHEVM SDK package
│   └── nextjs/                  # React frontend (Next.js + RainbowKit + Tailwind)
└── scripts/                     # Build and deployment scripts
```

### Environment Variables

```bash
MNEMONIC=your_wallet_mnemonic
INFURA_API_KEY=your_infura_key
```

### Dev Commands

```bash
# Terminal 1 — start local Hardhat node
pnpm chain

# Terminal 2 — deploy contracts
pnpm deploy:localhost

# Terminal 3 — start frontend
pnpm start

# For Sepolia
pnpm deploy:sepolia
```

### SDK Packages — Which One to Use

There are three related but distinct packages:

| Package | Use case | Notes |
|---------|----------|-------|
| `@zama-fhe/relayer-sdk` | Node.js backend AND browser frontend | Use the pre-built bundle for browser — see Section 16 |
| `@fhevm/sdk` | **DO NOT USE for browser** | v1.0.0-alpha.x exports are empty (`export {}`), API is `createFhevmClient` not `createInstance` |
| `fhevmjs` | Old GitHub repo name | Now published as `@zama-fhe/relayer-sdk` |

**For browser frontend — use the pre-built bundle (see Section 16):**

Do NOT `npm install @zama-fhe/relayer-sdk` and import it directly in Vite/React — WASM initialization fails at build time. Instead, use the pre-built bundle from `node_modules/@zama-fhe/relayer-sdk/lib/web.js` placed in `public/relayer-sdk/` with sed-patched WASM paths.

**For Node.js backend (relayer-sdk):**

```bash
npm install @zama-fhe/relayer-sdk
```

```javascript
const { createInstance, SepoliaConfig } = require('@zama-fhe/relayer-sdk/node');
const instance = await createInstance({
  ...SepoliaConfig,
  network: 'https://ethereum-sepolia-rpc.publicnode.com',
});
```

---

## 32. OpenZeppelin Confidential Contracts

The official audited library for FHEVM contracts. Use instead of writing from scratch.

### Install

```bash
npm install @openzeppelin/confidential-contracts
```

### ERC7984 — Confidential Token Base Contract

Build your own confidential token by extending `ERC7984`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC7984 } from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract MyConfidentialToken is ERC7984, ZamaEthereumConfig {
    constructor()
        ERC7984("MyToken", "MTK", "https://my-contract-uri.com")
    {}

    function mint(address to, uint64 amount) external {
        _mint(to, amount);
    }
}
```

### Available Contracts

```
@openzeppelin/confidential-contracts/
├── token/
│   └── ERC7984/
│       ├── ERC7984.sol              # Base confidential token
│       ├── extensions/
│       │   ├── ERC7984Burnable.sol  # Add burn functionality
│       │   ├── ERC7984Mintable.sol  # Add mint functionality
│       │   └── ERC7984Wrapper.sol   # Wrap ERC20 → ERC7984
├── governance/
│   └── ConfidentialVoting.sol       # Private voting
├── finance/
│   └── ConfidentialVesting.sol      # Private vesting schedule
└── utils/
    └── EncryptedErrors.sol          # Error handling for FHE
```

### ERC7984Wrapper — Wrap ERC20 to Confidential Token

```solidity
import { ERC7984Wrapper } from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984Wrapper.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WrappedUSDC is ERC7984Wrapper, ZamaEthereumConfig {
    constructor(IERC20 underlying)
        ERC7984("Confidential USDC", "cUSDC", "")
        ERC7984Wrapper(underlying)
    {}
}
```

**Wrap flow (ERC20 → ERC7984):**
```javascript
// 1. Approve underlying ERC20
await usdc.approve(wrappedUSDC.address, amount);

// 2. Wrap to get confidential token
await wrappedUSDC.wrap(userAddress, amount);

// 3. Now balance is encrypted — use setOperator + confidentialTransferFrom
```

---

## 33. Public Decryption Pattern — CRITICAL (v0.11.1+)

**WARNING: The Gateway callback pattern (`Gateway.requestDecryption` + `onlyGateway` callback) is OUTDATED and does NOT work in `@fhevm/solidity@0.11.1`.** The correct pattern uses `FHE.makePubliclyDecryptable()` + `FHE.checkSignatures()`.

Different from user decryption. Used when results should be readable by **anyone** — vote tallies, auction outcomes, public scores.

### When to Use

- Reveal vote tallies after voting ends
- Reveal auction winner publicly
- Any encrypted value that should become public after a trigger

### Correct Pattern (@fhevm/solidity@0.11.1)

Two-step flow: contract marks handles → frontend fetches KMS decryption → contract verifies and stores plaintext.

**Step 1: Contract marks tallies as publicly decryptable**

```solidity
import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

contract MyContract is ZamaEthereumConfig {
    euint64 private _secret;
    uint64  public  revealedValue;
    bool    public  decryptionPending;
    bool    public  resultsRevealed;

    event DecryptionRequested(bytes32 handle);

    // Owner triggers public decryption
    function requestReveal() external onlyOwner {
        require(!decryptionPending, "Already pending");
        euint64 marked = FHE.makePubliclyDecryptable(_secret);
        _secret = marked;
        decryptionPending = true;
        emit DecryptionRequested(euint64.unwrap(marked));
    }

    // Get raw bytes32 handle for frontend to pass to publicDecrypt
    function getSecretHandle() external view returns (bytes32) {
        return euint64.unwrap(_secret);
    }

    // Anyone submits the KMS decryption result — FHE.checkSignatures verifies on-chain
    function submitDecryptionResult(
        bytes32[] calldata handlesList,
        bytes calldata abiEncodedCleartexts,
        bytes calldata decryptionProof
    ) external {
        require(decryptionPending, "Not pending");
        require(!resultsRevealed, "Already revealed");

        // Reverts if KMS signatures are invalid
        FHE.checkSignatures(handlesList, abiEncodedCleartexts, decryptionProof);

        (uint64 value) = abi.decode(abiEncodedCleartexts, (uint64));
        revealedValue = value;
        decryptionPending = false;
        resultsRevealed = true;
    }
}
```

**Step 2: Frontend calls `instance.publicDecrypt()` then submits proof**

```javascript
// After requestReveal() tx confirms:
const handle = await roContract.getSecretHandle(); // bytes32
const result = await instance.publicDecrypt([handle]);
// result: { clearValues, abiEncodedClearValues, decryptionProof }

await contract.submitDecryptionResult(
  [handle],
  result.abiEncodedClearValues,
  result.decryptionProof,
  { gasLimit: 500_000n }
);

// Now revealedValue is readable by anyone
const value = await roContract.revealedValue();
```

**Multiple values (e.g. for/against tallies):**

```solidity
// In contract — handle order must match abiEncodedCleartexts order
function submitDecryptionResult(
    bytes32[] calldata handlesList,   // [forHandle, againstHandle]
    bytes calldata abiEncodedCleartexts,  // abi.encode(uint64, uint64)
    bytes calldata decryptionProof
) external {
    FHE.checkSignatures(handlesList, abiEncodedCleartexts, decryptionProof);
    (uint64 votesFor, uint64 votesAgainst) = abi.decode(abiEncodedCleartexts, (uint64, uint64));
    // store...
}
```

```javascript
// Frontend — pass handles in same order as contract expects
const [forHandle, againstHandle] = await Promise.all([
  roContract.getVotesForHandle(proposalId),
  roContract.getVotesAgainstHandle(proposalId),
]);
const result = await instance.publicDecrypt([forHandle, againstHandle]);
await contract.submitDecryptionResult(
  [forHandle, againstHandle],
  result.abiEncodedClearValues,
  result.decryptionProof
);
```

### Key Rules

- `FHE.makePubliclyDecryptable(handle)` returns the SAME euint64 — store the return value
- `euint64.unwrap(handle)` gives the `bytes32` the frontend needs
- `FHE.checkSignatures` reverts on bad signatures — no need for manual require
- Handle order in `handlesList` must exactly match the order of values in `abiEncodedCleartexts`
- `submitDecryptionResult` can be called by ANYONE — it's permissionless (KMS proof does the auth)

### Key Differences vs User Decryption

| | User Decryption | Public Decryption |
|--|----------------|-------------------|
| Who decrypts | Individual user via EIP-712 wallet signature | KMS relayer, proof submitted on-chain |
| Result | Returned to user only (private) | Stored publicly on-chain, readable by anyone |
| Use case | Show user their own balance | Reveal vote tally, auction result |
| Contract side | `FHE.allow(handle, userAddress)` | `FHE.makePubliclyDecryptable(handle)` |
| Frontend SDK call | `instance.userDecrypt(...)` | `instance.publicDecrypt([handle1, handle2])` |
| On-chain verification | None (off-chain only) | `FHE.checkSignatures(handlesList, cleartext, proof)` |

---

## 34. Confidential Token Registry (Sepolia)

Official testnet tokens from the Zama Protocol token registry:

| Token | Symbol | Address | Decimals | Underlying |
|-------|--------|---------|----------|------------|
| Confidential WETH | cWETH | `0x46208622DA27d91db4f0393733C8BA082ed83158` | 8 | WETH |
| Confidential USDC | cUSDC | Check registry | 6 | USDC |

**Always verify current addresses at:** `https://docs.zama.ai/protocol`

### Getting Testnet cWETH

```javascript
const WETH  = "0xff54739b16576FA5402F211D0b938469Ab9A5f3F";
const CWETH = "0x46208622DA27d91db4f0393733C8BA082ed83158";

// 1. Mint WETH
await weth.mint(userAddress, ethers.parseUnits("1", 18));

// 2. Approve
await weth.approve(CWETH, ethers.parseUnits("1", 18));

// 3. Wrap to cWETH (8 decimals)
await cweth.wrap(userAddress, ethers.parseUnits("1", 18));
```


---

## 35. Project Bootstrap — Full Hardhat Setup

When starting a new FHEVM project from scratch, use this exact setup. Copy these files into the project root before writing any contracts.

### package.json

```json
{
  "name": "fhevm-project",
  "version": "1.0.0",
  "scripts": {
    "compile": "hardhat compile",
    "test": "hardhat test",
    "deploy:sepolia": "hardhat run deploy/deploy.ts --network sepolia",
    "clean": "hardhat clean"
  },
  "devDependencies": {
    "@fhevm/hardhat-plugin": "^0.1.0",
    "@nomicfoundation/hardhat-ethers": "^3.0.0",
    "@nomicfoundation/hardhat-verify": "^2.0.0",
    "@types/node": "^20.0.0",
    "hardhat": "^2.22.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "@fhevm/solidity": "^0.1.0",
    "@openzeppelin/confidential-contracts": "^0.1.0",
    "@openzeppelin/contracts": "^5.0.0",
    "ethers": "^6.7.0"
  }
}
```

### hardhat.config.ts

```typescript
import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import type { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const SEPOLIA_RPC  = process.env.SEPOLIA_RPC_URL
  ?? "https://ethereum-sepolia-rpc.publicnode.com";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {},
    sepolia: {
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
      url: SEPOLIA_RPC,
    },
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
};

export default config;
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist"
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### .env.example

```bash
PRIVATE_KEY=your_private_key_here
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

### Setup Commands

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env
# Add your PRIVATE_KEY to .env

# 3. Compile for Sepolia — always clean first
npx hardhat clean
npx hardhat compile --network sepolia

# 4. Run tests locally
npx hardhat test

# 5. Deploy to Sepolia
npx hardhat run deploy/deploy.ts --network sepolia
```

### Deploy Script Template

```typescript
// deploy/deploy.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(
    await deployer.provider.getBalance(deployer.address)
  ), "ETH");

  const Contract = await ethers.getContractFactory("YourContract");
  const contract = await Contract.deploy(/* constructor args */);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("Deployed at:", address);
  console.log("Etherscan:", `https://sepolia.etherscan.io/address/${address}`);
}

main().catch(console.error);
```


---

## 36. Deploying from Android / Termux — Remix IDE Required

**Hardhat CANNOT compile or deploy on Android (Termux).** The `@nomicfoundation/edr` package requires a native binary (`edr-android-arm64`) that does not exist. Any `npx hardhat compile` or `npx hardhat run` will fail with:

```
Error: Cannot find module '@nomicfoundation/edr-android-arm64'
```

### Solution: Deploy via Remix IDE

Use [remix.ethereum.org](https://remix.ethereum.org) from your mobile or desktop browser.

**Step 1: Get a flattened contract**

FHEVM contracts use npm imports (`@fhevm/solidity/...`). Remix needs raw GitHub URLs or a flattened file. Use these import substitutions for Remix:

```solidity
// Replace npm imports with raw GitHub URLs for Remix
import "https://raw.githubusercontent.com/zama-ai/fhevm/refs/heads/main/lib/FHE.sol";
import "https://raw.githubusercontent.com/zama-ai/fhevm/refs/heads/main/config/ZamaConfig.sol";
```

**Step 2: Compile in Remix**

- Compiler tab → `0.8.24` → Enable optimization (200 runs)
- EVM version: `cancun`
- Click Compile

**Step 3: Deploy**

- Deploy tab → Environment: `Injected Provider - MetaMask`
- Switch MetaMask to Sepolia
- Click Deploy → confirm in MetaMask
- Copy the deployed address from the Remix terminal

**Step 4: Update frontend**

```javascript
// frontend/src/App.jsx or config.js
const CONTRACT_ADDRESS = "0xYourNewAddress";
```

Then rebuild and redeploy the frontend (e.g. `npm run build` + push to GitHub Pages).

### Workflow for Termux Developers

```
Write contract in Termux (VSCode/vim)
    ↓
Push to GitHub
    ↓
Open Remix → load from GitHub or paste contract
    ↓
Compile + Deploy via MetaMask on Sepolia
    ↓
Copy address → update frontend/src/App.jsx in Termux
    ↓
npm run build + gh push → GitHub Pages
```

---

## 38. Test File Template

Use this as the base for all FHEVM contract tests. Runs on local Hardhat network with mock encryption.

```typescript
// test/ConfidentialVoting.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ConfidentialVoting", function () {
  let contract: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    const Contract = await ethers.getContractFactory("ConfidentialVoting");
    contract = await Contract.deploy();
    await contract.waitForDeployment();
  });

  it("should deploy successfully", async function () {
    expect(await contract.getAddress()).to.be.properAddress;
  });

  it("should set deployer as owner", async function () {
    expect(await contract.owner()).to.equal(owner.address);
  });

  it("should create a proposal", async function () {
    await contract.connect(owner).createProposal("Should we upgrade?");
    expect(await contract.proposalCount()).to.equal(1);
  });

  it("should track who has voted", async function () {
    await contract.connect(owner).createProposal("Test proposal");
    // Note: on local Hardhat, encrypted inputs are mocked
    // Test contract state logic not encryption correctness
    expect(await contract.hasVoted(alice.address, 0)).to.be.false;
  });

  it("should reject double voting", async function () {
    await contract.connect(owner).createProposal("Test proposal");
    // cast vote once — use mock handle and proof for local testing
    const mockHandle = ethers.zeroPadValue("0x01", 32);
    const mockProof  = "0x";
    await contract.connect(alice).castVote(0, mockHandle, mockProof);
    // second vote should revert
    await expect(
      contract.connect(alice).castVote(0, mockHandle, mockProof)
    ).to.be.revertedWith("Already voted");
  });

  it("should only allow owner to reveal results", async function () {
    await contract.connect(owner).createProposal("Test proposal");
    await expect(
      contract.connect(alice).revealResults(0)
    ).to.be.revertedWith("Not owner");
  });
});
```

### Run Tests

```bash
# Local mock encryption — fast
npx hardhat test

# With gas reporting
REPORT_GAS=true npx hardhat test

# Specific test file
npx hardhat test test/ConfidentialVoting.test.ts
```

---

## 39. Standalone HTML Template (No Build Step)

Use this when you want a single `.html` file that works without React, Vite, or npm. Good for quick prototyping or deploying a minimal dApp directly to GitHub Pages.

### Required File Structure

```
your-repo/
  index.html              ← this template
  tfhe_bg.wasm            ← copy from node_modules/@zama-fhe/relayer-sdk/lib/
  kms_lib_bg.wasm         ← copy from node_modules/@zama-fhe/relayer-sdk/lib/
  relayer-sdk/
    relayer-sdk-js.js     ← sed-patched bundle (see Section 16)
    workerHelpers.js      ← copy from node_modules/@zama-fhe/relayer-sdk/lib/
```

**WASM path patch (must match your GitHub Pages subdirectory):**
```bash
sed -i 's|"/tfhe_bg.wasm"|"/your-repo-name/tfhe_bg.wasm"|g' relayer-sdk/relayer-sdk-js.js
sed -i 's|"/kms_lib_bg.wasm"|"/your-repo-name/kms_lib_bg.wasm"|g' relayer-sdk/relayer-sdk-js.js
```

### index.html

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Confidential Voting — FHEVM</title>
  <style>
    body { font-family: monospace; max-width: 640px; margin: 40px auto; padding: 0 20px; background: #0f0f0f; color: #e0e0e0; }
    h1   { color: #a78bfa; }
    button { background: #7c3aed; color: #fff; border: none; padding: 8px 16px; cursor: pointer; border-radius: 4px; margin: 4px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    input  { background: #1e1e1e; color: #e0e0e0; border: 1px solid #444; padding: 8px; width: 100%; box-sizing: border-box; border-radius: 4px; margin: 4px 0; }
    .card  { border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 12px 0; background: #1a1a1a; }
    .status { background: #1e1e1e; padding: 10px; border-radius: 4px; margin: 8px 0; min-height: 36px; font-size: 13px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; }
    .badge-active   { background: #064e3b; color: #34d399; }
    .badge-ended    { background: #1c1917; color: #a8a29e; }
    .badge-revealed { background: #1e1b4b; color: #a78bfa; }
    .overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.7); place-items:center; }
    .overlay.show { display:grid; }
    .modal { background:#1a1a1a; border:1px solid #333; border-radius:12px; padding:32px; text-align:center; max-width:360px; }
    .spinner { width:40px; height:40px; border:3px solid #333; border-top-color:#7c3aed; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

<h1>🔒 Confidential Voting</h1>
<p>Powered by Zama FHEVM · Sepolia</p>

<div>
  <button id="connectBtn">Connect Wallet</button>
  <span id="walletInfo"></span>
</div>

<div class="status" id="status">Not connected</div>

<div id="ownerPanel" style="display:none" class="card">
  <strong>Owner — Create Proposal</strong><br><br>
  <input id="proposalName" placeholder="e.g. Should we upgrade the protocol?" maxlength="120" />
  <button id="createBtn">+ Create</button>
</div>

<div id="proposals"></div>

<div class="overlay" id="overlay">
  <div class="modal">
    <div class="spinner"></div>
    <div id="overlayTitle" style="font-weight:bold;margin-bottom:8px"></div>
    <div id="overlayMsg" style="color:#aaa;font-size:13px"></div>
  </div>
</div>

<!-- ethers v6 from CDN -->
<script type="module">
import { BrowserProvider, Contract, ethers } from
  'https://cdn.jsdelivr.net/npm/ethers@6.13.0/dist/ethers.min.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = '0xYOUR_CONTRACT_ADDRESS';  // ← replace after deploy
const SEPOLIA_CHAIN_ID = 11155111;

const ABI = [
  'function owner() external view returns (address)',
  'function proposalCount() external view returns (uint256)',
  'function getProposalName(uint256) external view returns (string)',
  'function getTotalVoters(uint256) external view returns (uint256)',
  'function isVotingEnded(uint256) external view returns (bool)',
  'function isDecryptionPending(uint256) external view returns (bool)',
  'function areResultsRevealed(uint256) external view returns (bool)',
  'function getVotesForHandle(uint256) external view returns (bytes32)',
  'function getVotesAgainstHandle(uint256) external view returns (bytes32)',
  'function getRevealedVotesFor(uint256) external view returns (uint64)',
  'function getRevealedVotesAgainst(uint256) external view returns (uint64)',
  'function hasVoted(address, uint256) external view returns (bool)',
  'function castVote(uint256, bytes32, bytes) external',
  'function endVoting(uint256) external',
  'function revealResults(uint256) external',
  'function submitDecryptionResult(uint256, bytes32[], bytes, bytes) external',
  'function createProposal(string) external',
];

// ─── SDK (pre-built bundle — top-level await requires type="module") ──────────
const sdkUrl = new URL('./relayer-sdk/relayer-sdk-js.js', import.meta.url).href;
const sdk    = await import(sdkUrl);
const { createInstance, SepoliaConfig, initSDK } = sdk;
if (initSDK) await initSDK();

// ─── State ────────────────────────────────────────────────────────────────────
let account  = '';
let signer   = null;
let contract = null;
let isOwner  = false;
let fhevmInstance = null;

const roProvider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const roContract = new Contract(CONTRACT_ADDRESS, ABI, roProvider);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const setStatus = msg => { $('status').textContent = msg; };
const showOverlay = (title, msg) => {
  $('overlayTitle').textContent = title;
  $('overlayMsg').textContent   = msg;
  $('overlay').classList.add('show');
};
const hideOverlay = () => $('overlay').classList.remove('show');

async function getFhevmInstance() {
  if (fhevmInstance) return fhevmInstance;
  fhevmInstance = await createInstance({
    ...SepoliaConfig,
    network: 'https://ethereum-sepolia-rpc.publicnode.com',
  });
  return fhevmInstance;
}

function toHex(val) {
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  if (val instanceof Uint8Array || Array.isArray(val))
    return '0x' + Array.from(val).map(b => b.toString(16).padStart(2,'0')).join('');
  return String(val);
}

// ─── Connect Wallet ───────────────────────────────────────────────────────────
$('connectBtn').onclick = async () => {
  if (!window.ethereum) return setStatus('MetaMask not found. Install it first.');
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    await setupWallet(accounts[0]);
  } catch (e) { setStatus('Connect failed: ' + e.message); }
};

async function setupWallet(addr) {
  const provider = new BrowserProvider(window.ethereum);
  const network  = await provider.getNetwork();
  if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xaa36a7' }],
    });
  }
  signer   = await provider.getSigner();
  contract = new Contract(CONTRACT_ADDRESS, ABI, signer);
  account  = addr;
  const owner = await roContract.owner();
  isOwner  = addr.toLowerCase() === owner.toLowerCase();
  fhevmInstance = null;

  $('connectBtn').textContent = addr.slice(0,6) + '…' + addr.slice(-4);
  $('connectBtn').disabled = true;
  $('ownerPanel').style.display = isOwner ? 'block' : 'none';
  setStatus('Connected' + (isOwner ? ' (Owner)' : ''));
  await loadProposals();
}

// ─── Load Proposals ───────────────────────────────────────────────────────────
async function loadProposals() {
  setStatus('Loading proposals…');
  const count = Number(await roContract.proposalCount());
  const list  = await Promise.all(
    Array.from({ length: count }, (_, i) => loadOne(i))
  );
  renderProposals(list);
  setStatus(count ? `${count} proposal(s) loaded.` : 'No proposals yet.');
}

async function loadOne(id) {
  const [name, total, ended, revealed, voted] = await Promise.all([
    roContract.getProposalName(id),
    roContract.getTotalVoters(id),
    roContract.isVotingEnded(id),
    roContract.areResultsRevealed(id),
    account ? roContract.hasVoted(account, id) : Promise.resolve(false),
  ]);
  let vFor = null, vAgainst = null;
  if (revealed) {
    [vFor, vAgainst] = await Promise.all([
      roContract.getRevealedVotesFor(id),
      roContract.getRevealedVotesAgainst(id),
    ]);
  }
  return { id, name, total: Number(total), ended, revealed, voted, vFor, vAgainst };
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderProposals(list) {
  const el = $('proposals');
  el.innerHTML = list.length ? '' : '<p style="color:#666">No proposals yet.</p>';
  list.forEach(p => {
    const badge = p.revealed ? `<span class="badge badge-revealed">Revealed</span>`
                : p.ended    ? `<span class="badge badge-ended">Ended</span>`
                             : `<span class="badge badge-active">Active</span>`;

    let results = '';
    if (p.revealed && p.vFor !== null) {
      const t = Number(p.vFor) + Number(p.vAgainst) || 1;
      results = `
        <div style="margin-top:10px">
          <div>✅ For: ${p.vFor} (${Math.round(Number(p.vFor)/t*100)}%)</div>
          <div>❌ Against: ${p.vAgainst} (${Math.round(Number(p.vAgainst)/t*100)}%)</div>
        </div>`;
    }

    const voteRow = !p.ended && !p.voted && account ? `
      <div style="margin-top:10px">
        <button onclick="castVote(${p.id}, 1n)">👍 Vote For</button>
        <button onclick="castVote(${p.id}, 0n)">👎 Vote Against</button>
      </div>` : (p.voted ? '<div style="margin-top:8px;color:#6ee7b7">✓ You voted</div>' : '');

    const ownerRow = isOwner && !p.ended ? `<button onclick="endVoting(${p.id})" style="background:#b91c1c;margin-top:8px">⏹ End Voting</button>`
      : isOwner && p.ended && !p.revealed ? `<button onclick="revealResults(${p.id})" style="background:#5b21b6;margin-top:8px">🔓 Reveal Results</button>` : '';

    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${p.name}</strong>${badge}
      </div>
      <div style="color:#666;font-size:12px;margin-top:4px">${p.total} voter(s)</div>
      ${results}${voteRow}${ownerRow}`;
    el.appendChild(div);
  });
}

// ─── Cast Vote ────────────────────────────────────────────────────────────────
window.castVote = async (proposalId, voteValue) => {
  showOverlay('Encrypting Vote…', 'Creating FHE-encrypted ballot. Takes a few seconds.');
  try {
    const instance  = await getFhevmInstance();
    const encrypted = await instance
      .createEncryptedInput(ethers.getAddress(CONTRACT_ADDRESS), ethers.getAddress(account))
      .add64(voteValue)
      .encrypt();

    const handle     = toHex(encrypted.handles[0]);
    const inputProof = toHex(encrypted.inputProof);

    showOverlay('Sending Transaction…', 'FHE ops on Sepolia take 5–30 seconds.');
    const tx = await contract.castVote(proposalId, handle, inputProof, { gasLimit: 1_000_000n });
    await tx.wait();
    hideOverlay();
    setStatus('Vote cast! ✅');
    await loadProposals();
  } catch (e) {
    hideOverlay();
    setStatus('Vote failed: ' + (e.code === 'ACTION_REJECTED' ? 'Rejected.' : e.message?.slice(0,120)));
  }
};

// ─── End Voting ───────────────────────────────────────────────────────────────
window.endVoting = async (proposalId) => {
  showOverlay('Ending Voting…', 'Closing the proposal.');
  try {
    await (await contract.endVoting(proposalId, { gasLimit: 200_000n })).wait();
    hideOverlay(); setStatus('Voting ended.'); await loadProposals();
  } catch (e) { hideOverlay(); setStatus('Failed: ' + e.message?.slice(0,120)); }
};

// ─── Reveal Results (two-step public KMS decryption) ─────────────────────────
window.revealResults = async (proposalId) => {
  showOverlay('Step 1/3: Requesting Decryption…', 'Marking tallies for public KMS decryption.');
  try {
    await (await contract.revealResults(proposalId, { gasLimit: 1_000_000n })).wait();

    showOverlay('Step 2/3: Decrypting via KMS…', 'Fetching plaintext from FHE KMS. 10–30 seconds.');
    const [forHandle, againstHandle] = await Promise.all([
      roContract.getVotesForHandle(proposalId),
      roContract.getVotesAgainstHandle(proposalId),
    ]);
    const instance = await getFhevmInstance();
    const result   = await instance.publicDecrypt([forHandle, againstHandle]);

    showOverlay('Step 3/3: Submitting Proof…', 'Writing verified results on-chain.');
    await (await contract.submitDecryptionResult(
      proposalId,
      [forHandle, againstHandle],
      result.abiEncodedClearValues,
      result.decryptionProof,
      { gasLimit: 500_000n }
    )).wait();

    hideOverlay(); setStatus('Results revealed! ✅'); await loadProposals();
  } catch (e) { hideOverlay(); setStatus('Reveal failed: ' + e.message?.slice(0,160)); }
};

// ─── Create Proposal ──────────────────────────────────────────────────────────
$('createBtn').onclick = async () => {
  const name = $('proposalName').value.trim();
  if (!name) return setStatus('Enter a proposal name first.');
  showOverlay('Creating Proposal…', 'Sending transaction.');
  try {
    await (await contract.createProposal(name, { gasLimit: 300_000n })).wait();
    $('proposalName').value = '';
    hideOverlay(); setStatus(`Proposal "${name}" created!`); await loadProposals();
  } catch (e) { hideOverlay(); setStatus('Failed: ' + e.message?.slice(0,120)); }
};

// Auto-connect if already authorized
if (window.ethereum) {
  const accounts = await window.ethereum.request({ method: 'eth_accounts' });
  if (accounts.length) await setupWallet(accounts[0]);
}
</script>
</body>
</html>
```

### Key Points

- Script must be `type="module"` — required for top-level await (SDK bundle uses it)
- SDK loaded via `new URL('./relayer-sdk/relayer-sdk-js.js', import.meta.url).href` — resolves correctly on GitHub Pages subdirectories
- `window.castVote` / `window.revealResults` etc. are attached to `window` so inline `onclick` attributes can call them from module scope
- WASM files must be sed-patched for the repo subdirectory (see Section 16) — this is the most common failure point
- ethers loaded from CDN (`cdn.jsdelivr.net/npm/ethers@6.13.0`) — no npm needed

---

## 40. Frontend Template (React + Vite + ethers.js)

Use this as the base for all FHEVM dApp frontends. Built with React + Vite — the same stack as the official fhevm-react-template.

### Setup

```bash
npm create vite@latest frontend -- --template react
cd frontend
npm install ethers
npm install
```

### vite.config.js

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // required for GitHub Pages
})
```

### src/App.jsx — Complete FHEVM dApp Template

```jsx
import { useState, useEffect } from "react";
import { BrowserProvider, Contract, ethers } from "ethers";

const CONTRACT_ADDRESS = "0x..."; // your deployed contract
const BACKEND_URL      = "https://your-backend.onrender.com";
const CONTRACT_ABI = [
  "function createProposal(string calldata description) external",
  "function castVote(uint256 proposalId, bytes32 encryptedVote, bytes calldata inputProof) external",
  "function revealResults(uint256 proposalId) external",
  "function getProposal(uint256 id) external view returns (string, bool, uint256, uint256)",
  "function proposalCount() external view returns (uint256)",
  "function hasVoted(address, uint256) external view returns (bool)",
  "function owner() external view returns (address)",
];

export default function App() {
  const [provider, setProvider]   = useState(null);
  const [signer, setSigner]       = useState(null);
  const [contract, setContract]   = useState(null);
  const [account, setAccount]     = useState("");
  const [status, setStatus]       = useState("");
  const [loading, setLoading]     = useState(false);
  const [proposals, setProposals] = useState([]);
  const [isOwner, setIsOwner]     = useState(false);
  const [description, setDescription] = useState("");

  // Wake backend on load
  useEffect(() => {
    fetch(`${BACKEND_URL}/health`).catch(() => {});
  }, []);

  // ─── Connect Wallet ─────────────────────────────────────────
  async function connectWallet() {
    if (!window.ethereum) return setStatus("MetaMask not found");
    try {
      const _provider = new BrowserProvider(window.ethereum);
      await _provider.send("eth_requestAccounts", []);

      // Check network
      const network = await _provider.getNetwork();
      if (network.chainId !== 11155111n) {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0xaa36a7" }],
        });
      }

      const _signer   = await _provider.getSigner();
      const _contract = new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, _signer);
      const _account  = await _signer.getAddress();
      const _owner    = await _contract.owner();

      setProvider(_provider);
      setSigner(_signer);
      setContract(_contract);
      setAccount(_account);
      setIsOwner(_account.toLowerCase() === _owner.toLowerCase());
      setStatus("Connected: " + _account.slice(0, 6) + "..." + _account.slice(-4));

      await loadProposals(_contract);
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  // ─── Load Proposals ─────────────────────────────────────────
  async function loadProposals(_contract) {
    try {
      const count = await _contract.proposalCount();
      const list  = [];
      for (let i = 0; i < Number(count); i++) {
        const [desc, revealed, yesVotes, noVotes] = await _contract.getProposal(i);
        list.push({ id: i, desc, revealed, yesVotes: Number(yesVotes), noVotes: Number(noVotes) });
      }
      setProposals(list);
    } catch (e) {
      setStatus("Error loading proposals: " + e.message);
    }
  }

  // ─── Create Proposal ────────────────────────────────────────
  async function createProposal() {
    if (!contract || !description) return;
    setLoading(true);
    setStatus("Creating proposal...");
    try {
      const tx = await contract.createProposal(description, { gasLimit: 300_000n });
      await tx.wait();
      setDescription("");
      setStatus("Proposal created!");
      await loadProposals(contract);
    } catch (e) {
      setStatus("Error: " + e.message);
    }
    setLoading(false);
  }

  // ─── Cast Vote ───────────────────────────────────────────────
  async function castVote(proposalId, vote) {
    if (!contract || !account) return;
    setLoading(true);
    setStatus("Encrypting vote... (5-30 seconds)");
    try {
      // Encrypt vote via backend (1 = yes, 0 = no)
      const res = await fetch(`${BACKEND_URL}/encrypt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: vote ? "1" : "0",
          contractAddress: CONTRACT_ADDRESS,
          userAddress: account,
        }),
      });
      const { handle, inputProof, success, error } = await res.json();
      if (!success) throw new Error(error);

      setStatus("Sending encrypted vote...");
      const tx = await contract.castVote(proposalId, handle, inputProof, { gasLimit: 1_000_000n });
      setStatus("Vote sent! Waiting for confirmation...");
      await tx.wait();
      setStatus("Vote cast successfully!");
      await loadProposals(contract);
    } catch (e) {
      setStatus("Error: " + e.message);
    }
    setLoading(false);
  }

  // ─── Reveal Results ──────────────────────────────────────────
  async function revealResults(proposalId) {
    if (!contract) return;
    setLoading(true);
    setStatus("Revealing results...");
    try {
      const tx = await contract.revealResults(proposalId, { gasLimit: 1_000_000n });
      await tx.wait();
      setStatus("Results revealed!");
      await loadProposals(contract);
    } catch (e) {
      setStatus("Error: " + e.message);
    }
    setLoading(false);
  }

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", padding: 20, fontFamily: "monospace" }}>
      <h1>🔒 Confidential Voting</h1>
      <p>Powered by Zama FHEVM — votes are encrypted onchain</p>

      {!account ? (
        <button onClick={connectWallet}>Connect Wallet</button>
      ) : (
        <p>✅ {account.slice(0,6)}...{account.slice(-4)} {isOwner && "(Owner)"}</p>
      )}

      <div style={{ background: "#f0f0f0", padding: 10, margin: "10px 0", minHeight: 40 }}>
        {status || "Ready"}
      </div>

      {loading && <p>⏳ FHE operations take 5-30 seconds on Sepolia...</p>}

      {isOwner && (
        <div>
          <h3>Create Proposal</h3>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Proposal description"
            style={{ width: "70%", padding: 8 }}
          />
          <button onClick={createProposal} disabled={loading}>Create</button>
        </div>
      )}

      <h3>Proposals</h3>
      {proposals.length === 0 && <p>No proposals yet.</p>}
      {proposals.map(p => (
        <div key={p.id} style={{ border: "1px solid #ccc", padding: 10, margin: "10px 0" }}>
          <strong>#{p.id}: {p.desc}</strong>
          {p.revealed ? (
            <p>✅ Yes: {p.yesVotes} | ❌ No: {p.noVotes}</p>
          ) : (
            <p>🔒 Votes encrypted — results hidden</p>
          )}
          {account && !p.revealed && (
            <div>
              <button onClick={() => castVote(p.id, true)} disabled={loading}>Vote Yes</button>
              <button onClick={() => castVote(p.id, false)} disabled={loading}>Vote No</button>
            </div>
          )}
          {isOwner && !p.revealed && (
            <button onClick={() => revealResults(p.id)} disabled={loading}>Reveal Results</button>
          )}
        </div>
      ))}

      <button onClick={() => loadProposals(contract)} disabled={!contract}>Refresh</button>
    </div>
  );
}
```

### src/main.jsx

```jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

### index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confidential Voting — FHEVM</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

### Build and Deploy

```bash
cd frontend
npm run build
# dist/ folder is ready for GitHub Pages
```

### Key Points for AI Agents

- Always set `base: './'` in `vite.config.js` for GitHub Pages
- Always wake backend with `/health` before encrypt — Render cold start takes 30-60s
- Always set explicit `gasLimit` — never rely on estimation
- FHE transactions take 5-30 seconds — show loading state
- Check network is Sepolia (chainId 11155111) before any transaction
- `CONTRACT_ADDRESS` and `BACKEND_URL` must be updated after deployment

---

## 16. Frontend Deployment — GitHub Pages WASM Path Fix

### The Problem

`@zama-fhe/relayer-sdk` hardcodes WASM fetch paths as absolute URLs:

```js
"/tfhe_bg.wasm"
"/kms_lib_bg.wasm"
```

These resolve to the **origin root** (`https://user.github.io/tfhe_bg.wasm`).
GitHub Pages project sites live at a **subdirectory** (`https://user.github.io/repo/`).
The WASM files are in `dist/` which maps to `https://user.github.io/repo/tfhe_bg.wasm`.
Result: **404 → "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok"**

Patching `window.fetch` in the main thread does NOT fix this — WASM is loaded inside a Web Worker where the patch doesn't reach.

### The Fix — Edit the Pre-built Bundle

Do a targeted string replacement in the pre-built bundle before committing it:

```bash
# Replace with your actual repo/subdirectory name
sed -i 's|"/tfhe_bg.wasm"|"/your-repo-name/tfhe_bg.wasm"|g' frontend/public/relayer-sdk/relayer-sdk-js.js
sed -i 's|"/kms_lib_bg.wasm"|"/your-repo-name/kms_lib_bg.wasm"|g' frontend/public/relayer-sdk/relayer-sdk-js.js
```

Verify: `grep -c "your-repo-name" frontend/public/relayer-sdk/relayer-sdk-js.js` should return `2`.

For Vercel / Netlify / root-domain hosting, the paths are correct as-is — no fix needed.

### sdk-bundle.js — Always Required, Never Auto-generated

The `App.jsx` pattern `await import('./sdk-bundle.js')` requires this file to exist in `src/`. It is **never created automatically** by any package or build tool. Always create it manually:

```js
// frontend/src/sdk-bundle.js
const sdkUrl = new URL("../relayer-sdk/relayer-sdk-js.js", import.meta.url).href;
const mod = await import(sdkUrl);

export const createInstance = mod.createInstance;
export const SepoliaConfig  = mod.SepoliaConfig;
export const initSDK        = mod.initSDK;
```

Key points:
- Use `new URL("...", import.meta.url).href` for the SDK path — resolves correctly regardless of base URL or subdirectory
- Do NOT use absolute paths like `"/relayer-sdk/relayer-sdk-js.js"` — Rollup will fail to resolve them at build time
- Do NOT use `/* @vite-ignore */` with `vite-plugin-top-level-await` — the comment is stripped before Rollup sees it
- `import.meta.url` in the compiled `dist/assets/sdk-bundle-[hash].js` resolves relative to the actual deployed URL

### Vite Config Requirements

```js
export default defineConfig({
  base: './',          // required for GitHub Pages subdirectory
  build: {
    target: 'esnext', // required for top-level await in sdk-bundle.js
  },
});
```

### WASM Files Location

Place the pre-built bundle and WASM files in `public/`:

```
frontend/public/
  tfhe_bg.wasm          ← served at /repo/tfhe_bg.wasm (after bundle path fix)
  kms_lib_bg.wasm       ← served at /repo/kms_lib_bg.wasm (after bundle path fix)
  relayer-sdk/
    relayer-sdk-js.js   ← the pre-built SDK bundle
    workerHelpers.js    ← required for Web Worker WASM loading
```

Do NOT place WASM files in `src/` — Vite will try to process them. Keep them in `public/`.

### SDK Package Confusion

The SKILL.md table above says `@fhevm/sdk` is for React/browser. This is outdated for v1.0.0-alpha. In practice:

- `@fhevm/sdk@1.0.0-alpha.x` — exports are empty (`export {}`), API is `createFhevmClient` not `createInstance`
- `@zama-fhe/relayer-sdk` — has `"browser": "lib/web.js"` field, exports `createInstance` + `SepoliaConfig` + `initSDK`, works in browser via the pre-built bundle approach above

Use the **pre-built bundle** (`relayer-sdk-js.js`) for browser apps, not direct npm imports. Vite cannot reliably handle the WASM initialization when importing `@zama-fhe/relayer-sdk` directly as an npm dependency.

