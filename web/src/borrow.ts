import { type ChainConfig, type Hex } from "./config";
import { BORROWER_OPERATIONS_ABI, PRICE_FEED_ABI, TROVE_MANAGER_ABI, readClient } from "./chain";

const ONE = 10n ** 18n;

/** The connected account's position in Mezo Borrow (a "trove"), read from Mezo's MUSD contracts. */
export type CreditLine = {
  /** USD per BTC from Mezo's PriceFeed (18 decimals). */
  price: bigint;
  /** Minimum collateral ratio before liquidation (1e18 = 100%). */
  mcr: bigint;
  /** System-wide critical ratio (recovery mode threshold). */
  ccr: bigint;
  /** One-off borrowing fee, added to the debt (1e18 = 100%). */
  borrowingRate: bigint;
  /** Smallest loan Mezo allows, in MUSD. */
  minNetDebt: bigint;
  active: boolean;
  /** Collateral in BTC base units (18 decimals), including pending redistributions. */
  coll: bigint;
  /** Debt in MUSD base units: principal plus interest, including pending redistributions. */
  debt: bigint;
};

/** Collateral ratio we suggest staying above when borrowing more to fund a payout (200%, a 50% loan-to-value). */
export const COMFORT_RATIO = 2n * ONE;

export async function loadCreditLine(chain: ChainConfig, account: Hex): Promise<CreditLine | null> {
  const b = chain.borrow;
  if (!b) return null;
  const pc = readClient(chain);
  const [status, price, mcr, ccr, borrowingRate, minNetDebt] = await Promise.all([
    pc.readContract({ address: b.troveManager, abi: TROVE_MANAGER_ABI, functionName: "getTroveStatus", args: [account] }) as Promise<number>,
    pc.readContract({ address: b.priceFeed, abi: PRICE_FEED_ABI, functionName: "fetchPrice" }) as Promise<bigint>,
    pc.readContract({ address: b.troveManager, abi: TROVE_MANAGER_ABI, functionName: "MCR" }) as Promise<bigint>,
    pc.readContract({ address: b.troveManager, abi: TROVE_MANAGER_ABI, functionName: "CCR" }) as Promise<bigint>,
    pc.readContract({ address: b.borrowerOperations, abi: BORROWER_OPERATIONS_ABI, functionName: "borrowingRate" }) as Promise<bigint>,
    pc.readContract({ address: b.borrowerOperations, abi: BORROWER_OPERATIONS_ABI, functionName: "minNetDebt" }) as Promise<bigint>,
  ]);
  const active = Number(status) === 1;
  let coll = 0n;
  let debt = 0n;
  if (active) {
    const r = (await pc.readContract({ address: b.troveManager, abi: TROVE_MANAGER_ABI, functionName: "getEntireDebtAndColl", args: [account] })) as readonly bigint[];
    coll = r[0] + r[3];
    debt = r[1] + r[2] + r[4] + r[5];
  }
  return { price, mcr, ccr, borrowingRate, minNetDebt, active, coll, debt };
}

/** Collateral ratio (1e18 = 100%) for `coll` BTC against `debt` MUSD at `price`. */
export function collateralRatio(coll: bigint, debt: bigint, price: bigint): bigint {
  if (debt === 0n) return 0n;
  return (coll * price) / debt;
}

/**
 * Loan-to-value (1e18 = 100%), the measure the Mezo app shows: debt divided by the USD value of the
 * collateral. It is the inverse of the collateral ratio; Mezo liquidates above 1 / MCR (about 90.9%).
 */
export function loanToValue(coll: bigint, debt: bigint, price: bigint): bigint {
  const value = (coll * price) / ONE;
  if (value === 0n) return 0n;
  return (debt * ONE) / value;
}

/** The loan-to-value at which a loan is liquidated, from the minimum collateral ratio. */
export function liquidationLtv(mcr: bigint): bigint {
  return mcr === 0n ? 0n : (ONE * ONE) / mcr;
}

/** Debt after borrowing `extra` MUSD more: the borrowing fee is added to the debt. */
export function debtAfterBorrowing(line: CreditLine, extra: bigint): bigint {
  return line.debt + extra + (extra * line.borrowingRate) / ONE;
}

/** How much more MUSD can be borrowed while keeping the collateral ratio at or above `target`. */
export function headroom(line: CreditLine, target: bigint = COMFORT_RATIO): bigint {
  if (!line.active || target === 0n) return 0n;
  const maxDebt = (line.coll * line.price) / target;
  if (maxDebt <= line.debt) return 0n;
  return ((maxDebt - line.debt) * ONE) / (ONE + line.borrowingRate);
}

/** "207.9%" from an 18-decimal ratio or fraction (1e18 = 100%). */
export function formatRatio(ratio: bigint): string {
  const tenths = (ratio * 1000n + ONE / 2n) / ONE; // percent with one decimal, times 10
  return `${tenths / 10n}.${tenths % 10n}%`;
}
