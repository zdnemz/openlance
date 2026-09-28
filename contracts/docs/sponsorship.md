# SponsorshipForwarder — gasless money actions (ERC-2771)

Source: `contracts/SponsorshipForwarder.sol` + `contracts/ERC2771ContextLite.sol`.

A signed-in user signs **one** `SponsorshipSession` voucher at login. Every money-moving
action is then a `ForwardRequest` the server relayer broadcasts, so the relayer pays the
gas. Verified by `test/sponsorship.ts` and `test/eip712-agreement.ts`.

Not upgradeable by design: it holds no funds and has no owner-writable state. Replacing
it means redeploying and repointing the (upgradeable) targets via `setTrustedForwarder`.

---

## Flow

```
1. LOGIN    user signs  SponsorshipSession{owner, issuedAt, expiry, sessionId}
              └─ anyone (usually the relayer) calls registerSession(...)   ← on-chain record

2. ACTION   user signs  ForwardRequest{from, to, value, gas, nonce, deadline, data}
              └─ relayer calls execute(req, sessionId, sig) with msg.value >= req.value
                   └─ target.call{value, gas}(data ‖ from)     ← 20-byte ERC-2771 suffix
                        └─ target's _msgSender() resolves to `from`, not the relayer
```

Three independent on-chain checks run on **every** execution, so a leaked relayer key can
only relay calls users already signed:

1. `req.nonce == nonces(req.from)` — per-`from`, monotonic; replay reverts `InvalidNonce`.
2. `ECDSA.recover(forwardRequestDigest(req, sessionId), sig) == req.from`.
3. `sessionUsed[sessionId]` — the voucher was registered.

---

## EIP-712 domain

```json
{ "name": "OpenLance SponsorshipForwarder", "version": "1", "chainId": <chainId>, "verifyingContract": <forwarder> }
```

## EIP-712 types

```json
SponsorshipSession(address owner, uint256 issuedAt, uint256 expiry, bytes32 sessionId)
```

```json
ForwardRequest(address from, address to, uint256 value, uint256 gas, uint256 nonce, uint48 deadline, bytes data, bytes32 sessionId)
```

Note `sessionId` is a **field of `ForwardRequest`**, so a request signature cannot be
replayed under a different sponsorship session. `deadline` is `uint48` in the struct.

Prefer calling `sponsorshipSessionDigest(...)` and `forwardRequestDigest(req, sessionId)`
on-chain over recomputing — `test/eip712-agreement.ts` pins the client digest to the
contract digest for both payloads.

`sessionId` is server-generated (the tests use `keccak256(toHex("some-id"))`); any
`bytes32` works.

---

## Functions

### `registerSession(address owner, uint256 issuedAt, uint256 expiry, bytes32 sessionId, bytes signature)`

Permissionless — **anyone** may relay it, because the signature *is* the authorization.
Idempotent: re-registering the same id is a no-op and emits nothing.

Reverts:

| Error | Condition |
|---|---|
| `SessionExpired(expiry)` | `expiry <= block.timestamp` |
| `SessionNotYetValid(issuedAt)` | `issuedAt > block.timestamp + 30` (30s clock-skew allowance) |
| `InvalidRequestSignature()` | the voucher was not signed by `owner` |

### `execute(ForwardRequest req, bytes32 sessionId, bytes sig) → bytes`

Callable by anyone (in practice the relayer). **Non-reentrant.**

Execution order, which determines the error you will see:

1. `RequestExpired(deadline)` — `block.timestamp > req.deadline`
2. `InvalidNonce(provided, expected)` — nonce must equal `nonces(req.from)`
3. `InvalidRequestSignature()` — the request must be signed by `req.from`
4. `InvalidSession(sessionId)` — the session must be registered
5. `InsufficientRelayerBalance()` — `msg.value < req.value`
6. `_useNonce(req.from)` — nonce consumed **before** the call (CEI)
7. `req.to.call{value: req.value, gas: req.gas}(abi.encodePacked(req.data, req.from))`
8. excess `msg.value` refunded to the caller

**The relayer must fund `req.value`, not just the gas.** The caller supplies
`msg.value >= req.value` and only the excess is refunded. On testnet the relayer fronts
both gas and principal; on mainnet the principal would come from the user through a
paymaster instead. A `value: 0` request (e.g. `submit`, `commitVote`, `revealVote`) needs
`msg.value: 0` and is fully gasless.

On a target revert the contract emits `SponsoredCallFailed(to, returnData)` and
re-bubbles the target's revert data **verbatim** — so custom errors from the Escrow
propagate intact through the relayer. Decode the revert against the target's ABI, not
this one.

Emits `SponsoredExecuted(sessionId, from, to, requestHash)` on success. It returns the
raw target `returnData`.

`req.gas` is enforced as an explicit gas stipend. Set it generously (the tests use
`1_000_000n`) — it is a cap, so too low a value causes an out-of-gas failure inside the
target.

### `nonces(address)`

Standard OZ `Nonces` — use it to read the next expected nonce when building a request.
Start at 0.

---

## How targets resolve the sender

`ERC2771ContextLite` is a storage-based replacement for OZ's
`ERC2771ContextUpgradeable`, which keeps the forwarder in an `immutable` set by the
*implementation* constructor — a value a proxy can never see or change. Sponsorship
needs the forwarder known at proxy scope, so this variant stores it (one address slot,
absorbed into each consumer's `__gap` accounting).

`_msgSender()` returns the trailing 20 bytes of calldata **only when the immediate caller
is the trusted forwarder**; otherwise the real `msg.sender`. So:

- a sponsored call records `client == user`, never the relayer;
- direct user-paid calls are unchanged — there is no dual code path in the money
  contracts, and with the forwarder unset (or `address(0)`) everything is plain
  `msg.sender`.

`Escrow` and `ArbiterRegistry` both inherit it and read the real caller through
`_msgSender()`. That means **every** permissioned function in both contracts works
through sponsorship without modification:

| Contract | Sponsorship-friendly calls |
|---|---|
| `Escrow` | `fund`, `lockBudget`, `fundFromCredit`, `fundAllFromCredit`, `unlockBudget`, `submit`, `approve`, `withdrawMilestone`, `cancel`, `openDispute`, `openDisputeWith`, `commitVote`, `revealVote`, `resolveDispute`, `resolveAppeal`, `appeal`, `finalizeDispute` |
| `ArbiterRegistry` | `registerArbiter`, `addStake`, `reduceStake`, `requestUnstake`, `cancelUnstake`, `withdrawStake` |

`withdrawFees`, `sweepRewardPool`, all `set*` admin calls and `upgradeToAndCall` are
`onlyOwner` and route through the timelock — they are not user paths and should not be
sponsored.

Verify the wiring with `isTrustedForwarder(forwarderAddress)` on the target.

---

## Events

| Event | Fields |
|---|---|
| `SessionRegistered(bytes32 indexed sessionId, address indexed owner, uint256 expiry)` | first consumption of a voucher |
| `SponsoredExecuted(bytes32 indexed sessionId, address indexed from, address indexed to, bytes32 requestHash)` | successful relay; `requestHash` is the EIP-712 digest |
| `SponsoredCallFailed(address indexed to, bytes returnData)` | target reverted (the tx reverts too) |

`TrustedForwarderSet(forwarder)` is emitted on both targets, not on this contract.

---

## Error decode

| Error | Meaning / fix |
|---|---|
| `InvalidSession(sessionId)` | the voucher was never registered on-chain |
| `SessionExpired(expiry)` / `SessionNotYetValid(issuedAt)` | rejected at `registerSession` |
| `InvalidRequestSignature()` | wrong signer — the most common integration failure |
| `RequestExpired(deadline)` | `deadline` is `uint48` unix seconds; re-sign |
| `InvalidNonce(provided, expected)` | stale or replayed nonce; read `nonces(from)` |
| `InsufficientRelayerBalance()` | `msg.value < req.value` — the relayer must fund the principal |
| `CallFailed(returnData)` | declared, not used — the target's revert is bubbled verbatim instead |
| `TransferFailed()` | the relayer's excess refund failed |

---

## Known behaviour

**1. Session expiry is only enforced at registration.** `execute` checks
`sessionUsed[sessionId]` and nothing else — the contract says so at
`SponsorshipForwarder.sol:190`: *"expiry/owner were validated at registration"*. A voucher
registered just before it expires stays valid for relayed requests until the nonce
sequence is exhausted. If you need a hard session cutoff, set a short `req.deadline` on each request
and reject expired sessions in the backend.

**2. `SessionNotYetValid` allows 30s of clock skew** and nothing more. A client whose
clock is behind by more than 30s cannot register.

**3. The forwarder holds no funds and cannot be paused.** There is no owner, no pause, no
denylist. Revoking access means repointing the targets' `trustedForwarder` (timelocked)
or rotating the user nonces off-chain — treat a leaked relayer key as "can relay
already-signed requests only", which the on-chain checks do enforce.
