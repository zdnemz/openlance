// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IArbiterRegistry} from "./IArbiterRegistry.sol";

/**
 * @title ArbiterRegistry — soulbound arbiter identity + on-chain trust (PRD F11/F12)
 * @notice Registered arbiters hold an ERC-5194 soulbound badge. Trust score is a
 *         pure function of resolution history, maintained here and mirrored
 *         off-chain by the indexer (never hand-edited):
 *
 *           +1  per resolution delivered within the 72h SLA
 *           −2  per resolution delivered late (floored at zero)
 *           removed from the roster when the escrow slashes a stale assignment
 *
 *         The SBT is permanent history: deregistration does not burn the badge,
 *         and re-registration mints a fresh one.
 *
 * @dev Event payloads below are byte-for-byte the surface the backend indexer
 *      expects (mini-services/api/src/chain/abi.ts). test/EventSurface.t.sol
 *      locks the topic hashes so the two sides can never silently drift apart.
 */
contract ArbiterRegistry is IArbiterRegistry, ERC721, Ownable {
    // ── Indexer-facing events (names/args match src/chain/abi.ts exactly) ────
    event ArbiterRegistered(address indexed arbiter, uint256 sbtTokenId);
    event ArbiterDeregistered(address indexed arbiter);
    event TrustScoreUpdated(address indexed arbiter, int256 delta, uint256 newScore, bool withinSla);

    // ── Admin/ops events (not consumed by the indexer) ────────────────────────
    event EscrowSet(address indexed escrow);

    // ── ERC-5194: Minimal Soulbound NFTs ──────────────────────────────────────
    event Locked(uint256 indexed tokenId);
    event Unlocked(uint256 indexed tokenId); // never emitted: badges are born locked, forever

    struct ArbiterInfo {
        bool registered;
        uint256 tokenId; // latest SBT (re-registration mints a fresh one)
        uint256 trustScore;
        uint256 resolutions;
    }

    error NotEscrow();
    error NotAuthorized();
    error ZeroAddress();
    error AlreadyRegistered(address arbiter);
    error NotRegistered(address arbiter);
    error EscrowAlreadySet(address current);
    error NonTransferable(uint256 tokenId);

    /// @notice The escrow contract allowed to recordResolution/slash. Set once.
    address public escrow;
    uint256 public nextTokenId = 1;
    mapping(address => ArbiterInfo) public arbiters;

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(string memory name_, string memory symbol_, address owner_)
        ERC721(name_, symbol_)
        Ownable(owner_)
    {}

    // ── Wiring ────────────────────────────────────────────────────────────────
    // Deploy order: registry → escrow(registry) → registry.setEscrow(escrow).

    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet(escrow);
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    // ── Registry lifecycle ────────────────────────────────────────────────────

    /**
     * @notice Platform vets and registers an arbiter; mints their locked badge.
     * @return tokenId The minted SBT id (sequential from 1, matching the mock).
     */
    function register(address arbiter) external onlyOwner returns (uint256 tokenId) {
        if (arbiter == address(0)) revert ZeroAddress();
        ArbiterInfo storage info = arbiters[arbiter];
        if (info.registered) revert AlreadyRegistered(arbiter);

        tokenId = nextTokenId++;
        info.registered = true;
        info.tokenId = tokenId;
        _mint(arbiter, tokenId);
        emit ArbiterRegistered(arbiter, tokenId);
    }

    /**
     * @notice Remove an arbiter from the roster — voluntary exit (`msg.sender ==
     *         arbiter`), platform removal (owner), or escrow-driven. The badge
     *         is never burned: it is history.
     */
    function deregister(address arbiter) external {
        if (msg.sender != arbiter && msg.sender != owner() && msg.sender != escrow) {
            revert NotAuthorized();
        }
        _deregister(arbiter);
    }

    // ── Escrow-only levers ────────────────────────────────────────────────────

    /**
     * @notice Called by the escrow after every dispute resolution it executed.
     *         Score: +1 within SLA, −2 late, floored at zero.
     */
    function recordResolution(address arbiter, bool withinSla) external onlyEscrow {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.registered) revert NotRegistered(arbiter);

        info.resolutions += 1;
        int256 delta = withinSla ? int256(1) : int256(-2);
        if (delta > 0) {
            info.trustScore += uint256(delta);
        } else if (info.trustScore >= uint256(-delta)) {
            // casting to 'uint256' is safe: delta is only ever -2 here
            // forge-lint: disable-next-line(unsafe-typecast)
            info.trustScore -= uint256(-delta);
        } else {
            info.trustScore = 0; // floor at zero — same semantics as the backend mock
        }
        emit TrustScoreUpdated(arbiter, delta, info.trustScore, withinSla);
    }

    /**
     * @notice Called by the escrow when an arbiter failed to resolve within the
     *         SLA + grace period. Deregisters them (ArbiterDeregistered) so the
     *         dispute can be reassigned.
     */
    function slash(address arbiter) external onlyEscrow {
        _deregister(arbiter);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isRegistered(address arbiter) external view returns (bool) {
        return arbiters[arbiter].registered;
    }

    function trustScoreOf(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].trustScore;
    }

    function resolutionsOf(address arbiter) external view returns (uint256) {
        return arbiters[arbiter].resolutions;
    }

    /// @notice ERC-5194 — badges are locked from the moment they are minted.
    function locked(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    function _deregister(address arbiter) private {
        ArbiterInfo storage info = arbiters[arbiter];
        if (!info.registered) revert NotRegistered(arbiter);
        info.registered = false;
        emit ArbiterDeregistered(arbiter);
    }

    /**
     * @dev ERC-5194 enforcement point: minting is the only legal mutation.
     *      Every transfer AND every burn reverts NonTransferable.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) revert NonTransferable(tokenId);
        address result = super._update(to, tokenId, auth);
        emit Locked(tokenId);
        return result;
    }
}
