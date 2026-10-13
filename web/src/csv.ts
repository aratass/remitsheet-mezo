import { getAddress } from "viem";
import { INPUT_DECIMALS, MAX_ROWS, type Hex } from "./config";
import { parseDecimal } from "./format";

export type Row = {
  /** 1-based line number in the pasted text or file. */
  line: number;
  address?: Hex;
  addressText: string;
  amountText: string;
  /** Amount in 8-decimal units (one satoshi for BTC). */
  amount?: bigint;
  label: string;
  errors: string[];
  warnings: string[];
};

export type Sheet = {
  rows: Row[];
  /** Sum of valid rows in 8-decimal units. */
  total: bigint;
  errorCount: number;
  warningCount: number;
  delimiter: string;
  header: boolean;
};

export type ParseOptions = {
  /** Addresses that must never be paid (token contracts, the batch contract, sample rows). */
  blocked?: Map<string, string>;
  maxRows?: number;
};

const ADDRESS_HEADERS = ["address", "wallet", "recipient", "to", "account", "payee", "evm address", "wallet address"];
const AMOUNT_HEADERS = ["amount", "value", "sum", "musd", "mezo", "btc", "usd", "pay", "payment", "total"];
const LABEL_HEADERS = ["label", "name", "note", "memo", "description", "reference", "invoice", "comment"];

/** Splits CSV text into records of fields, honouring double quotes (RFC 4180). */
export function splitCsv(text: string, delimiter: string): { line: number; fields: string[] }[] {
  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (c === delimiter) {
      fields.push(field);
      field = "";
    } else if (c === "\n") {
      fields.push(field);
      out.push({ line: recordLine, fields });
      fields = [];
      field = "";
      line++;
      recordLine = line;
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || fields.length) {
    fields.push(field);
    out.push({ line: recordLine, fields });
  }
  return out;
}

function detectDelimiter(text: string): string {
  const first = text.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
  const counts: [string, number][] = [",", ";", "\t"].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function findColumn(header: string[], names: string[]): number {
  return header.findIndex((h) => names.includes(h.trim().toLowerCase().replace(/[_-]+/g, " ")));
}

/** Parses and validates a payment sheet: `address,amount[,label]`, with or without a header row. */
export function parseSheet(input: string, options: ParseOptions = {}): Sheet {
  const text = input.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const records = splitCsv(text, delimiter).filter(
    (r) => r.fields.some((f) => f.trim() !== "") && !r.fields[0].trim().startsWith("#"),
  );

  let col = { address: 0, amount: 1, label: 2 };
  let header = false;
  let headerWidth = 0;
  if (records.length && !/^0x/i.test(records[0].fields[0].trim()) && /[a-z]/i.test(records[0].fields.join(""))) {
    const h = records[0].fields;
    const a = findColumn(h, ADDRESS_HEADERS);
    const m = findColumn(h, AMOUNT_HEADERS);
    const l = findColumn(h, LABEL_HEADERS);
    header = true;
    headerWidth = h.length;
    col = { address: a >= 0 ? a : 0, amount: m >= 0 ? m : 1, label: l >= 0 ? l : a !== 2 && m !== 2 ? 2 : -1 };
    records.shift();
  }

  const maxRows = options.maxRows ?? MAX_ROWS;
  const seen = new Map<string, number>();
  const rows: Row[] = [];
  let total = 0n;

  records.forEach((rec, index) => {
    const addressText = (rec.fields[col.address] ?? "").trim();
    let amountText = (rec.fields[col.amount] ?? "").trim();
    const label = col.label >= 0 ? (rec.fields[col.label] ?? "").trim().slice(0, 120) : "";
    const row: Row = { line: rec.line, addressText, amountText, label, errors: [], warnings: [] };

    if (index >= maxRows) {
      row.errors.push(`A batch can have at most ${maxRows} recipients. Split the sheet into several batches.`);
    }

    // Address
    if (!addressText) {
      row.errors.push("Missing address.");
    } else if (!/^0x[0-9a-fA-F]{40}$/.test(addressText)) {
      row.errors.push("Not a valid address (expected 0x followed by 40 hex characters).");
    } else {
      const mixedCase = addressText.slice(2) !== addressText.slice(2).toLowerCase() &&
        addressText.slice(2) !== addressText.slice(2).toUpperCase();
      const checksummed = getAddress(addressText.toLowerCase());
      if (mixedCase && checksummed !== addressText) {
        row.errors.push("Checksum mismatch: the letter case does not match this address, so it probably has a typo.");
      } else if (/^0x0{40}$/.test(addressText)) {
        row.errors.push("This is the zero address; funds sent there are lost.");
      } else {
        row.address = checksummed;
        const blockedReason = options.blocked?.get(checksummed.toLowerCase());
        if (blockedReason) row.errors.push(blockedReason);
        const first = seen.get(checksummed.toLowerCase());
        if (first !== undefined) {
          row.warnings.push(`Same address as line ${first}; it will be paid more than once.`);
          const firstRow = rows.find((r) => r.line === first);
          if (firstRow && !firstRow.warnings.some((w) => w.startsWith("Address repeated"))) {
            firstRow.warnings.push("Address repeated further down; it will be paid more than once.");
          }
        } else {
          seen.set(checksummed.toLowerCase(), rec.line);
        }
      }
    }

    // Amount. An unquoted "1,000.00" in a comma-separated file splits into "1" and "000.00";
    // paying 1 instead of 1000 must never happen, so such lines are rejected.
    const next = (rec.fields[col.amount + 1] ?? "").trim();
    const extraField = header ? rec.fields.length > headerWidth : rec.fields.length >= 3;
    if (delimiter === "," && extraField && /^\d{1,3}$/.test(amountText) && /^\d{3}(\.\d*)?$/.test(next)) {
      row.errors.push(`The amount looks split by a thousands separator ("${amountText},${next}"). Write it without the comma, for example ${amountText}${next}, or put it in quotes.`);
    }
    amountText = amountText.replace(/\s+/g, "");
    if (delimiter !== "," && /^\d+,\d+$/.test(amountText)) amountText = amountText.replace(",", ".");
    row.amountText = amountText;
    if (!amountText) {
      row.errors.push("Missing amount.");
    } else if (/^-/.test(amountText)) {
      row.errors.push("Amount must be positive.");
    } else if (/[,\s']/.test(amountText) || /\..*\./.test(amountText)) {
      row.errors.push("Use digits with a dot for decimals and no thousands separators, for example 1250.50.");
    } else if (!row.errors.length || !row.errors[row.errors.length - 1].startsWith("The amount looks split")) {
      const frac = amountText.split(".")[1] ?? "";
      const value = parseDecimal(amountText, INPUT_DECIMALS);
      if (frac.length > INPUT_DECIMALS) {
        row.errors.push(`Too many decimal places (at most ${INPUT_DECIMALS}).`);
      } else if (value === null) {
        row.errors.push("Amount is not a number.");
      } else if (value === 0n) {
        row.errors.push("Amount is zero.");
      } else {
        row.amount = value;
      }
    }

    if (row.errors.length === 0 && row.amount) total += row.amount;
    rows.push(row);
  });

  return {
    rows,
    total,
    errorCount: rows.filter((r) => r.errors.length).length,
    warningCount: rows.filter((r) => r.warnings.length && !r.errors.length).length,
    delimiter,
    header,
  };
}

/** Rows that can be paid: valid address and amount, no errors. */
export function payableRows(sheet: Sheet): (Row & { address: Hex; amount: bigint })[] {
  return sheet.rows.filter((r): r is Row & { address: Hex; amount: bigint } => !r.errors.length && !!r.address && !!r.amount);
}
