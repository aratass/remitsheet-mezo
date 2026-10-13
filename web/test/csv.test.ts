import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSheet, payableRows } from "../src/csv";

const A = "0x5dad7600C5D89fE3824fFa99ec1c3eB8BF3b0501"; // valid checksum
const B = "0x3440326f551B8A7ee198cEE35cb5D517f2d296a2";

test("parses a sheet with header and labels", () => {
  const s = parseSheet(`address,amount,label\n${A},120.50,Ana\n${B},80,Jonas`);
  assert.equal(s.header, true);
  assert.equal(s.errorCount, 0);
  assert.equal(payableRows(s).length, 2);
  assert.equal(s.total, 200_50000000n); // 8-decimal units
  assert.equal(s.rows[0].label, "Ana");
  assert.equal(s.rows[0].line, 2);
});

test("works without a header, with semicolons and decimal commas", () => {
  const s = parseSheet(`${A};1,5;Ana\n${B};2;Jonas`);
  assert.equal(s.header, false);
  assert.equal(s.delimiter, ";");
  assert.equal(s.errorCount, 0);
  assert.equal(s.total, 3_50000000n);
});

test("finds columns by header name in any order", () => {
  const s = parseSheet(`Name\tAmount\tWallet\nAna\t10\t${A}`);
  assert.equal(s.errorCount, 0);
  assert.equal(s.rows[0].address, A);
  assert.equal(s.rows[0].label, "Ana");
});

test("handles quoted fields with delimiters inside", () => {
  const s = parseSheet(`address,amount,label\n${A},5,"Rossi, Mia ""MR"""`);
  assert.equal(s.rows[0].label, 'Rossi, Mia "MR"');
});

test("accepts lowercase addresses and returns them checksummed", () => {
  const s = parseSheet(`${A.toLowerCase()},1`);
  assert.equal(s.errorCount, 0);
  assert.equal(s.rows[0].address, A);
});

test("rejects a mixed-case address with a wrong checksum", () => {
  const typo = "0x" + A.slice(2).replace(/[a-fA-F]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const s = parseSheet(`${typo},1`);
  assert.equal(s.errorCount, 1);
  assert.match(s.rows[0].errors[0], /Checksum/);
});

test("rejects malformed and zero addresses", () => {
  const s = parseSheet(`0x123,1\nnot-an-address,1\n0x0000000000000000000000000000000000000000,1`);
  assert.equal(s.errorCount, 3);
});

test("rejects zero, negative, too precise and badly formatted amounts", () => {
  const s = parseSheet(`${A},0\n${A},-5\n${A},1.123456789\n${A},1,000.00\n${A},abc\n${A},`);
  assert.equal(s.errorCount, 6);
  assert.equal(s.total, 0n);
});

test("rejects an amount split by an unquoted thousands separator", () => {
  const withHeader = parseSheet(`address,amount,label\n${A},1,250.00,Ana`);
  assert.equal(withHeader.errorCount, 1);
  assert.match(withHeader.rows[0].errors[0], /thousands separator/);
  const noHeader = parseSheet(`${A},12,500`);
  assert.equal(noHeader.errorCount, 1);
  const quoted = parseSheet(`address,amount,label\n${A},"1,250.00",Ana`);
  assert.match(quoted.rows[0].errors[0], /no thousands separators/);
});

test("accepts exactly eight decimals (one satoshi)", () => {
  const s = parseSheet(`${A},0.00000001`);
  assert.equal(s.errorCount, 0);
  assert.equal(s.total, 1n);
});

test("flags duplicates as warnings, not errors", () => {
  const s = parseSheet(`${A},1\n${B},2\n${A},3`);
  assert.equal(s.errorCount, 0);
  assert.equal(s.warningCount, 2);
  assert.match(s.rows[2].warnings[0], /line 1/);
});

test("blocks known non-recipient addresses", () => {
  const blocked = new Map([[A.toLowerCase(), "This is the MUSD token contract, not a person's wallet."]]);
  const s = parseSheet(`${A},1`, { blocked });
  assert.equal(s.errorCount, 1);
  assert.match(s.rows[0].errors[0], /token contract/);
});

test("enforces the row limit", () => {
  const lines = Array.from({ length: 5 }, () => `${A},1`).join("\n");
  const s = parseSheet(lines, { maxRows: 3 });
  assert.equal(s.errorCount, 2);
});

test("ignores blank lines, comments and a BOM", () => {
  const s = parseSheet(`﻿# payroll\n\n${A},1\n\n`);
  assert.equal(s.rows.length, 1);
  assert.equal(s.errorCount, 0);
});

test("reads MUSD, MEZO and BTC amount column headers", () => {
  const s = parseSheet(`wallet;MUSD;name\n${A};1250,5;Ana`);
  assert.equal(s.errorCount, 0);
  assert.equal(s.total, 1250_50000000n);
});
