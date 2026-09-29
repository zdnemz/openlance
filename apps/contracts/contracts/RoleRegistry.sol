// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {ERC2771ContextLite} from "./ERC2771ContextLite.sol";
import {IRoleRegistry} from "./IRoleRegistry.sol";

/**
 * @title RoleRegistry — wallet-owned seat on-chain
 * @notice The authoritative home of "which seat does this wallet hold". The
 *         off-chain `users.role` column is a MIRROR of this contract, rebuilt
 *         from these events; it is never the source of truth.
 *
 *         ══════════════════════ Model ══════════════════════
 *           - claim(role)          → free, ONCE per wallet. The free write.
 *           - switchRole(role)     → {value >= roleChangeFee}, forever after.
 *           - The fee is the whole anti-griefing mechanism. There is no
 *             cooldown, deliberately: one price, one mechanism.
 *
 *         ══════════════════════ The arbiter exit gate ══════════════════════
 *           An account leaving `Role.Arbiter` must have no stake left, read from
 *           ArbiterRegistry.stakeOf. Otherwise a wallet could take the arbiter
 *           seat, skip the roster's selection exposure, and walk away with the
 *           collateral still committed. Becoming an arbiter is NOT gated here —
 *           that is `registerArbiter` + `minStake`, in the other contract, and
 *           the two cannot be made atomic. `Role.Arbiter` with no standing is
 *           therefore reachable and harmless: `ArbiterRegistry.isEligible`
 *           still requires stake >= minStake.
 *
 * @dev UPGRADEABLE (UUPS), owner = TimelockController in production.
 *
 *      SECURITY:
 *       - Fee escrow: the contract holds real ETH, so `receive()` is closed and
 *         ETH only ever enters through `switchRole`, which forwards it to the
 *         treasury in the same call (CEI — no state read after the transfer).
 *       - `arbiterRegistry` is ONE-SHOT, so the stake gate can never be
 *         repointed at a contract that reports a zero stake.
 *       - The stake read is a `staticcall` and it FAILS CLOSED. This is the
 *         opposite of ArbiterRegistry._isBusy (which fails open so a missing
 *         escrow cannot brick unstaking). The asymmetry is deliberate: a broken
 *         read here means an arbiter could abandon staked collateral, so the
 *         cost of a wrong answer is a stuck role switch, which is recoverable.
 */
contract RoleRegistry is IRoleRegistry, OwnableUpgradeable, UUPSUpgradeable, ERC2771ContextLite {
    // ── Indexer-facing events ──────────────────────────────────────────────
    event RoleClaimed(address indexed account, Role role);
    event RoleSwitched(address indexed account, Role fromRole, Role toRole, uint256 fee);
    event RoleChangeFeeUpdated(uint256 fee);
    event TreasuryUpdated(address indexed treasury);
    event ArbiterRegistrySet(address indexed arbiterRegistry);
    event FeesWithdrawn(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────────
    error ZeroAddress();
    /// @notice The one free write was already consumed.
    error AlreadyClaimed(address account);
    /// @notice `claim`/`switchRole` called with `Role.None`.
    error InvalidRole();
    /// @notice `switchRole` before `claim`.
    error NotClaimed(address account);
    /// @notice `switchRole` to the seat the account already holds.
    error SameRole(Role role);
    error FeeBelowRequired(uint256 provided, uint256 required);
    /// @notice Exit blocked: the account is leaving the arbiter seat with stake.
    error ArbiterHasStake(address account, uint256 stake);
    /// @notice The arbiter-stake read is unset, or the registry did not answer.
    error StakeReadUnavailable(address arbiterRegistry);
    error ArbiterRegistryAlreadySet(address current);
    /// @notice The recipient rejected the ETH.
    error TransferFailed();
    /// @notice Direct ETH transfer; fees only enter via `switchRole`.
    error DirectTransferNotAllowed();

    /// @notice The ArbiterRegistry consulted for the exit gate. Set once.
    address public arbiterRegistry;
    /// @notice Receives role-change fees.
    address public treasury;
    /// @notice Wei required by `switchRole`.
    uint256 public roleChangeFee;
    /// @notice Lifetime fees collected, in wei (cumulative; not a balance).
    uint256 public totalFees;

    /// @dev account => seat. `Role.None` means "never claimed".
    mapping(address => Role) private _role;
    /// @dev account => claim timestamp; 0 = never claimed.
    mapping(address => uint256) public claimedAt;

    /// @dev Reserved storage for future upgrades. Shrink only by the number of
    ///      slots added above it.
    uint256[40] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the proxy atomically.
     * @param owner_            upgrade/admin authority (TimelockController in prod)
     * @param roleChangeFee_    wei charged by `switchRole`; 0 disables the price
     * @param treasury_         receives fees (defaults to owner if zero)
     * @param arbiterRegistry_  ArbiterRegistry used by the exit gate (0 = unset,
     *                          which makes the gate revert until set)
     * @param trustedForwarder_ ERC-2771 forwarder (0 disables meta-tx)
     */
    function initialize(
        address owner_,
        uint256 roleChangeFee_,
        address treasury_,
        address arbiterRegistry_,
        address trustedForwarder_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __ERC2771ContextLite_init(trustedForwarder_);
        roleChangeFee = roleChangeFee_;
        treasury = treasury_ == address(0) ? owner_ : treasury_;
        arbiterRegistry = arbiterRegistry_;
        emit RoleChangeFeeUpdated(roleChangeFee_);
        emit TreasuryUpdated(treasury);
        emit ArbiterRegistrySet(arbiterRegistry_);
    }

    // ── The free write ─────────────────────────────────────────────────────

    /**
     * @notice Claim a seat. Free, and available exactly once per wallet.
     * @dev Does not require a claim to be `Role.Client` — the seat chosen here
     *      is whatever the wallet wants, and switching later costs the fee.
     */
    function claim(Role role) external {
        address account = _msgSender();
        if (role == Role.None) revert InvalidRole();
        if (claimedAt[account] != 0) revert AlreadyClaimed(account);
        _role[account] = role;
        claimedAt[account] = block.timestamp;
        emit RoleClaimed(account, role);
    }

    // ── The paid write ─────────────────────────────────────────────────────

    /**
     * @notice Move to a different seat, paying `roleChangeFee`.
     * @dev The whole `msg.value` is forwarded to the treasury, so an overpayment
     *      is not refunded — that keeps the fee path free of a second transfer
     *      and therefore free of a reentrancy surface.
     */
    function switchRole(Role newRole) external payable {
        address account = _msgSender();
        if (newRole == Role.None) revert InvalidRole();
        if (claimedAt[account] == 0) revert NotClaimed(account);
        Role current = _role[account];
        if (current == newRole) revert SameRole(current);
        if (msg.value < roleChangeFee) revert FeeBelowRequired(msg.value, roleChangeFee);
        // Leaving the arbiter seat with collateral still committed would let a
        // wallet take the seat, dodge selection, and keep the stake.
        if (current == Role.Arbiter) {
            uint256 staked = _stakeOf(account);
            if (staked > 0) revert ArbiterHasStake(account, staked);
        }

        _role[account] = newRole;
        uint256 paid = msg.value;
        totalFees += paid;
        emit RoleSwitched(account, current, newRole, paid);
        if (paid > 0) _pay(treasury, paid); // always last (CEI)
    }

    // ── Views ──────────────────────────────────────────────────────────────

    /// @inheritdoc IRoleRegistry
    function roleOf(address account) external view returns (Role) {
        return _role[account];
    }

    /// @inheritdoc IRoleRegistry
    function isClaimed(address account) external view returns (bool) {
        return claimedAt[account] != 0;
    }

    // ── Owner — timelocked in production ──────────────────────────────────

    function setRoleChangeFee(uint256 fee) external onlyOwner {
        roleChangeFee = fee;
        emit RoleChangeFeeUpdated(fee);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Point the exit gate at the ArbiterRegistry. ONE-SHOT.
    function setArbiterRegistry(address arbiterRegistry_) external onlyOwner {
        if (arbiterRegistry_ == address(0)) revert ZeroAddress();
        if (arbiterRegistry != address(0)) revert ArbiterRegistryAlreadySet(arbiterRegistry);
        arbiterRegistry = arbiterRegistry_;
        emit ArbiterRegistrySet(arbiterRegistry_);
    }

    /// @notice Sweep collected fees. `to` must be payable.
    function withdrawFees(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        emit FeesWithdrawn(to, amount);
        if (amount > 0) _pay(to, amount);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * @dev The arbiter's collateral, read from ArbiterRegistry. Fails CLOSED:
     *      an unset or non-answering registry reverts rather than reporting a
     *      zero stake, so a broken dependency can never wave an arbiter out of
     *      the seat while their collateral is still committed. The caller turns
     *      this revert into `StakeReadUnavailable`.
     */
    function _stakeOf(address account) private view returns (uint256) {
        address registry = arbiterRegistry;
        if (registry == address(0)) revert StakeReadUnavailable(address(0));
        (bool ok, bytes memory data) =
            registry.staticcall(abi.encodeWithSelector(bytes4(keccak256("stakeOf(address)")), account));
        if (!ok || data.length < 32) revert StakeReadUnavailable(registry);
        return abi.decode(data, (uint256));
    }

    /// @dev Push payment — always the last effect (CEI).
    function _pay(address to, uint256 amount) private {
        (bool success,) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /// @dev Closed: fees only enter through `switchRole`.
    receive() external payable {
        revert DirectTransferNotAllowed();
    }

    /// @dev Resolves the ERC-2771 diamond: ERC2771ContextLite's views win.
    function _msgSender() internal view override(ERC2771ContextLite, ContextUpgradeable) returns (address) {
        return super._msgSender();
    }

    function _msgData() internal view override(ERC2771ContextLite, ContextUpgradeable) returns (bytes calldata) {
        return super._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(ERC2771ContextLite, ContextUpgradeable)
        returns (uint256)
    {
        return super._contextSuffixLength();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
