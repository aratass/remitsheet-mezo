// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {Remitsheet} from "../src/Remitsheet.sol";
import {
    MockERC20,
    FalseReturningToken,
    AlwaysFalseToken,
    NoReturnToken,
    ShortReturnToken,
    RejectingRecipient,
    ReturnBombRecipient,
    ReentrantRecipient,
    ReentrantToken
} from "./mocks/Mocks.sol";

/// @dev Recipient that forwards whatever it receives to `next` through Remitsheet (legitimate nesting).
contract ForwardingRecipient {
    Remitsheet public immutable target;
    address public immutable next;

    constructor(Remitsheet target_, address next_) {
        target = target_;
        next = next_;
    }

    receive() external payable {
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        to[0] = next;
        amounts[0] = msg.value;
        target.payNative{value: msg.value}(to, amounts, bytes32("forward"));
    }
}

contract RemitsheetTest is Test {
    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event BatchPaid(
        bytes32 indexed ref, address indexed sender, address indexed token, uint256 total, uint256 count
    );

    /// @dev Block gas limit on Mezo testnet and mainnet: one batch must fit in a single block.
    uint256 internal constant TX_GAS_CAP = 10_000_000;
    bytes32 internal constant REF = bytes32("Payroll 2026-10");

    Remitsheet internal rs;
    MockERC20 internal musd;
    address internal payer = makeAddr("payer");

    function setUp() public {
        rs = new Remitsheet();
        musd = new MockERC20("Mezo USD (mock)", "MUSD", 18);
        vm.deal(payer, 1e30); // enough for any fuzzed batch (60 lines of up to 1e24)
        musd.mint(payer, 1e30);
        vm.prank(payer);
        musd.approve(address(rs), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _addr(uint256 seed, uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("recipient", seed, i)))));
    }

    function _batch(uint256 n, uint256 seed, uint256 unit)
        internal
        pure
        returns (address[] memory to, uint256[] memory amounts, uint256 total)
    {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = _addr(seed, i);
            amounts[i] = (i + 1) * unit;
            total += amounts[i];
        }
    }

    function _one(address a, uint256 amount) internal pure returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](1);
        amounts = new uint256[](1);
        to[0] = a;
        amounts[0] = amount;
    }

    // ---------------------------------------------------------------- native: happy path

    function test_payNative_paysEveryRecipient() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(5, 1, 0.01 ether);
        uint256 before = payer.balance;

        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);

        for (uint256 i; i < to.length; ++i) {
            assertEq(to[i].balance, amounts[i], "recipient balance");
        }
        assertEq(payer.balance, before - total, "payer debited exactly the total");
        assertEq(address(rs).balance, 0, "contract keeps nothing");
    }

    function test_payNative_emitsLineAndBatchEvents() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 2, 1 ether);

        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(0), to[0], amounts[0]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(0), to[1], amounts[1]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit BatchPaid(REF, payer, address(0), total, 2);

        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);
    }

    function test_payNative_allowsDuplicateRecipients() public {
        address a = makeAddr("dup");
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = a;
        to[1] = a;
        amounts[0] = 1;
        amounts[1] = 2;
        vm.prank(payer);
        rs.payNative{value: 3}(to, amounts, REF);
        assertEq(a.balance, 3);
    }

    // ---------------------------------------------------------------- native: input validation

    function test_payNative_revertsOnEmptyBatch() public {
        vm.expectRevert(Remitsheet.EmptyBatch.selector);
        vm.prank(payer);
        rs.payNative(new address[](0), new uint256[](0), REF);
    }

    function test_payNative_revertsOnLengthMismatch() public {
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.LengthMismatch.selector, 2, 1));
        vm.prank(payer);
        rs.payNative{value: 1}(new address[](2), new uint256[](1), REF);
    }

    function test_payNative_revertsOnZeroAddress() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 3, 1);
        to[2] = address(0);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAddress.selector, 2));
        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);
    }

    function test_payNative_revertsOnZeroAmount() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 4, 1);
        total -= amounts[1];
        amounts[1] = 0;
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAmount.selector, 1));
        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);
    }

    function test_payNative_revertsWhenValueTooLow() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 5, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ValueMismatch.selector, total, total - 1));
        vm.prank(payer);
        rs.payNative{value: total - 1}(to, amounts, REF);
    }

    function test_payNative_revertsWhenValueTooHigh() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 6, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ValueMismatch.selector, total, total + 1));
        vm.prank(payer);
        rs.payNative{value: total + 1}(to, amounts, REF);
    }

    function test_payNative_revertsOnOverflowingTotal() public {
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = makeAddr("a");
        to[1] = makeAddr("b");
        amounts[0] = type(uint256).max;
        amounts[1] = 1;
        vm.expectRevert(); // arithmetic overflow panic
        vm.prank(payer);
        rs.payNative{value: 1}(to, amounts, REF);
    }

    function test_directNativeTransferToContractReverts() public {
        vm.prank(payer);
        (bool ok,) = address(rs).call{value: 1}("");
        assertFalse(ok, "contract must not accept stray funds");
    }

    // ---------------------------------------------------------------- native: failing recipients

    function test_payNative_allOrNothingWhenARecipientRejects() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(4, 7, 1 ether);
        RejectingRecipient bad = new RejectingRecipient();
        to[3] = address(bad);
        uint256 before = payer.balance;

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 3, address(bad)));
        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);

        for (uint256 i; i < 3; ++i) {
            assertEq(to[i].balance, 0, "earlier lines rolled back");
        }
        assertEq(payer.balance, before, "payer keeps everything");
    }

    function test_payNative_returnBombDoesNotBlowUpGas() public {
        ReturnBombRecipient bomb = new ReturnBombRecipient();
        (address[] memory to, uint256[] memory amounts) = _one(address(bomb), 1 ether);
        vm.prank(payer);
        uint256 g = gasleft();
        rs.payNative{value: 1 ether}(to, amounts, REF);
        uint256 used = g - gasleft();
        assertEq(address(bomb).balance, 1 ether);
        // The recipient expands its own memory (paid by the forwarded gas), but Remitsheet never
        // copies the 100 kB return payload into its own memory.
        assertLt(used, 200_000, "return data is not copied");
    }

    // ---------------------------------------------------------------- native: reentrancy

    function test_reentrantRecipientCannotTakeMoreThanItsLine() public {
        ReentrantRecipient attacker = new ReentrantRecipient(rs, address(musd));
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 8, 1 ether);
        to[0] = address(attacker); // paid first, while the rest of the batch is still in the contract
        uint256 musdBefore = musd.balanceOf(payer);

        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);

        assertTrue(attacker.attemptedNative() && attacker.attemptedToken(), "attack ran");
        assertFalse(attacker.nativeReentrySucceeded(), "no free native");
        assertFalse(attacker.tokenReentrySucceeded(), "no use of the payer's allowance");
        assertEq(address(attacker).balance, amounts[0], "attacker got exactly its line");
        assertEq(to[1].balance, amounts[1]);
        assertEq(to[2].balance, amounts[2]);
        assertEq(musd.balanceOf(payer), musdBefore, "payer tokens untouched");
        assertEq(address(rs).balance, 0);
    }

    function test_reentrantTokenCannotPayItselfFromOthers() public {
        ReentrantToken token = new ReentrantToken(rs);
        token.mint(payer, 100);
        vm.prank(payer);
        token.approve(address(rs), 100);
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 10);

        vm.prank(payer);
        rs.payToken(address(token), to, amounts, REF);

        assertFalse(token.reentrySucceeded(), "inner call had nothing to spend");
        assertEq(token.balanceOf(to[0]), 10);
        assertEq(token.balanceOf(payer), 90);
    }

    function test_nestedBatchWithOwnValueStillAccountsCorrectly() public {
        address finalRecipient = makeAddr("final");
        ForwardingRecipient fwd = new ForwardingRecipient(rs, finalRecipient);
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 9, 1 ether);
        to[1] = address(fwd);

        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, REF);

        assertEq(finalRecipient.balance, amounts[1], "forwarded line arrives");
        assertEq(address(fwd).balance, 0);
        assertEq(to[0].balance, amounts[0]);
        assertEq(to[2].balance, amounts[2]);
        assertEq(address(rs).balance, 0);
    }

    // ---------------------------------------------------------------- token path

    function test_payToken_paysEveryRecipient() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(5, 10, 1e6);
        uint256 before = musd.balanceOf(payer);

        vm.prank(payer);
        rs.payToken(address(musd), to, amounts, REF);

        for (uint256 i; i < to.length; ++i) {
            assertEq(musd.balanceOf(to[i]), amounts[i]);
        }
        assertEq(musd.balanceOf(payer), before - total);
        assertEq(musd.balanceOf(address(rs)), 0, "contract never holds tokens");
    }

    function test_payToken_emitsLineAndBatchEvents() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 11, 1e6);

        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(musd), to[0], amounts[0]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(musd), to[1], amounts[1]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit BatchPaid(REF, payer, address(musd), total, 2);

        vm.prank(payer);
        rs.payToken(address(musd), to, amounts, REF);
    }

    function test_payToken_rejectsAddressWithoutCode() public {
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 1);
        address eoa = makeAddr("not a token");
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.InvalidToken.selector, eoa));
        vm.prank(payer);
        rs.payToken(eoa, to, amounts, REF);
    }

    function test_payToken_validation() public {
        vm.startPrank(payer);
        vm.expectRevert(Remitsheet.EmptyBatch.selector);
        rs.payToken(address(musd), new address[](0), new uint256[](0), REF);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.LengthMismatch.selector, 1, 2));
        rs.payToken(address(musd), new address[](1), new uint256[](2), REF);

        (address[] memory to, uint256[] memory amounts) = _one(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAddress.selector, 0));
        rs.payToken(address(musd), to, amounts, REF);

        (to, amounts) = _one(makeAddr("r"), 0);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAmount.selector, 0));
        rs.payToken(address(musd), to, amounts, REF);
        vm.stopPrank();
    }

    function test_payToken_allOrNothingOnInsufficientAllowance() public {
        MockERC20 t = new MockERC20("T", "T", 6);
        t.mint(payer, 100);
        vm.prank(payer);
        t.approve(address(rs), 15); // enough for the first two lines only
        (address[] memory to, uint256[] memory amounts,) = _batch(3, 12, 5); // 5, 10, 15

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 2, to[2]));
        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);

        assertEq(t.balanceOf(to[0]), 0, "rolled back");
        assertEq(t.balanceOf(payer), 100);
    }

    function test_payToken_falseReturnIsFailure() public {
        FalseReturningToken t = new FalseReturningToken();
        t.mint(payer, 5);
        vm.prank(payer);
        t.approve(address(rs), 100);
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 6); // more than the balance

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 0, to[0]));
        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);
    }

    function test_payToken_alwaysFalseTokenIsFailure() public {
        AlwaysFalseToken t = new AlwaysFalseToken();
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 1);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 0, to[0]));
        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);
    }

    function test_payToken_noReturnDataTokenWorks() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(payer, 100);
        vm.prank(payer);
        t.approve(address(rs), 100);
        (address[] memory to, uint256[] memory amounts,) = _batch(3, 13, 7);

        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);
        assertEq(t.balanceOf(to[2]), 21);
        assertEq(t.balanceOf(payer), 100 - 42);
    }

    function test_payToken_noReturnDataTokenRevertIsFailure() public {
        NoReturnToken t = new NoReturnToken(); // no allowance given
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 1);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 0, to[0]));
        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);
    }

    function test_payToken_malformedReturnDataIsFailure() public {
        ShortReturnToken t = new ShortReturnToken();
        (address[] memory to, uint256[] memory amounts) = _one(makeAddr("r"), 1);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 0, to[0]));
        vm.prank(payer);
        rs.payToken(address(t), to, amounts, REF);
    }

    function test_payToken_cannotSpendSomeoneElsesAllowance() public {
        // payer approved Remitsheet in setUp; a third party cannot move payer's tokens.
        address thief = makeAddr("thief");
        (address[] memory to, uint256[] memory amounts) = _one(thief, 1e6);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 0, thief));
        vm.prank(thief);
        rs.payToken(address(musd), to, amounts, REF);
        assertEq(musd.balanceOf(thief), 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_payNative(uint8 rawN, uint256 seed) public {
        uint256 n = bound(rawN, 1, 60);
        address[] memory to = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            to[i] = _addr(seed, i);
            amounts[i] = bound(uint256(keccak256(abi.encode(seed, i, "amt"))), 1, 1e24);
            total += amounts[i];
        }
        uint256 before = payer.balance;

        vm.prank(payer);
        rs.payNative{value: total}(to, amounts, bytes32(seed));

        for (uint256 i; i < n; ++i) {
            assertEq(to[i].balance, amounts[i]);
        }
        assertEq(payer.balance, before - total);
        assertEq(address(rs).balance, 0);
    }

    function testFuzz_payNative_anyValueMismatchReverts(uint256 seed, uint256 delta, bool over) public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(4, seed, 1 ether);
        delta = bound(delta, 1, total);
        uint256 value = over ? total + delta : total - delta;
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ValueMismatch.selector, total, value));
        vm.prank(payer);
        rs.payNative{value: value}(to, amounts, REF);
    }

    function testFuzz_payToken(uint8 rawN, uint256 seed) public {
        uint256 n = bound(rawN, 1, 60);
        address[] memory to = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            to[i] = _addr(seed, i);
            amounts[i] = bound(uint256(keccak256(abi.encode(seed, i, "amt"))), 1, 1e18);
            total += amounts[i];
        }
        uint256 before = musd.balanceOf(payer);

        vm.prank(payer);
        rs.payToken(address(musd), to, amounts, bytes32(seed));

        for (uint256 i; i < n; ++i) {
            assertEq(musd.balanceOf(to[i]), amounts[i]);
        }
        assertEq(musd.balanceOf(payer), before - total);
        assertEq(musd.balanceOf(address(rs)), 0);
    }

    function testFuzz_lengthMismatchAlwaysReverts(uint8 a, uint8 b) public {
        vm.assume(a != b);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.LengthMismatch.selector, uint256(a), uint256(b)));
        vm.prank(payer);
        rs.payNative(new address[](a), new uint256[](b), REF);
    }

    // ---------------------------------------------------------------- gas per batch size

    function _gasNative(uint256 n, bool fresh) internal returns (uint256 used) {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(n, fresh ? 100 + n : 200 + n, 1e16);
        if (!fresh) {
            for (uint256 i; i < n; ++i) {
                vm.deal(to[i], 1); // account already exists
            }
        }
        vm.prank(payer);
        uint256 g = gasleft();
        rs.payNative{value: total}(to, amounts, REF);
        used = g - gasleft();
    }

    function _gasToken(uint256 n, bool fresh) internal returns (uint256 used) {
        (address[] memory to, uint256[] memory amounts,) = _batch(n, fresh ? 300 + n : 400 + n, 1e4);
        if (!fresh) {
            for (uint256 i; i < n; ++i) {
                musd.mint(to[i], 1); // recipient already holds the token
            }
        }
        vm.prank(payer);
        uint256 g = gasleft();
        rs.payToken(address(musd), to, amounts, REF);
        used = g - gasleft();
    }

    function test_gas_batchSizes() public {
        uint256[3] memory sizes = [uint256(10), 50, 200];
        for (uint256 k; k < sizes.length; ++k) {
            uint256 n = sizes[k];
            uint256 nf = _gasNative(n, true);
            uint256 ne = _gasNative(n, false);
            uint256 tf = _gasToken(n, true);
            uint256 te = _gasToken(n, false);
            console.log("recipients", n);
            console.log("  native, new accounts      total / per line", nf, nf / n);
            console.log("  native, existing accounts total / per line", ne, ne / n);
            console.log("  token,  new holders       total / per line", tf, tf / n);
            console.log("  token,  existing holders  total / per line", te, te / n);
            assertLt(nf, TX_GAS_CAP, "200 new recipients fit in one Mezo block");
            assertLt(tf, TX_GAS_CAP);
        }
    }
}
