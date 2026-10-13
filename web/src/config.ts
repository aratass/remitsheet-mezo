import { REMITSHEET_ADDRESS } from "./generated/remitsheet";

export type Hex = `0x${string}`;

export type Asset = "MUSD" | "MEZO" | "BTC";

/** EIP-712 domain of an EIP-2612 permit. It is checked against the token's DOMAIN_SEPARATOR() before use. */
export type PermitDomain = { name: string; version: string };

/** Mezo's borrowing system (mezo-org/musd): read-only, for the credit line panel. */
export type BorrowContracts = {
  troveManager: Hex;
  priceFeed: Hex;
  borrowerOperations: Hex;
};

export type ChainConfig = {
  id: number;
  /** Name shown to the wallet when the network is added. */
  name: string;
  /** Short label for the UI. */
  label: string;
  rpcUrl: string;
  explorer: string;
  testnet: boolean;
  remitsheet: Hex;
  musd?: Hex;
  mezo?: Hex;
  borrow?: BorrowContracts;
  /** Where to borrow MUSD against BTC (the Mezo app). */
  borrowUrl?: string;
  /** Test BTC and MEZO (testnet only). */
  faucetUrl?: string;
};

/** BTC (native gas token on Mezo), MUSD and MEZO all use 18 decimals. */
export const NATIVE_DECIMALS = 18;
export const TOKEN_DECIMALS = 18;
/** Amounts in a sheet may have at most 8 decimals (one satoshi for BTC). */
export const INPUT_DECIMALS = 8;
/** Sheet amounts (8 decimals) to 18-decimal base units. */
export const INPUT_SCALE = 10n ** BigInt(TOKEN_DECIMALS - INPUT_DECIMALS);
/**
 * Upper bound on lines per batch. A 200-line MUSD batch with permit to new holders uses about 6.1M gas
 * and a 200-line BTC batch to new accounts about 7.5M (Foundry gas tests), below Mezo's 10M block gas limit.
 */
export const MAX_ROWS = 200;

export const MEZO_MAINNET = 31612;
export const MEZO_TESTNET = 31611;
export const LOCAL_CHAIN = 31337;

/** Mezo's precompiled tokens have the same addresses on testnet and mainnet. */
export const BTC_PRECOMPILE: Hex = "0x7b7C000000000000000000000000000000000000";
export const MEZO_TOKEN: Hex = "0x7B7c000000000000000000000000000000000001";
export const PRICE_ORACLE_PRECOMPILE: Hex = "0x7b7c000000000000000000000000000000000015";

/** Permit domains of the live tokens (checked on chain on 13 Oct 2026). */
export const PERMIT_DOMAINS: Record<"MUSD" | "MEZO", PermitDomain> = {
  MUSD: { name: "Mezo USD", version: "1" },
  MEZO: { name: "MEZO", version: "1" },
};

// Sources: https://mezo.org/docs/developers/getting-started , github.com/mezo-org/musd (deployment artifacts),
// and on-chain checks of chain ids, token metadata, DOMAIN_SEPARATOR() and the borrowing contracts.
export const CHAINS: Record<number, ChainConfig> = {
  [MEZO_MAINNET]: {
    id: MEZO_MAINNET,
    name: "Mezo",
    label: "Mezo mainnet",
    rpcUrl: "https://rpc-http.mezo.boar.network",
    explorer: "https://explorer.mezo.org",
    testnet: false,
    remitsheet: REMITSHEET_ADDRESS,
    musd: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186",
    mezo: MEZO_TOKEN,
    borrow: {
      troveManager: "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193",
      priceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
      borrowerOperations: "0x44b1bac67dDA612a41a58AAf779143B181dEe031",
    },
    borrowUrl: "https://mezo.org/borrow",
  },
  [MEZO_TESTNET]: {
    id: MEZO_TESTNET,
    name: "Mezo Testnet",
    label: "Mezo testnet",
    rpcUrl: "https://rpc.test.mezo.org",
    explorer: "https://explorer.test.mezo.org",
    testnet: true,
    remitsheet: REMITSHEET_ADDRESS,
    musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
    mezo: MEZO_TOKEN,
    borrow: {
      troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
      priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
      borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
    },
    borrowUrl: "https://testnet.mezo.org",
    faucetUrl: "https://faucet.test.mezo.org",
  },
  [LOCAL_CHAIN]: {
    id: LOCAL_CHAIN,
    name: "Local test chain",
    label: "Local test chain",
    rpcUrl: "http://127.0.0.1:8545",
    explorer: "",
    testnet: true,
    remitsheet: REMITSHEET_ADDRESS,
  },
};

/** Wave 1 runs on Mezo testnet; the same contract address works on mainnet once deployed there. */
export const DEFAULT_CHAIN = MEZO_TESTNET;
export const REPO_URL = "https://github.com/aratass/remitsheet-mezo";

/** The local development chain is only offered on localhost or with ?dev=1. */
export function devMode(): boolean {
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || new URLSearchParams(location.search).has("dev");
}

export function supportedChain(id: number | null | undefined): ChainConfig | undefined {
  if (id == null) return undefined;
  if (id === LOCAL_CHAIN && !devMode()) return undefined;
  return CHAINS[id];
}

export function tokenAddress(chain: ChainConfig, asset: Asset): Hex | undefined {
  return asset === "MUSD" ? chain.musd : asset === "MEZO" ? chain.mezo : undefined;
}

/** Optional runtime overrides from config.json next to index.html (e.g. a non-CREATE2 deployment). */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { chains?: Record<string, Partial<ChainConfig>> };
    for (const [id, patch] of Object.entries(json.chains ?? {})) {
      const chain = CHAINS[Number(id)];
      if (chain) Object.assign(chain, patch);
    }
  } catch {
    // config.json is optional
  }
  // A per-browser override set on the Deploy page when the CREATE2 factory is unavailable.
  try {
    const local = JSON.parse(localStorage.getItem("remitsheet-mezo:overrides") || "{}") as Record<string, Hex>;
    for (const [id, address] of Object.entries(local)) {
      const chain = CHAINS[Number(id)];
      if (chain && /^0x[0-9a-fA-F]{40}$/.test(address)) chain.remitsheet = address;
    }
  } catch {
    // storage may be unavailable
  }
}

export function txUrl(chain: ChainConfig, hash: string): string | undefined {
  return chain.explorer ? `${chain.explorer}/tx/${hash}` : undefined;
}

export function addressUrl(chain: ChainConfig, address: string): string | undefined {
  return chain.explorer ? `${chain.explorer}/address/${address}` : undefined;
}
