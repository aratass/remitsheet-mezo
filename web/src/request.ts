import { getAddress } from "viem";
import { CHAINS, DEFAULT_CHAIN, INPUT_DECIMALS, MEZO_MAINNET, MEZO_TESTNET, devMode, LOCAL_CHAIN, type Asset } from "./config";
import { parseDecimal } from "./format";
import { clear, copyText, h, icon } from "./ui";
import { onWalletChange, wallet } from "./wallet";

/**
 * Payment request links: a contractor, grant winner or teammate fills in their address, the amount
 * and a note, and sends the link to whoever pays them (chat, email, invoice). Opening the link on the
 * Pay page offers to add that line to the payer's sheet, so a whole team can be collected and then
 * paid in one transaction. Nothing is stored anywhere: the request lives only in the link.
 */
export type PaymentRequest = { address: `0x${string}`; amount: string; asset: Asset; note: string; chainId?: number };

const ASSETS: Asset[] = ["MUSD", "MEZO", "BTC"];
const MAX_NOTE = 60;

/** Reads and validates a request from the page URL. Returns null if anything is missing or malformed. */
export function readRequest(params: URLSearchParams): PaymentRequest | null {
  const address = (params.get("pay") ?? "").trim();
  const amount = (params.get("amount") ?? "").trim();
  const asset = (params.get("asset") ?? "MUSD").trim().toUpperCase() as Asset;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return null;
  const mixed = address.slice(2) !== address.slice(2).toLowerCase() && address.slice(2) !== address.slice(2).toUpperCase();
  if (mixed && getAddress(address.toLowerCase()) !== address) return null;
  const value = parseDecimal(amount, INPUT_DECIMALS);
  if (value === null || value === 0n) return null;
  if (!ASSETS.includes(asset)) return null;
  // eslint-disable-next-line no-control-regex
  const note = (params.get("note") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NOTE);
  const chainId = Number(params.get("chain")) || undefined;
  return { address: getAddress(address.toLowerCase()), amount, asset, note, chainId };
}

/** The sheet line for a request, with the note quoted so commas and quotes survive. */
export function requestLine(r: PaymentRequest): string {
  const note = r.note ? `"${r.note.replace(/"/g, '""')}"` : "";
  return `${r.address},${r.amount},${note}`;
}

export function requestUrl(r: PaymentRequest, base = location.origin + location.pathname): string {
  const u = new URL(base);
  u.searchParams.set("pay", r.address);
  u.searchParams.set("amount", r.amount);
  u.searchParams.set("asset", r.asset);
  if (r.note) u.searchParams.set("note", r.note);
  if (r.chainId) u.searchParams.set("chain", String(r.chainId));
  if (devMode() && new URLSearchParams(location.search).has("dev")) u.searchParams.set("dev", "1");
  return u.toString();
}

export function renderRequest(root: HTMLElement): () => void {
  const chains = [CHAINS[MEZO_TESTNET], CHAINS[MEZO_MAINNET], ...(devMode() ? [CHAINS[LOCAL_CHAIN]] : [])];
  const address = h("input", { class: "input mono", id: "req-address", placeholder: "0x… your Mezo address", value: wallet.account ?? "", "aria-label": "Your address" }) as HTMLInputElement;
  const amount = h("input", { class: "input mono", id: "req-amount", placeholder: "250.00", inputmode: "decimal", "aria-label": "Amount" }) as HTMLInputElement;
  const asset = h("select", { class: "input", id: "req-asset", "aria-label": "Asset" }, ASSETS.map((a) => h("option", { value: a }, a))) as HTMLSelectElement;
  const network = h("select", { class: "input", id: "req-chain", "aria-label": "Network" }, chains.map((c) => h("option", { value: String(c.id), selected: c.id === (wallet.chainId ?? DEFAULT_CHAIN) }, c.label))) as HTMLSelectElement;
  const note = h("input", { class: "input", id: "req-note", maxlength: MAX_NOTE, placeholder: "Invoice 42 · October design work", "aria-label": "Note" }) as HTMLInputElement;
  const error = h("p", { class: "fine error", id: "req-error" });
  const result = h("div", { id: "req-result" });

  const make = () => {
    const params = new URLSearchParams({ pay: address.value.trim(), amount: amount.value.trim().replace(",", "."), asset: asset.value, note: note.value, chain: network.value });
    const r = readRequest(params);
    if (!r) {
      error.textContent = "Check the address (0x followed by 40 characters) and the amount (digits with a dot, at most 8 decimals).";
      clear(result);
      return;
    }
    error.textContent = "";
    const link = requestUrl(r);
    const share = (navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> }).share;
    clear(
      result,
      h("label", { class: "field-label", for: "req-link" }, "Your payment request link"),
      h("input", { class: "input mono", id: "req-link", readonly: true, value: link, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn btn-primary", id: "req-copy", onclick: () => void copyText(link, "Request link copied") }, icon("copy"), "Copy link"),
        share
          ? h("button", { class: "btn btn-secondary", onclick: () => void share.call(navigator, { title: "Payment request", text: `Please pay ${r.amount} ${r.asset}${r.note ? ` (${r.note})` : ""}`, url: link }).catch(() => undefined) }, icon("link"), "Share")
          : null,
      ),
      h("p", { class: "fine" }, "Send it in a chat, an email or on your invoice. When your payer opens it, Remitsheet offers to add your line to their sheet, so they can pay everyone at once."),
    );
  };

  clear(
    root,
    h(
      "section",
      { class: "card narrow" },
      h("h1", {}, "Request a payment"),
      h("p", { class: "muted" }, "Make a link that asks someone to pay you in MUSD, MEZO or BTC on Mezo. Nothing is stored on a server: everything is inside the link."),
      h("label", { class: "field-label", for: "req-address" }, "Pay to (your address)"),
      address,
      h("div", { class: "req-grid" }, h("div", {}, h("label", { class: "field-label", for: "req-amount" }, "Amount"), amount), h("div", {}, h("label", { class: "field-label", for: "req-asset" }, "Asset"), asset), h("div", {}, h("label", { class: "field-label", for: "req-chain" }, "Network"), network)),
      h("label", { class: "field-label", for: "req-note" }, "Note (optional, shown to the payer)"),
      note,
      h("div", { class: "row-actions" }, h("button", { class: "btn btn-primary", id: "req-make", onclick: make }, icon("link"), "Create link")),
      error,
      result,
    ),
  );
  // Fill in the connected account and its network once the wallet reconnects (it can be a moment late).
  const sync = () => {
    if (!address.value && wallet.account) address.value = wallet.account;
    if (wallet.chainId && chains.some((c) => c.id === wallet.chainId)) network.value = String(wallet.chainId);
  };
  sync();
  return onWalletChange(sync);
}
