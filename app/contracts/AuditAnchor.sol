// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title Ledgerfield audit anchor
/// @notice Records Merkle roots of Ledgerfield's audit log with the time they
/// were recorded. Anyone may call anchor(); a root can be recorded once only,
/// so its timestamp can never be rewritten, and resubmitting a root can never
/// create a second record. There is no owner and nothing can be upgraded.
contract AuditAnchor {
    /// @notice Unix time a root was first recorded, or 0 if it never was.
    mapping(bytes32 => uint256) public anchoredAt;

    event Anchored(bytes32 indexed root, uint256 timestamp, address indexed submitter);

    error AlreadyAnchored(bytes32 root, uint256 anchoredAt);

    function anchor(bytes32 root) external {
        uint256 existing = anchoredAt[root];
        if (existing != 0) revert AlreadyAnchored(root, existing);
        anchoredAt[root] = block.timestamp;
        emit Anchored(root, block.timestamp, msg.sender);
    }
}
