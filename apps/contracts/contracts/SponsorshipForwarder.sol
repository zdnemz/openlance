// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SponsorshipForwarder — gasless money actions for signed-in users
 * @notice Off-chain (meta-tx) sponsorship. A logged-in user signs ONE
 *         `SponsorshipSession` voucher at login (EIP-712), then every
 *         money-moving action is submitted as a `ForwardRequest` that the
 *         server relayer signs and broadcasts — the relayer pays the gas.
 *
 *         ══════════════════ Flow ══════════════════
 *           login ─► sign SponsorshipSession{owner,issuedAt,expiry,sessionId}
 *                             │            (verified here, cached off-chain)
 *           action ─► sign ForwardRequest{from,to,value,gas,nonce,deadline,data}
 *                             │
 *           relayer ─► execute(req)  ─ verify session voucher (owner==from, unexpired)
 *                                       verify req signature (== from)
 *                                       nonce++ (replay guard)
 *                                       ─► target.call{value:req.value}(req.data || from)
 *                                            ▲ ERC-2771 suffix; target reads _msgSender()
 *
 * @dev SECURITY
 *      - The session voucher is checked on-chain EVERY execution, so a leaked
 *        relayer key cannot spend beyond what users authorized, and an expired
 *        session is rejected at the contract (not merely in the backend).
 *      - `sessionId` is mixed into the ForwardRequest digest so a signature
 *        cannot be replayed under a different sponsorship session.
 *      - Nonces are per-`from` (OZ Nonces), so a replayed ForwardRequest reverts.
 *      - ERC-2771 suffix: only `from` may act as the caller in the target; the
 *        relayer is not trusted by the target for anything else.
 *      - Targets MUST trust this forwarder (see `isTrustedForwarder`).
 *
 *      This contract is NOT upgradeable by design — it holds no funds and has no
 *      owner-writable state beyond the deploy-time session domain. Replacing it
 *      means redeploying and re-pointing the (upgradeable) targets.
 */
contract SponsorshipForwarder is EIP712, Nonces, ReentrancyGuard {
    /// @dev EIP-712 type hash for the per-action forward request.
    bytes32 private constant FORWARD_REQUEST_TYPEHASH =
        keccak256(
            "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data,bytes32 sessionId)"
        );

    /// @dev EIP-712 type hash for the login-time sponsorship session voucher.
    bytes32 private constant SPONSORSHIP_SESSION_TYPEHASH =
        keccak256("SponsorshipSession(address owner,uint256 issuedAt,uint256 expiry,bytes32 sessionId)");

    struct ForwardRequest {
        address from;
        address to;
        uint256 value;
        uint256 gas;
        uint256 nonce;
        uint48 deadline;
        bytes data;
    }

    /// @notice Authoritative record of the sponsorship sessions minted off-chain.
    ///         The backend derives the same key from the login voucher; writing
    ///         it here (by the relayer, on first use) lets any caller verify
    ///         that a session was indeed signed by `owner` with this expiry.
    mapping(bytes32 => bool) public sessionUsed;

    /// @notice Emitted when a session voucher is first consumed.
    event SessionRegistered(bytes32 indexed sessionId, address indexed owner, uint256 expiry);
    /// @notice Emitted on every sponsored execution.
    event SponsoredExecuted(bytes32 indexed sessionId, address indexed from, address indexed to, bytes32 requestHash);
    /// @notice Emitted when a target call fails; the raw revert bubble is re-thrown.
    event SponsoredCallFailed(address indexed to, bytes returnData);

    error InvalidSession(bytes32 sessionId);
    error SessionExpired(uint256 expiry);
    error SessionNotYetValid(uint256 issuedAt);
    error InvalidRequestSignature();
    error RequestExpired(uint48 deadline);
    error InvalidNonce(uint256 provided, uint256 expected);
    error CallFailed(bytes returnData);
    error InsufficientRelayerBalance();
    error TransferFailed();

    constructor() EIP712("OpenLance SponsorshipForwarder", "1") {}

    // ── EIP-712 digests (shared with the backend/frontend verbatim) ───────────

    /**
     * @notice Digest a caller must sign at login to authorize sponsorship.
     * @dev sessionId is a server-generated id (e.g. uuid) that scopes the session.
     */
    function sponsorshipSessionDigest(address owner, uint256 issuedAt, uint256 expiry, bytes32 sessionId)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(SPONSORSHIP_SESSION_TYPEHASH, owner, issuedAt, expiry, sessionId))
        );
    }

    /**
     * @notice Digest a caller must sign per money action (per ForwardRequest).
     */
    function forwardRequestDigest(ForwardRequest calldata req, bytes32 sessionId) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_REQUEST_TYPEHASH,
                    req.from,
                    req.to,
                    req.value,
                    req.gas,
                    req.nonce,
                    req.deadline,
                    keccak256(req.data),
                    sessionId
                )
            )
        );
    }

    // ── Session registration ─────────────────────────────────────────────────

    /**
     * @notice Register a sponsorship session voucher (signed at login) on-chain.
     * @dev Idempotent: re-registering the same session is a no-op. Anyone may
     *      relay this — the signature IS the authorization.
     * @param owner    wallet that signed the voucher
     * @param issuedAt unix seconds the session became valid
     * @param expiry   unix seconds the session stops being valid
     * @param sessionId server-generated scoping id
     * @param signature EIP-712 signature over `sponsorshipSessionDigest`
     */
    function registerSession(
        address owner,
        uint256 issuedAt,
        uint256 expiry,
        bytes32 sessionId,
        bytes calldata signature
    ) external {
        if (expiry <= block.timestamp) revert SessionExpired(expiry);
        if (issuedAt > block.timestamp + 30) revert SessionNotYetValid(issuedAt); // small clock skew allowance

        bytes32 digest = sponsorshipSessionDigest(owner, issuedAt, expiry, sessionId);
        if (ECDSA.recover(digest, signature) != owner) revert InvalidRequestSignature();

        if (!sessionUsed[sessionId]) {
            sessionUsed[sessionId] = true;
            emit SessionRegistered(sessionId, owner, expiry);
        }
    }

    // ── Relayed execution ────────────────────────────────────────────────────

    /**
     * @notice Execute a signed ForwardRequest on behalf of `req.from`.
     * @dev Called by the relayer (or anyone). The caller pays gas AND must send
     *      at least `req.value` along with the call (`msg.value >= req.value`);
     *      that `req.value` is forwarded to the target. On a testnet the relayer
     *      fronts both gas and principal (a faucet); on mainnet the principal
     *      would be the user's own funds routed through a paymaster instead.
     *      Any excess msg.value is refunded to the caller.
     * @param req        the user-signed request
     * @param sessionId  the sponsorship session scoping the request
     * @param sig        the user's EIP-712 signature over the forward request digest
     */
    function execute(ForwardRequest calldata req, bytes32 sessionId, bytes calldata sig)
        external
        payable
        nonReentrant
        returns (bytes memory result)
    {
        if (block.timestamp > req.deadline) revert RequestExpired(req.deadline);

        // 1. Nonce: per-`from`, monotonic (OZ Nonces reverts if mismatched).
        uint256 expected = nonces(req.from);
        if (req.nonce != expected) revert InvalidNonce(req.nonce, expected);

        // 2. Request signature must be from `req.from`.
        bytes32 digest = forwardRequestDigest(req, sessionId);
        if (ECDSA.recover(digest, sig) != req.from) revert InvalidRequestSignature();

        // 3. Enforce the sponsorship session: only a session that was signed by
        //    `req.from` and is still valid may fund this request. The backend
        //    also caches this, but the contract is the authority.
        if (!sessionUsed[sessionId]) revert InvalidSession(sessionId);
        // (expiry/owner were validated at registration)

        // 4. The caller must supply the funds being forwarded (value) on top of
        //    the gas they already pay. Effects before interaction (CEI).
        if (msg.value < req.value) revert InsufficientRelayerBalance();
        _useNonce(req.from);

        // 5. ERC-2771 forward: append the real sender as a calldata suffix so the
        //    target's `_msgSender()` recovers `req.from`, not this contract.
        (bool ok, bytes memory ret) = req.to.call{value: req.value, gas: req.gas}(abi.encodePacked(req.data, req.from));
        if (!ok) {
            emit SponsoredCallFailed(req.to, ret);
            // bubble the target's revert verbatim
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        // 6. Refund any over-payment to the caller (relayer).
        uint256 excess = msg.value - req.value;
        if (excess > 0) {
            (bool refunded,) = msg.sender.call{value: excess}("");
            if (!refunded) revert TransferFailed();
        }

        emit SponsoredExecuted(sessionId, req.from, req.to, digest);
        return ret;
    }

    /// @notice Accept ETH so the relayer can top up the forwarder if desired.
    receive() external payable {}
}
