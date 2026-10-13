// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @dev Test stand-in for Mezo USD. MUSD (mezo-org/musd, contracts/token/MUSD.sol) is an
///      OpenZeppelin ERC20Permit named "Mezo USD" with symbol MUSD, 18 decimals and permit domain
///      version "1", and it refuses transfers to the zero address and to the token contract itself.
///      This contract has the same name, symbol, decimals, permit implementation and transfer rules;
///      only minting is open, because it is a test token.
contract TestMUSD is ERC20Permit {
    constructor() ERC20("Mezo USD", "MUSD") ERC20Permit("Mezo USD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(to != address(this), "ERC20: transfer to the contract address");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        require(to != address(this), "ERC20: transfer to the contract address");
        return super.transferFrom(from, to, amount);
    }
}

/// @dev Test stand-in for Mezo's precompiled MEZO token (mezo-org/mezod, precompile/erc20). The
///      precompile implements EIP-2612 with the domain name "MEZO" and version "1", but its permit
///      returns a bool, accepts only v = 27 or 28 and rejects high-s signatures, and the token has no
///      eip712Domain() function. This contract behaves the same way for those calls.
contract TestMEZO is ERC20, EIP712, Nonces {
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    constructor() ERC20("MEZO", "MEZO") EIP712("MEZO", "1") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function nonces(address owner) public view override returns (uint256) {
        return super.nonces(owner);
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (bool)
    {
        require(deadline >= block.timestamp, "permit expired");
        require(v == 27 || v == 28, "invalid v value");
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline)));
        require(ECDSA.recover(digest, v, r, s) == owner, "verification failed over the signed message");
        _approve(owner, spender, value);
        return true;
    }

    /// @dev The precompile has no eip712Domain(); hide the one inherited from EIP712.
    function eip712Domain()
        public
        pure
        override
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        revert("method not found");
    }
}
