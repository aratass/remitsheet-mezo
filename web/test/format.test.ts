import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRef, encodeRef, escapeCsv, formatAmount, formatSats, parseDecimal, plainAmount } from "../src/format";
import { centsToString, eurAtParCents, eurPerUsd, usdToEurCents } from "../src/fx";

test("parseDecimal", () => {
  assert.equal(parseDecimal("1250.5", 6), 1_250_500000n);
  assert.equal(parseDecimal(".5", 6), 500000n);
  assert.equal(parseDecimal("7", 6), 7_000000n);
  assert.equal(parseDecimal("1.0000001", 6), null);
  assert.equal(parseDecimal("1e5", 6), null);
});

test("formatAmount and plainAmount", () => {
  assert.equal(formatAmount(1_234_567_500000n, 6), "1,234,567.50");
  assert.equal(formatAmount(1n, 6, 2), "0.000001");
  assert.equal(formatAmount(1_500000000000000000n, 18, 2, 6), "1.50");
  assert.equal(formatAmount(342000000000000n, 18, 4, 6), "0.000342");
  assert.equal(plainAmount(1_234_000000n, 6), "1234.00");
});

test("batch reference round-trips through bytes32", () => {
  const ref = encodeRef("October contractors");
  assert.equal(ref.length, 66);
  assert.equal(decodeRef(ref), "October contractors");
  assert.equal(decodeRef(encodeRef("Zahlung März")), "Zahlung März");
  assert.throws(() => encodeRef("x".repeat(33)));
  assert.equal(decodeRef(("0x" + "00".repeat(32)) as `0x${string}`), "");
});

test("CSV escaping quotes and neutralises formulas", () => {
  assert.equal(escapeCsv("Rossi, Mia"), '"Rossi, Mia"');
  assert.equal(escapeCsv('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsv("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(escapeCsv("-5"), "-5");
});

test("USD to EUR at the ECB reference rate", () => {
  // 1200 MUSD (18 decimals, valued at 1 USD) at 1.1206 USD per EUR = 1070.8549... EUR
  assert.equal(centsToString(usdToEurCents(1200n * 10n ** 18n, 18, "1.1206")), "1070.85");
  // 6-decimal amount, half-up rounding: 1 USD / 1.1206 = 0.89238 EUR -> 0.89
  assert.equal(centsToString(usdToEurCents(1_000000n, 6, "1.1206")), "0.89");
  assert.equal(eurPerUsd("1.1206"), "0.892379");
  assert.equal(centsToString(eurAtParCents(275_400000n, 6)), "275.40");
  assert.equal(centsToString(eurAtParCents(5_000n, 6)), "0.01"); // 0.005 rounds half up
});

test("network fees in satoshis", () => {
  const sat = 10n ** 10n; // 1 satoshi in 18-decimal BTC units
  assert.equal(formatSats(0n), "0 sats");
  assert.equal(formatSats(146n * 1_000_000n), "< 1 sat"); // a testnet batch: 146 wei per gas
  assert.equal(formatSats(sat), "1 sat");
  assert.equal(formatSats(146n * sat + sat / 2n), "147 sats"); // rounds half up
  assert.equal(formatSats(12_345n * sat), "12,345 sats");
});
