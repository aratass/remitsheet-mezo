/**
 * ECB euro foreign exchange reference rates (USD per 1 EUR), fetched in the browser.
 * Primary source: Frankfurter (https://frankfurter.dev), which republishes the ECB reference rates.
 * Fallback: the ECB Data Portal API. For a date without a published rate (weekend, TARGET holiday,
 * or before ~16:00 CET), the most recent earlier reference rate is used and its date is recorded.
 */
export type EcbRate = {
  /** USD per 1 EUR as published, e.g. "1.1206". */
  usdPerEur: string;
  /** Date of the reference rate actually used (YYYY-MM-DD). */
  rateDate: string;
  source: string;
};

const cache = new Map<string, Promise<EcbRate>>();

export function ecbUsdPerEur(date: string): Promise<EcbRate> {
  let p = cache.get(date);
  if (!p) {
    p = fetchRate(date);
    cache.set(date, p);
    p.catch(() => cache.delete(date));
  }
  return p;
}

async function fetchRate(date: string): Promise<EcbRate> {
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=EUR&symbols=USD`);
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const json = (await res.json()) as { date?: string; rates?: { USD?: number } };
    if (!json.rates?.USD || !json.date) throw new Error("Frankfurter: no USD rate");
    return {
      usdPerEur: String(json.rates.USD),
      rateDate: json.date,
      source: "ECB euro reference rate (via api.frankfurter.dev)",
    };
  } catch (primaryError) {
    try {
      const url =
        `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A` +
        `?endPeriod=${date}&lastNObservations=1&format=csvdata`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
      const lines = (await res.text()).trim().split(/\r?\n/);
      const header = lines[0].split(",");
      const last = lines[lines.length - 1].split(",");
      const rateDate = last[header.indexOf("TIME_PERIOD")];
      const value = last[header.indexOf("OBS_VALUE")];
      if (!rateDate || !value) throw new Error("ECB: no observation");
      return { usdPerEur: value, rateDate, source: "ECB euro reference rate (via data-api.ecb.europa.eu)" };
    } catch {
      throw primaryError;
    }
  }
}

/** Parses a decimal rate string into an integer scaled by 1e8. */
function scaleRate(rate: string): bigint {
  const [w, f = ""] = rate.split(".");
  return BigInt(w) * 10n ** 8n + BigInt((f + "00000000").slice(0, 8));
}

/** EUR cents for `amount` base units of a USD-pegged asset (1 MUSD valued at 1 USD), half-up. */
export function usdToEurCents(amount: bigint, decimals: number, usdPerEur: string): bigint {
  const rate = scaleRate(usdPerEur);
  const num = amount * 100n * 10n ** 8n;
  const den = rate * 10n ** BigInt(decimals);
  return (num * 2n + den) / (2n * den);
}

/** EUR cents for `amount` base units of a euro stablecoin valued at par (1 EURC = 1 EUR), half-up. */
export function eurAtParCents(amount: bigint, decimals: number): bigint {
  const den = 10n ** BigInt(decimals);
  return (amount * 100n * 2n + den) / (2n * den);
}

export function centsToString(cents: bigint): string {
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? "-" : ""}${v / 100n}.${(v % 100n).toString().padStart(2, "0")}`;
}

/** EUR per 1 USD with 6 decimals, for the export. */
export function eurPerUsd(usdPerEur: string): string {
  const rate = scaleRate(usdPerEur);
  const scaled = (10n ** 14n * 2n + rate) / (2n * rate); // 1e6 * 1e8 / rate, half-up
  return `${scaled / 1000000n}.${(scaled % 1000000n).toString().padStart(6, "0")}`;
}
