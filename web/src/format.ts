import type { Hex } from "./config";

/** Parses a plain decimal string ("1250.5") into base units. Returns null if malformed or too precise. */
export function parseDecimal(text: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text) ?? /^()\.(\d+)$/.exec(text);
  if (!m) return null;
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Formats base units with thousands separators and between `minFrac` and `decimals` fraction digits. */
export function formatAmount(value: bigint, decimals: number, minFrac = 2, maxFrac = decimals): string {
  const negative = value < 0n;
  let v = negative ? -value : value;
  // round to maxFrac digits (half up)
  if (maxFrac < decimals) {
    const drop = 10n ** BigInt(decimals - maxFrac);
    v = (v + drop / 2n) / drop;
    decimals = maxFrac;
  }
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = decimals > 0 ? (v % base).toString().padStart(decimals, "0") : "";
  frac = frac.replace(/0+$/, "");
  if (frac.length < minFrac) frac = frac.padEnd(Math.min(minFrac, decimals), "0");
  return (negative ? "-" : "") + whole + (frac ? "." + frac : "");
}

/** Plain machine-readable decimal (no separators), trimmed of trailing zeros but keeping `minFrac` digits. */
export function plainAmount(value: bigint, decimals: number, minFrac = 2): string {
  return formatAmount(value, decimals, minFrac).replace(/,/g, "");
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function refByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Encodes a batch reference as bytes32 (UTF-8, right-padded). Throws if longer than 32 bytes. */
export function encodeRef(text: string): Hex {
  const bytes = encoder.encode(text.trim());
  if (bytes.length > 32) throw new Error("Reference is longer than 32 bytes");
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return ("0x" + Array.from(padded, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** Decodes a bytes32 reference to text when it is printable UTF-8, otherwise returns the hex. */
export function decodeRef(ref: Hex): string {
  const hex = ref.slice(2).replace(/(00)+$/, "");
  if (!hex) return "";
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  try {
    const text = decoder.decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) return ref;
    return text;
  } catch {
    return ref;
  }
}

export function utcDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function utcTime(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 19);
}

export function escapeCsv(value: string): string {
  // Neutralise spreadsheet formulas (CSV injection) and quote when needed.
  let v = value;
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 1 satoshi in 18-decimal BTC base units. */
export const WEI_PER_SAT = 10n ** 10n;

/** A BTC amount (18 decimals) as satoshis for display: "146 sats", "< 1 sat", "12,345 sats". */
export function formatSats(value: bigint): string {
  if (value <= 0n) return "0 sats";
  if (value < WEI_PER_SAT) return "< 1 sat";
  const sats = (value + WEI_PER_SAT / 2n) / WEI_PER_SAT;
  return `${formatAmount(sats, 0, 0)} ${sats === 1n ? "sat" : "sats"}`;
}
