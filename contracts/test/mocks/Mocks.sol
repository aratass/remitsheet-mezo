// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Remitsheet} from "../../src/Remitsheet.sol";

/// @dev Minimal standard ERC-20 that returns true and reverts on insufficient balance or allowance.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Token that returns false instead of reverting when a transfer cannot be made.
contract FalseReturningToken is MockERC20 {
    constructor() MockERC20("False", "FALSE", 6) {}

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        return super.transferFrom(from, to, amount);
    }
}

/// @dev Token that always returns false, even when it moved nothing.
contract AlwaysFalseToken is MockERC20 {
    constructor() MockERC20("AlwaysFalse", "AF", 6) {}

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev USDT-style token whose transferFrom returns no data at all.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Token whose transferFrom returns a single byte: malformed, must be treated as failure.
contract ShortReturnToken {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(31, 1)
        }
    }
}

/// @dev Recipient that rejects native value, like a contract without a receive function or a
///      contract that refuses native BTC on Mezo.
contract RejectingRecipient {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Recipient that accepts native value and answers with a very large return payload.
contract ReturnBombRecipient {
    receive() external payable {
        assembly {
            return(0, 100000)
        }
    }
}

/// @dev Recipient that, while being paid, tries to re-enter Remitsheet to take more than its share.
contract ReentrantRecipient {
    Remitsheet public immutable target;
    address public immutable token;
    bool public attemptedNative;
    bool public attemptedToken;
    bool public nativeReentrySucceeded;
    bool public tokenReentrySucceeded;

    constructor(Remitsheet target_, address token_) {
        target = target_;
        token = token_;
    }

    receive() external payable {
        if (attemptedNative) return;
        attemptedNative = true;

        // 1. Try to pay itself the contract's in-flight balance without sending value.
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = address(this);
        amounts[0] = address(target).balance > 0 ? address(target).balance : 1;
        try target.payNative(to, amounts, bytes32("steal")) {
            nativeReentrySucceeded = true;
        } catch {}

        // 2. Try to spend the original payer's token allowance through the batch contract.
        if (token != address(0)) {
            attemptedToken = true;
            amounts[0] = 1;
            try target.payToken(token, to, amounts, bytes32("steal")) {
                tokenReentrySucceeded = true;
            } catch {}
        }
    }
}

/// @dev Token that re-enters Remitsheet during transferFrom, trying to pay itself with value it does not send.
contract ReentrantToken is MockERC20 {
    Remitsheet public immutable target;
    bool public reentrySucceeded;
    bool private entered;

    constructor(Remitsheet target_) MockERC20("Reenter", "RE", 6) {
        target = target_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!entered) {
            entered = true;
            address[] memory rs = new address[](1);
            uint256[] memory amts = new uint256[](1);
            rs[0] = address(this);
            amts[0] = 1;
            try target.payToken(address(this), rs, amts, bytes32("x")) {
                reentrySucceeded = true;
            } catch {}
        }
        return super.transferFrom(from, to, amount);
    }
}
