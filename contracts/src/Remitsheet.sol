// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Remitsheet
/// @notice Pays many recipients in a single transaction, either in the chain's native currency
///         (BTC on Mezo) or in any ERC-20 token (MUSD, MEZO). Tokens that support EIP-2612
///         permit (MUSD and the MEZO token both do) can be paid with one signature and one
///         transaction, without a separate approval transaction.
///
///         - No owner, no admin functions, no fees, no upgrades.
///         - Holds no funds: native value is forwarded within the same call and tokens move
///           directly from the sender to each recipient with transferFrom.
///         - All-or-nothing: if any single transfer fails, the whole batch reverts.
///
/// @dev    Every batch emits one {Paid} event per recipient line followed by one {BatchPaid}
///         event, so a receipt can be rebuilt from the transaction logs alone.
contract Remitsheet {
    /// @notice One recipient line of a batch.
    /// @param ref    Batch reference chosen by the sender (for example a payroll run or invoice id).
    /// @param token  Token paid, or address(0) for the native currency (BTC on Mezo).
    /// @param to     Recipient.
    /// @param amount Amount in the asset's base units (18 decimals for BTC, MUSD and MEZO on Mezo).
    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);

    /// @notice Summary of a batch, emitted after all of its {Paid} lines.
    event BatchPaid(
        bytes32 indexed ref, address indexed sender, address indexed token, uint256 total, uint256 count
    );

    /// @notice The recipient list is empty.
    error EmptyBatch();
    /// @notice `to` and `amounts` have different lengths.
    error LengthMismatch(uint256 recipients, uint256 amounts);
    /// @notice Recipient at `index` is the zero address.
    error ZeroAddress(uint256 index);
    /// @notice Amount at `index` is zero.
    error ZeroAmount(uint256 index);
    /// @notice The sum of all amounts does not equal the native value sent.
    error ValueMismatch(uint256 total, uint256 value);
    /// @notice The transfer to the recipient at `index` failed (rejected, blocklisted,
    ///         insufficient balance or allowance, or a token that returned false).
    error TransferFailed(uint256 index, address to);
    /// @notice `token` is not a contract.
    error InvalidToken(address token);
    /// @notice After the permit call, this contract may still not spend `total` of the caller's
    ///         tokens: the signature was invalid, expired, for another amount, or already used.
    error PermitFailed(uint256 total, uint256 allowance);

    /// @notice Pays every recipient in the native currency. `msg.value` must equal the sum of `amounts`.
    /// @param to      Recipients.
    /// @param amounts Amounts in native base units (18 decimals for BTC on Mezo), same order as `to`.
    /// @param ref     Batch reference recorded in the events.
    function payNative(address[] calldata to, uint256[] calldata amounts, bytes32 ref) external payable {
        // First pass: validate every line and compute the total before any value moves,
        // so a wrong msg.value is reported as ValueMismatch rather than a failed transfer.
        (uint256 n, uint256 total) = _validate(to, amounts);
        if (total != msg.value) revert ValueMismatch(total, msg.value);

        // Second pass: transfer. All gas is forwarded so smart-contract wallets can receive,
        // and no return data is copied, so a recipient cannot grief the caller with a large return.
        for (uint256 i; i < n; ++i) {
            address recipient = to[i];
            uint256 amount = amounts[i];
            bool ok;
            assembly ("memory-safe") {
                ok := call(gas(), recipient, amount, 0, 0, 0, 0)
            }
            if (!ok) revert TransferFailed(i, recipient);
            emit Paid(ref, address(0), recipient, amount);
        }

        emit BatchPaid(ref, msg.sender, address(0), total, n);
    }

    /// @notice Pays every recipient in `token`, moving funds directly from the caller to each
    ///         recipient. The caller must first approve this contract for at least the total.
    /// @param token   ERC-20 token (for example MUSD or MEZO).
    /// @param to      Recipients.
    /// @param amounts Amounts in the token's base units, same order as `to`.
    /// @param ref     Batch reference recorded in the events.
    function payToken(address token, address[] calldata to, uint256[] calldata amounts, bytes32 ref) external {
        if (token.code.length == 0) revert InvalidToken(token);
        uint256 n = _checkLengths(to.length, amounts.length);

        uint256 total;
        for (uint256 i; i < n; ++i) {
            address recipient = to[i];
            uint256 amount = amounts[i];
            if (recipient == address(0)) revert ZeroAddress(i);
            if (amount == 0) revert ZeroAmount(i);
            total += amount;
            if (!_transferFrom(token, msg.sender, recipient, amount)) revert TransferFailed(i, recipient);
            emit Paid(ref, token, recipient, amount);
        }

        emit BatchPaid(ref, msg.sender, token, total, n);
    }

    /// @notice Same as {payToken}, but first sets this contract's allowance with an EIP-2612 permit
    ///         signed by the caller for exactly the batch total. One signature and one transaction,
    ///         and no allowance is left over afterwards.
    /// @dev    The permit call may fail because someone copied the signature from the mempool and
    ///         submitted it first. That is harmless: the allowance it set is what counts, so the
    ///         batch only reverts when the allowance is still below the total after the call.
    ///         Only the caller's own tokens can ever be moved: the permit owner is `msg.sender`.
    /// @param token    ERC-20 token with EIP-2612 permit (MUSD, MEZO).
    /// @param to       Recipients.
    /// @param amounts  Amounts in the token's base units, same order as `to`.
    /// @param ref      Batch reference recorded in the events.
    /// @param deadline Permit deadline (unix seconds).
    /// @param v        Signature recovery byte (27 or 28).
    /// @param r        Signature r.
    /// @param s        Signature s.
    function payTokenWithPermit(
        address token,
        address[] calldata to,
        uint256[] calldata amounts,
        bytes32 ref,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (token.code.length == 0) revert InvalidToken(token);
        (, uint256 total) = _validate(to, amounts);

        _permit(token, total, deadline, v, r, s);
        uint256 allowed = _allowance(token, msg.sender);
        if (allowed < total) revert PermitFailed(total, allowed);

        _transferAll(token, to, amounts, ref, total);
    }

    /// @dev Second pass of {payTokenWithPermit}: the lines were validated and the total computed.
    function _transferAll(
        address token,
        address[] calldata to,
        uint256[] calldata amounts,
        bytes32 ref,
        uint256 total
    ) private {
        uint256 n = to.length;
        for (uint256 i; i < n; ++i) {
            address recipient = to[i];
            uint256 amount = amounts[i];
            if (!_transferFrom(token, msg.sender, recipient, amount)) revert TransferFailed(i, recipient);
            emit Paid(ref, token, recipient, amount);
        }
        emit BatchPaid(ref, msg.sender, token, total, n);
    }

    function _checkLengths(uint256 recipients, uint256 amounts) private pure returns (uint256) {
        if (recipients != amounts) revert LengthMismatch(recipients, amounts);
        if (recipients == 0) revert EmptyBatch();
        return recipients;
    }

    /// @dev Checks lengths, rejects zero recipients and zero amounts, and returns the line count and
    ///      the total (checked arithmetic: an overflowing list reverts).
    function _validate(address[] calldata to, uint256[] calldata amounts)
        private
        pure
        returns (uint256 n, uint256 total)
    {
        n = _checkLengths(to.length, amounts.length);
        for (uint256 i; i < n; ++i) {
            if (to[i] == address(0)) revert ZeroAddress(i);
            uint256 amount = amounts[i];
            if (amount == 0) revert ZeroAmount(i);
            total += amount;
        }
    }

    /// @dev Calls `token.permit(msg.sender, this, value, deadline, v, r, s)` and ignores the outcome
    ///      (see {payTokenWithPermit}). Works for permit functions that return nothing (OpenZeppelin)
    ///      and for those that return a bool (Mezo's precompiled tokens). Return data is not copied.
    function _permit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0xd505accf)) // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
            mstore(add(p, 0x04), caller())
            mstore(add(p, 0x24), address())
            mstore(add(p, 0x44), value)
            mstore(add(p, 0x64), deadline)
            mstore(add(p, 0x84), and(v, 0xff))
            mstore(add(p, 0xa4), r)
            mstore(add(p, 0xc4), s)
            pop(call(gas(), token, 0, p, 0xe4, 0, 0))
        }
    }

    /// @dev Reads `token.allowance(owner, this)`. A token that reverts or answers with malformed data
    ///      counts as zero allowance.
    function _allowance(address token, address owner) private view returns (uint256 allowed) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0xdd62ed3e)) // allowance(address,address)
            mstore(add(p, 0x04), owner)
            mstore(add(p, 0x24), address())
            mstore(0x00, 0)
            let ok := staticcall(gas(), token, p, 0x44, 0x00, 0x20)
            if and(ok, gt(returndatasize(), 0x1f)) { allowed := mload(0x00) }
        }
    }

    /// @dev Calls `token.transferFrom(from, to, amount)` and reports success. Accepts tokens that
    ///      return `true` and tokens that return nothing (the token's code was checked to exist);
    ///      anything else, including a revert or a `false` return, counts as failure.
    ///      Uses memory past the free memory pointer as scratch without moving the pointer, so the
    ///      memory cost stays constant however long the batch is.
    function _transferFrom(address token, address from, address to, uint256 amount) private returns (bool ok) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, 0x23b872dd)) // transferFrom(address,address,uint256)
            mstore(add(p, 0x04), from)
            mstore(add(p, 0x24), to)
            mstore(add(p, 0x44), amount)
            mstore(0x00, 0)
            ok := call(gas(), token, 0, p, 0x64, 0x00, 0x20)
            if ok {
                switch returndatasize()
                case 0 { ok := 1 }
                default { ok := and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)) }
            }
        }
    }
}
