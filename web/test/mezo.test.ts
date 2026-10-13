import { test } from "node:test";
import assert from "node:assert/strict";
import { COMFORT_RATIO, collateralRatio, debtAfterBorrowing, formatRatio, headroom, liquidationLtv, loanToValue, type CreditLine } from "../src/borrow";
import { readRequest, requestLine } from "../src/request";

const E18 = 10n ** 18n;
const PRICE = 83_153_555160000000000000n; // Mezo testnet PriceFeed, 13 Oct 2026

const line = (coll: bigint, debt: bigint): CreditLine => ({
  price: PRICE,
  mcr: 11n * 10n ** 17n,
  ccr: 15n * 10n ** 17n,
  borrowingRate: 10n ** 15n, // 0.1%
  minNetDebt: 1800n * E18,
  active: true,
  coll,
  debt,
});

test("collateral ratio of a Mezo loan", () => {
  const l = line(2n * 10n ** 17n, 3000n * E18); // 0.2 BTC against 3,000 MUSD
  assert.equal(formatRatio(collateralRatio(l.coll, l.debt, l.price)), "554.4%");
  assert.equal(formatRatio(11n * 10n ** 17n), "110.0%");
  assert.equal(collateralRatio(1n, 0n, PRICE), 0n);
});

test("borrowing the shortfall adds the borrowing fee to the debt", () => {
  const l = line(2n * 10n ** 17n, 3000n * E18);
  const shortfall = 224575n * 10n ** 16n; // 2,245.75 MUSD
  assert.equal(debtAfterBorrowing(l, shortfall), 3000n * E18 + shortfall + shortfall / 1000n);
  assert.equal(formatRatio(collateralRatio(l.coll, debtAfterBorrowing(l, shortfall), l.price)), "316.9%");
});

test("loan-to-value, as the Mezo app shows it", () => {
  const l = line(2n * 10n ** 17n, 3000n * E18);
  assert.equal(formatRatio(loanToValue(l.coll, l.debt, l.price)), "18.0%");
  assert.equal(formatRatio(loanToValue(l.coll, debtAfterBorrowing(l, 224575n * 10n ** 16n), l.price)), "31.6%");
  assert.equal(formatRatio(liquidationLtv(l.mcr)), "90.9%"); // MCR 110%
  assert.equal(formatRatio(liquidationLtv(COMFORT_RATIO)), "50.0%");
  assert.equal(loanToValue(0n, 1n, PRICE), 0n);
});

test("headroom keeps the ratio at the comfort level, fee included", () => {
  const l = line(2n * 10n ** 17n, 3000n * E18);
  const room = headroom(l);
  const after = collateralRatio(l.coll, debtAfterBorrowing(l, room), l.price);
  assert.ok(after >= COMFORT_RATIO - 10n ** 12n && after <= COMFORT_RATIO + 10n ** 12n, formatRatio(after));
  assert.equal(headroom({ ...l, active: false }), 0n);
  assert.equal(headroom(line(10n ** 16n, 3000n * E18)), 0n); // already below 200%
});

const A = "0x5dad7600C5D89fE3824fFa99ec1c3eB8BF3b0501";

test("payment request links are validated", () => {
  const ok = readRequest(new URLSearchParams({ pay: A, amount: "640", asset: "musd", note: "Invoice 31, illustrations", chain: "31611" }));
  assert.deepEqual(ok, { address: A, amount: "640", asset: "MUSD", note: "Invoice 31, illustrations", chainId: 31611 });
  assert.equal(requestLine(ok!), `${A},640,"Invoice 31, illustrations"`);
  const typo = "0x" + A.slice(2).replace(/[a-fA-F]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  assert.equal(readRequest(new URLSearchParams({ pay: typo, amount: "1" })), null, "bad checksum");
  assert.equal(readRequest(new URLSearchParams({ pay: A, amount: "0" })), null, "zero amount");
  assert.equal(readRequest(new URLSearchParams({ pay: A, amount: "1.123456789" })), null, "too precise");
  assert.equal(readRequest(new URLSearchParams({ pay: A, amount: "5", asset: "DOGE" })), null, "unknown asset");
  assert.equal(readRequest(new URLSearchParams({ pay: "0x0000000000000000000000000000000000000000", amount: "5" })), null, "zero address");
});

test("request notes are cleaned, capped and quoted", () => {
  const r = readRequest(new URLSearchParams({ pay: A.toLowerCase(), amount: "1", note: 'Say "hi"\n' + "x".repeat(100) }))!;
  assert.equal(r.address, A, "returned checksummed");
  assert.equal(r.note.length, 60);
  assert.ok(!r.note.includes("\n"));
  assert.ok(requestLine(r).includes('""hi""'));
});
