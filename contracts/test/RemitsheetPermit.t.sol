// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Remitsheet} from "../src/Remitsheet.sol";
import {TestMUSD, TestMEZO} from "./mocks/MezoTokens.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @dev Tests for payTokenWithPermit: one signature and one transaction for MUSD and MEZO batches.
contract RemitsheetPermitTest is Test {
    event Paid(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event BatchPaid(
        bytes32 indexed ref, address indexed sender, address indexed token, uint256 total, uint256 count
    );

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant REF = bytes32("October payroll");

    Remitsheet internal rs;
    TestMUSD internal musd;
    TestMEZO internal mezo;
    address internal payer;
    uint256 internal payerKey;

    function setUp() public {
        vm.warp(1_791_900_000); // 13 Oct 2026
        rs = new Remitsheet();
        musd = new TestMUSD();
        mezo = new TestMEZO();
        (payer, payerKey) = makeAddrAndKey("payer");
        musd.mint(payer, 1_000_000 ether);
        mezo.mint(payer, 1_000_000 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _batch(uint256 n, uint256 seed, uint256 unit)
        internal
        pure
        returns (address[] memory to, uint256[] memory amounts, uint256 total)
    {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = address(uint160(uint256(keccak256(abi.encode("recipient", seed, i)))));
            amounts[i] = (i + 1) * unit;
            total += amounts[i];
        }
    }

    function _domainSeparator(address token) internal view returns (bytes32) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(ok, "no DOMAIN_SEPARATOR");
        return abi.decode(data, (bytes32));
    }

    function _sign(uint256 key, address token, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = TestMUSD(token).nonces(owner); // both test tokens expose nonces(address)
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(token), structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function _signFor(address token, uint256 value) internal view returns (uint256 deadline, uint8 v, bytes32 r, bytes32 s) {
        deadline = block.timestamp + 30 minutes;
        (v, r, s) = _sign(payerKey, token, payer, address(rs), value, deadline);
    }

    // ---------------------------------------------------------------- domains match the live tokens

    function test_domainsMatchMezoTokens() public view {
        // Same name and version as the live tokens: MUSD "Mezo USD" v1 (OpenZeppelin ERC20Permit),
        // MEZO precompile "MEZO" v1. Checked against DOMAIN_SEPARATOR() on Mezo testnet and mainnet.
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        assertEq(
            _domainSeparator(address(musd)),
            keccak256(abi.encode(typeHash, keccak256("Mezo USD"), keccak256("1"), block.chainid, address(musd)))
        );
        assertEq(
            _domainSeparator(address(mezo)),
            keccak256(abi.encode(typeHash, keccak256("MEZO"), keccak256("1"), block.chainid, address(mezo)))
        );
    }

    // ---------------------------------------------------------------- happy paths

    function test_permit_MUSD_paysEveryRecipientWithOneSignature() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(5, 1, 100 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);
        uint256 before = musd.balanceOf(payer);
        assertEq(musd.allowance(payer, address(rs)), 0, "no approval transaction beforehand");

        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);

        for (uint256 i; i < to.length; ++i) {
            assertEq(musd.balanceOf(to[i]), amounts[i]);
        }
        assertEq(musd.balanceOf(payer), before - total);
        assertEq(musd.allowance(payer, address(rs)), 0, "nothing left approved");
        assertEq(musd.balanceOf(address(rs)), 0, "contract never holds tokens");
        assertEq(musd.nonces(payer), 1, "permit consumed");
    }

    function test_permit_MEZO_boolReturningPermitWorks() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 2, 7 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(mezo), total);
        assertTrue(v == 27 || v == 28, "wallet-style v");

        vm.prank(payer);
        rs.payTokenWithPermit(address(mezo), to, amounts, REF, deadline, v, r, s);

        for (uint256 i; i < to.length; ++i) {
            assertEq(mezo.balanceOf(to[i]), amounts[i]);
        }
        assertEq(mezo.allowance(payer, address(rs)), 0);
    }

    function test_permit_emitsLineAndBatchEvents() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 3, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);

        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(musd), to[0], amounts[0]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit Paid(REF, address(musd), to[1], amounts[1]);
        vm.expectEmit(true, true, true, true, address(rs));
        emit BatchPaid(REF, payer, address(musd), total, 2);

        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
    }

    // ---------------------------------------------------------------- signature problems

    function test_permit_frontRunPermitStillPays() public {
        // Someone copies the signature from the mempool and submits the permit first.
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 4, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);
        vm.prank(makeAddr("front-runner"));
        musd.permit(payer, address(rs), total, deadline, v, r, s);

        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        assertEq(musd.balanceOf(to[2]), amounts[2]);
        assertEq(musd.allowance(payer, address(rs)), 0);
    }

    function test_permit_signatureForAnotherAmountReverts() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 5, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total - 1);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        assertEq(musd.balanceOf(to[0]), 0);
    }

    function test_permit_expiredSignatureReverts() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 6, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(mezo), total);
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        vm.prank(payer);
        rs.payTokenWithPermit(address(mezo), to, amounts, REF, deadline, v, r, s);
    }

    function test_permit_signatureCannotBeReplayed() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 7, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);
        vm.startPrank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        vm.stopPrank();
        assertEq(musd.balanceOf(to[0]), amounts[0], "paid once only");
    }

    function test_permit_someoneElsesSignatureIsUseless() public {
        // An attacker submits the payer's signature with their own recipients: the permit owner is
        // always msg.sender, so the signature does not verify and nothing of the payer's can move.
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 8, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);
        address attacker = makeAddr("attacker");
        to[0] = attacker;

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        vm.prank(attacker);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);

        assertEq(musd.balanceOf(attacker), 0);
        assertEq(musd.allowance(payer, address(rs)), 0);
        assertEq(musd.nonces(payer), 0, "payer's signature is still unused");
    }

    function test_permit_mezoRejectsNonWalletV() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(1, 9, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(mezo), total);
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        vm.prank(payer);
        rs.payTokenWithPermit(address(mezo), to, amounts, REF, deadline, v - 27, r, s); // 0 or 1
    }

    function test_permit_existingAllowanceIsEnoughEvenWithABadSignature() public {
        // Documented behaviour: only the allowance after the permit call matters.
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 10, 1 ether);
        vm.prank(payer);
        musd.approve(address(rs), total);

        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, 0, 27, bytes32(0), bytes32(0));
        assertEq(musd.balanceOf(to[1]), amounts[1]);
        assertEq(musd.allowance(payer, address(rs)), 0);
    }

    function test_permit_tokenWithoutPermitNeedsAnAllowance() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        plain.mint(payer, 10 ether);
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 11, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.PermitFailed.selector, total, 0));
        vm.prank(payer);
        rs.payTokenWithPermit(address(plain), to, amounts, REF, block.timestamp, 27, bytes32(0), bytes32(0));
    }

    // ---------------------------------------------------------------- validation and failures

    function test_permit_validation() public {
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), 1);
        vm.startPrank(payer);
        vm.expectRevert(Remitsheet.EmptyBatch.selector);
        rs.payTokenWithPermit(address(musd), new address[](0), new uint256[](0), REF, deadline, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.LengthMismatch.selector, 1, 2));
        rs.payTokenWithPermit(address(musd), new address[](1), new uint256[](2), REF, deadline, v, r, s);

        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAddress.selector, 0));
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);

        to[0] = makeAddr("r");
        amounts[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.ZeroAmount.selector, 0));
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);

        address eoa = makeAddr("not a token");
        amounts[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(Remitsheet.InvalidToken.selector, eoa));
        rs.payTokenWithPermit(eoa, to, amounts, REF, deadline, v, r, s);
        vm.stopPrank();
        assertEq(musd.nonces(payer), 0, "validation fails before the permit is used");
    }

    function test_permit_musdRecipientRulesAreAllOrNothing() public {
        // MUSD refuses transfers to its own contract address; the whole batch reverts.
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(3, 12, 1 ether);
        to[2] = address(musd);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 2, address(musd)));
        vm.prank(payer);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        assertEq(musd.balanceOf(to[0]), 0, "rolled back");
        assertEq(musd.nonces(payer), 0, "permit rolled back too");
    }

    function test_permit_insufficientBalanceIsAllOrNothing() public {
        address poor = vm.addr(0xB0B);
        musd.mint(poor, 2 ether);
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(2, 13, 1 ether); // 1 + 2 = 3
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, address(musd), poor, address(rs), total, deadline);

        vm.expectRevert(abi.encodeWithSelector(Remitsheet.TransferFailed.selector, 1, to[1]));
        vm.prank(poor);
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        assertEq(musd.balanceOf(poor), 2 ether);
    }

    // ---------------------------------------------------------------- fuzz

    function _fuzzBatch(uint256 n, uint256 seed)
        internal
        pure
        returns (address[] memory to, uint256[] memory amounts, uint256 total)
    {
        to = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            to[i] = address(uint160(uint256(keccak256(abi.encode(seed, i, "to")))));
            amounts[i] = bound(uint256(keccak256(abi.encode(seed, i, "amt"))), 1, 10_000 ether);
            total += amounts[i];
        }
    }

    function testFuzz_permit(uint8 rawN, uint256 seed, bool useMezo) public {
        TestMUSD token = useMezo ? TestMUSD(address(mezo)) : musd; // same ERC-20 and nonces selectors
        (address[] memory to, uint256[] memory amounts, uint256 total) = _fuzzBatch(bound(rawN, 1, 40), seed);
        uint256 before = token.balanceOf(payer);
        _payWithPermit(address(token), to, amounts, bytes32(seed), total);

        assertEq(token.balanceOf(payer), before - total);
        assertEq(token.allowance(payer, address(rs)), 0);
        assertEq(token.balanceOf(address(rs)), 0);
        assertEq(token.balanceOf(to[to.length - 1]) >= amounts[to.length - 1], true);
    }

    function _payWithPermit(address token, address[] memory to, uint256[] memory amounts, bytes32 ref, uint256 total)
        internal
    {
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(token, total);
        vm.prank(payer);
        rs.payTokenWithPermit(token, to, amounts, ref, deadline, v, r, s);
    }

    // ---------------------------------------------------------------- gas on Mezo's 10M block gas limit

    function test_gas_permitBatchOf200FitsInAMezoBlock() public {
        (address[] memory to, uint256[] memory amounts, uint256 total) = _batch(200, 14, 1 ether);
        (uint256 deadline, uint8 v, bytes32 r, bytes32 s) = _signFor(address(musd), total);
        vm.prank(payer);
        uint256 g = gasleft();
        rs.payTokenWithPermit(address(musd), to, amounts, REF, deadline, v, r, s);
        uint256 used = g - gasleft();
        emit log_named_uint("MUSD permit batch, 200 new holders, gas", used);
        assertLt(used, 9_000_000, "fits in a 10M gas Mezo block with room for intrinsic gas");
    }
}
