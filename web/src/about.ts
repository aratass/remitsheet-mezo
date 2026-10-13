import { CHAINS, DEFAULT_CHAIN, MAX_ROWS, REPO_URL, addressUrl } from "./config";
import { clear, extLink, h, icon } from "./ui";

export function renderAbout(root: HTMLElement): () => void {
  const chain = CHAINS[DEFAULT_CHAIN];
  const section = (title: string, ...body: (Node | string | null)[]) => h("section", { class: "card narrow prose" }, h("h2", {}, title), ...body);
  clear(
    root,
    h(
      "section",
      { class: "hero narrow" },
      h("h1", {}, "How Remitsheet works on Mezo"),
      h(
        "p",
        { class: "lead" },
        "Contractor invoices, bounty winners, grant tranches, payroll: when you owe many people, you end up making dozens of transfers and rebuilding the paperwork by hand. Remitsheet pays the whole list in one Mezo transaction and turns it into documents an accountant can use.",
      ),
    ),
    h(
      "div",
      { class: "how-steps narrow" },
      [
        ["sheet", "1. Paste your sheet", "address, amount, label. Every line is checked: address format and checksum, duplicates, zero amounts, decimals, token and system contract addresses."],
        ["check", "2. Sign once, pay everyone", "For MUSD and MEZO you sign one permit for exactly the batch total, then confirm one transaction. BTC is a single transaction. Everyone is paid, or nobody is."],
        ["printer", "3. Keep the paperwork", "A receipt rebuilt from the chain, printable as PDF, a payment advice link per recipient, and a CSV with USD and EUR values."],
      ].map(([i, t, d]) => h("div", { class: "how-step card" }, icon(i as "sheet", "icon big"), h("h3", {}, t), h("p", {}, d))),
    ),
    section(
      "Why Mezo",
      h(
        "ul",
        {},
        h("li", {}, h("strong", {}, "Spend dollars, keep your Bitcoin. "), "Borrow MUSD against your BTC on Mezo at a fixed rate and pay your team in MUSD instead of selling. The Pay page reads your Mezo Borrow position live (collateral, debt, collateral ratio) and shows what borrowing the shortfall for a batch would do to your ratio before you go to Mezo to borrow it."),
        h("li", {}, h("strong", {}, "One signature. "), "MUSD and the MEZO token both support EIP-2612 permits. Remitsheet asks you to sign a permit for exactly the batch total and uses it in the same transaction, so there is no separate approval, no unlimited allowance, and nothing left approved afterwards."),
        h("li", {}, h("strong", {}, "Three assets. "), "MUSD for payroll and invoices, MEZO for grants and community rewards, and BTC itself, Mezo's gas token. Network fees are paid in BTC and are a few satoshis per batch."),
        h("li", {}, h("strong", {}, "Payment requests. "), "A contractor or grant winner makes a request link with their address, amount and note. When you open it, Remitsheet offers to add that line to your sheet, so you can collect a whole team and pay everyone at once."),
      ),
    ),
    section(
      "Safety",
      h(
        "ul",
        {},
        h("li", {}, h("strong", {}, "No custody. "), "BTC is forwarded within the same call; MUSD and MEZO move directly from your wallet to each recipient. The contract has no balance, no owner, no admin keys, no fees and no upgrades."),
        h("li", {}, h("strong", {}, "All-or-nothing. "), "If any single line fails (for example an address that refuses payments, or the MUSD token contract itself), the whole transaction reverts and nothing is sent. The app simulates the batch first and points at the failing line."),
        h("li", {}, h("strong", {}, "Exact permits. "), "A permit covers exactly the batch total, expires after 30 minutes, and can only move tokens of the wallet that signed it. If someone copies the signature from the mempool and submits it first, the batch still goes through."),
        h("li", {}, h("strong", {}, "Check your addresses. "), "Blockchain payments cannot be reversed. Mixed-case addresses are checked against their checksum, but a valid address of the wrong person cannot be detected."),
        h("li", {}, h("strong", {}, "Verified receipts. "), "Receipts only show events emitted by code whose hash matches Remitsheet, so a look-alike contract cannot fake a receipt."),
      ),
      h("p", { class: "fine" }, "The contract is open source with unit, fuzz, permit and reentrancy tests, but it has not had a professional audit."),
    ),
    section(
      "The accounting export",
      h("p", {}, "One row per payment line plus one row for the network fee: date and time (UTC), transaction hash, block, batch reference, sender, recipient, label, asset, amount, and its USD and EUR value."),
      h(
        "p",
        {},
        "MUSD is valued at 1 USD. BTC is valued at the BTC/USD price of Mezo's PriceFeed (the oracle Mezo Borrow uses) at the block of the payment. USD is converted to EUR with the ECB euro foreign exchange reference rate for the transaction date (or the latest earlier rate on days without one), loaded in your browser from ",
        extLink("https://frankfurter.dev", "Frankfurter"),
        ", with the ECB Data Portal as a fallback. MEZO has no on-chain price, so its rows carry the amount only. Every row names its price and rate sources.",
      ),
    ),
    section(
      "Limits and fees",
      h(
        "ul",
        {},
        h("li", {}, `Up to ${MAX_ROWS} recipients per batch, so a batch always fits in one Mezo block (10 million gas).`),
        h("li", {}, "Amounts have at most 8 decimals (one satoshi for BTC)."),
        h("li", {}, "Remitsheet charges nothing. You pay only Mezo's network fee, in BTC, shown before you confirm."),
        h("li", {}, "Labels stay in your browser and in your files; only addresses, amounts and the reference are on-chain, and they are public."),
      ),
    ),
    section(
      "Open source",
      h("p", {}, "MIT licensed. No backend, no accounts, no tracking: the site is static files talking to your wallet and to Mezo's public RPC."),
      h("p", {}, extLink(REPO_URL, "Source code and tests"), " · ", extLink(addressUrl(chain, chain.remitsheet), "Contract on the Mezo explorer"), " · ", extLink("https://mezo.org/docs/developers/", "Mezo developer docs")),
    ),
  );
  return () => undefined;
}
