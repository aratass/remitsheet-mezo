import { type ChainConfig, type Hex } from "./config";

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
};

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type AnnouncedWallet = { info: WalletInfo; provider: Eip1193Provider };

type WalletState = {
  provider: Eip1193Provider | null;
  info: WalletInfo | null;
  account: Hex | null;
  chainId: number | null;
};

export const wallet: WalletState = { provider: null, info: null, account: null, chainId: null };
export const discovered: AnnouncedWallet[] = [];

const listeners = new Set<() => void>();
export function onWalletChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn();
}

const LAST_WALLET_KEY = "remitsheet-mezo:wallet";

/** EIP-6963 multi-wallet discovery, with window.ethereum as a fallback. */
export function startDiscovery(): void {
  window.addEventListener("eip6963:announceProvider", (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedWallet>).detail;
    if (!detail?.info?.uuid || discovered.some((w) => w.info.uuid === detail.info.uuid)) return;
    discovered.push(detail);
    emit();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function legacyInjected(): AnnouncedWallet | null {
  const eth = (window as unknown as { ethereum?: Eip1193Provider & { isRabby?: boolean; isMetaMask?: boolean } }).ethereum;
  if (!eth) return null;
  const name = eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "Browser wallet";
  return { info: { uuid: "legacy", name, icon: "", rdns: "legacy.injected" }, provider: eth };
}

export function availableWallets(): AnnouncedWallet[] {
  if (discovered.length) return discovered;
  const legacy = legacyInjected();
  return legacy ? [legacy] : [];
}

function parseChainId(value: unknown): number {
  return typeof value === "string" ? parseInt(value, value.startsWith("0x") ? 16 : 10) : Number(value);
}

const handleAccounts = (accounts: unknown) => {
  const list = accounts as string[];
  wallet.account = list && list.length ? (list[0] as Hex) : null;
  if (!wallet.account) {
    wallet.provider = null;
    wallet.info = null;
    wallet.chainId = null;
  }
  emit();
};
const handleChain = (chainId: unknown) => {
  wallet.chainId = parseChainId(chainId);
  emit();
};

function attach(w: AnnouncedWallet) {
  if (wallet.provider && wallet.provider !== w.provider) {
    wallet.provider.removeListener?.("accountsChanged", handleAccounts);
    wallet.provider.removeListener?.("chainChanged", handleChain);
  }
  wallet.provider = w.provider;
  wallet.info = w.info;
  w.provider.on?.("accountsChanged", handleAccounts);
  w.provider.on?.("chainChanged", handleChain);
}

export async function connect(w: AnnouncedWallet): Promise<void> {
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("The wallet did not share an account.");
  attach(w);
  wallet.account = accounts[0] as Hex;
  wallet.chainId = parseChainId(await w.provider.request({ method: "eth_chainId" }));
  try {
    localStorage.setItem(LAST_WALLET_KEY, w.info.rdns);
  } catch {
    /* storage unavailable */
  }
  emit();
}

/** Reconnects silently (eth_accounts, no prompt) to the wallet used last time, if it still has permission. */
export async function reconnect(): Promise<void> {
  let rdns: string | null = null;
  try {
    rdns = localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return;
  }
  if (!rdns) return;
  // give EIP-6963 wallets a moment to announce themselves
  await new Promise((r) => setTimeout(r, 150));
  const w = availableWallets().find((x) => x.info.rdns === rdns);
  if (!w) return;
  try {
    const accounts = (await w.provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.length) return;
    attach(w);
    wallet.account = accounts[0] as Hex;
    wallet.chainId = parseChainId(await w.provider.request({ method: "eth_chainId" }));
    emit();
  } catch {
    /* ignore */
  }
}

export function disconnect(): void {
  if (wallet.provider) {
    wallet.provider.removeListener?.("accountsChanged", handleAccounts);
    wallet.provider.removeListener?.("chainChanged", handleChain);
  }
  wallet.provider = null;
  wallet.info = null;
  wallet.account = null;
  wallet.chainId = null;
  try {
    localStorage.removeItem(LAST_WALLET_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

/** Switches the wallet to `chain`, adding the network first if the wallet does not know it. */
export async function switchTo(chain: ChainConfig): Promise<void> {
  if (!wallet.provider) throw new Error("Connect a wallet first.");
  const chainIdHex = "0x" + chain.id.toString(16);
  try {
    await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } }).code ??
      (err as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((err as Error).message))) throw err;
    await wallet.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
          rpcUrls: [chain.rpcUrl],
          blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined,
        },
      ],
    });
  }
  wallet.chainId = parseChainId(await wallet.provider.request({ method: "eth_chainId" }));
  emit();
}
