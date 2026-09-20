// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title ERC2771ContextLite — ERC-2771 meta-tx support for UUPS proxies
 * @notice OZ's {ERC2771ContextUpgradeable} stores the trusted forwarder in an
 *         `immutable`, which is set by the *implementation* constructor — a
 *         value the proxy can never see or change. Sponsorship requires the
 *         forwarder to be known (and, for the mock/demo, settable) at proxy
 *         scope, so this variant keeps it in proxy STORAGE.
 *
 *         `_msgSender()` returns the trailing 20 bytes of calldata ONLY when the
 *         immediate caller is the trusted forwarder; otherwise the real
 *         `msg.sender`. This means existing direct (user-paid) calls keep
 *         working unchanged — no dual code path in the money contracts.
 *
 * @dev Storage-layout note: this introduces exactly one address slot. It is
 *      appended to `__gap` accounting in each consumer (see how Escrow and
 *      ArbiterRegistry reserve their gaps).
 */
abstract contract ERC2771ContextLite is Initializable, ContextUpgradeable {
    /// @notice The ERC-2771 forwarder whose calldata suffix is trusted.
    address private _trustedForwarder;

    /// @dev Emitted once when the trusted forwarder is set.
    event TrustedForwarderSet(address indexed forwarder);

    /**
     * @dev One-shot init. Only meaningful for upgradeable consumers; a
     *      non-upgradeable consumer can call it from its own initializer too.
     */
    function __ERC2771ContextLite_init(address trustedForwarder_) internal onlyInitializing {
        _setTrustedForwarder(trustedForwarder_);
    }

    /// @notice Set (or repoint) the trusted forwarder. Zero disables forwarding.
    function _setTrustedForwarder(address trustedForwarder_) internal {
        _trustedForwarder = trustedForwarder_;
        emit TrustedForwarderSet(trustedForwarder_);
    }

    /// @notice The address trusted to append the sender suffix to calldata.
    function trustedForwarder() public view virtual returns (address) {
        return _trustedForwarder;
    }

    /// @notice Whether `forwarder` is the trusted ERC-2771 forwarder.
    function isTrustedForwarder(address forwarder) public view virtual returns (bool) {
        return forwarder == _trustedForwarder;
    }

    /// @dev ERC-2771 sends 20 bytes appended to the calldata.
    function _contextSuffixLength() internal view virtual override returns (uint256) {
        return 20;
    }

    /// @dev Overrides ContextUpgradeable._msgSender with ERC-2771 resolution.
    function _msgSender() internal view virtual override returns (address) {
        uint256 calldataLength = msg.data.length;
        uint256 contextSuffixLength = _contextSuffixLength();
        if (calldataLength >= contextSuffixLength && isTrustedForwarder(msg.sender)) {
            unchecked {
                return address(bytes20(msg.data[calldataLength - contextSuffixLength:]));
            }
        }
        return super._msgSender();
    }

    /// @dev Strips the ERC-2771 suffix from the calldata view.
    function _msgData() internal view virtual override returns (bytes calldata) {
        uint256 calldataLength = msg.data.length;
        uint256 contextSuffixLength = _contextSuffixLength();
        if (calldataLength >= contextSuffixLength && isTrustedForwarder(msg.sender)) {
            unchecked {
                return msg.data[:calldataLength - contextSuffixLength];
            }
        }
        return super._msgData();
    }
}
