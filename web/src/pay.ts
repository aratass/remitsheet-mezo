import { getAddress, keccak256, slice, toHex } from "viem";
import {
  BTC_PRECOMPILE,
  CHAINS,
  DEFAULT_CHAIN,
  INPUT_DECIMALS,
  INPUT_SCALE,
  MAX_ROWS,
  MEZO_TOKEN,
  PERMIT_DOMAINS,
  PRICE_ORACLE_PRECOMPILE,
  TOKEN_DECIMALS,
  supportedChain,
  tokenAddress,
  txUrl,
  type Asset,
  type ChainConfig,
  type Hex,
} from "./config";
import { ERC20_ABI, deploymentStatus, explainError, permitSupported, readClient, signPermit, writeClient } from "./chain";
import { COMFORT_RATIO, debtAfterBorrowing, formatRatio, headroom, liquidationLtv, loadCreditLine, loanToValue, type CreditLine } from "./borrow";
import { parseSheet, payableRows, type Sheet } from "./csv";
import { encodeRef, formatAmount, formatSats, refByteLength, shortAddress, todayLabel } from "./format";
import { CREATE2_FACTORY, REMITSHEET_ABI } from "./generated/remitsheet";
import { navigate, openWalletPicker } from "./main";
import { RECENT_KEY, type RecentBatch } from "./receipt";
import { readRequest, requestLine, type PaymentRequest } from "./request";
import { clear, download, extLink, h, icon, storageGet, storageSet } from "./ui";
import { onWalletChange, switchTo, wallet } from "./wallet";

const DRAFT_KEY = "remitsheet-mezo:draft";
const ASSET_KEY = "remitsheet-mezo:asset";
const ASSETS: Asset[] = ["MUSD", "MEZO", "BTC"];

/** Example rows use addresses nobody controls; they are blocked so they cannot be paid by mistake. */
const EXAMPLE_ADDRESSES = [1, 2, 3, 4, 5].map((i) => getAddress(slice(keccak256(toHex(`remitsheet example ${i}`)), 12)));
const EXAMPLE_LABELS = ["Ana Petrova · logo design", "Jonas K. · backend sprint 41", "Mia Rossi · translation DE", "Grant: docs bounty #12", "Leo Martin · QA October"];
const EXAMPLE_AMOUNTS = ["1200.00", "2450.50", "380.00", "500.00", "715.25"];
export const EXAMPLE_CSV =
  "address,amount,label\n" + EXAMPLE_ADDRESSES.map((a, i) => `${a},${EXAMPLE_AMOUNTS[i]},${EXAMPLE_LABELS[i]}`).join("\n") + "\n";

function blockedAddresses(chain: ChainConfig | undefined): Map<string, string> {
  const m = new Map<string, string>();
  const c = chain ?? CHAINS[DEFAULT_CHAIN];
  m.set(c.remitsheet.toLowerCase(), "This is the Remitsheet contract itself, not a recipient.");
  if (c.musd) m.set(c.musd.toLowerCase(), "This is the MUSD token contract, not a person's wallet. MUSD sent there is refused.");
  m.set(MEZO_TOKEN.toLowerCase(), "This is the MEZO token contract, not a person's wallet.");
  if (c.mezo) m.set(c.mezo.toLowerCase(), "This is the MEZO token contract, not a person's wallet.");
  m.set(BTC_PRECOMPILE.toLowerCase(), "This is Mezo's BTC token contract, not a person's wallet.");
  m.set(PRICE_ORACLE_PRECOMPILE.toLowerCase(), "This is Mezo's price oracle, not a recipient.");
  for (const a of Object.values(c.borrow ?? {})) m.set(String(a).toLowerCase(), "This is a Mezo Borrow system contract, not a recipient.");
  m.set(CREATE2_FACTORY.toLowerCase(), "This is a deployment contract, not a recipient.");
  for (const a of EXAMPLE_ADDRESSES) m.set(a.toLowerCase(), "Example address: replace it with a real recipient.");
  return m;
}

type StepState = "todo" | "active" | "done" | "error";
type TokenRoute = "allowance" | "permit" | "approve";

/** Gas upper bound used before a token batch can be simulated (no allowance yet): Foundry measured
 *  about 30k per MUSD line to a new holder plus about 90k for the permit and fixed costs. */
function tokenGasBound(lines: number): bigint {
  return 150_000n + 40_000n * BigInt(lines);
}

export function renderPay(root: HTMLElement): () => void {
  let text = storageGet<string>(DRAFT_KEY, "");
  let asset: Asset = ASSETS.includes(storageGet<Asset>(ASSET_KEY, "MUSD")) ? storageGet<Asset>(ASSET_KEY, "MUSD") : "MUSD";
  let reference = `Payout ${todayLabel()}`;
  let allowDuplicates = false;
  let sheet: Sheet = parseSheet(text, { blocked: blockedAddresses(supportedChain(wallet.chainId)) });
  let busy = false;
  let quoteSeq = 0;
  let steps: { label: string; state: StepState; detail?: string }[] = [];
  let failure: { message: string; row?: number } | null = null;
  let success: { hash: Hex; chain: ChainConfig; count: number; total: bigint; asset: Asset } | null = null;
  let quote: {
    fee?: bigint;
    feeApprox?: boolean;
    balance?: bigint;
    gasBalance?: bigint;
    contract?: string;
    route?: TokenRoute;
    credit?: CreditLine | null;
    error?: string;
    errorRow?: number;
  } = {};
  let request: PaymentRequest | null = readRequest(new URLSearchParams(location.search));

  // ------------------------------------------------------------------ layout
  const textarea = h("textarea", {
    id: "sheet-input",
    class: "sheet-input mono",
    spellcheck: "false",
    placeholder: "address,amount,label\n0x1234…abcd,120.00,Ana · October invoice\n0x5678…ef01,80.50,Jonas · bug bounty",
    "aria-label": "Payment sheet (CSV)",
  }) as HTMLTextAreaElement;
  textarea.value = text;
  textarea.addEventListener("input", () => setText(textarea.value, false));

  const fileInput = h("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv", class: "visually-hidden", id: "csv-file" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      failure = { message: "That file is larger than 2 MB. A payment sheet should be much smaller." };
      updatePanel();
      return;
    }
    setText(await file.text(), true);
    fileInput.value = "";
  });

  const requestSlot = h("div", { id: "request-slot" });
  const summary = h("div", { class: "summary", id: "sheet-summary" });
  const tableWrap = h("div", { class: "table-wrap", id: "preview" });
  const panel = h("aside", { class: "card pay-panel", id: "pay-panel" });
  const creditSlot = h("div", { id: "credit-slot" });

  clear(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "Pay your whole team in MUSD, without selling your Bitcoin"),
      h(
        "p",
        { class: "lead" },
        "Paste or upload a list of addresses and amounts. Remitsheet checks every line and pays everyone in one Mezo transaction: MUSD and MEZO with a single signature, or BTC. You get a receipt and an accounting export with USD and EUR values.",
      ),
    ),
    requestSlot,
    h(
      "div",
      { class: "pay-grid" },
      h(
        "div",
        { class: "pay-main" },
        h(
          "section",
          { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, h("span", { class: "step-no" }, "1"), "Recipients"), h("span", { class: "hint" }, "CSV: address, amount, optional label")),
          textarea,
          h(
            "div",
            { class: "row-actions" },
            h("label", { class: "btn btn-secondary", for: "csv-file" }, icon("upload"), "Upload CSV"),
            fileInput,
            h("button", { class: "btn btn-ghost", onclick: () => setText(EXAMPLE_CSV, true) }, icon("sheet"), "Load example"),
            h("button", { class: "btn btn-ghost", onclick: () => download("remitsheet-template.csv", "address,amount,label\n") }, icon("download"), "Template"),
            h("button", { class: "btn btn-ghost", id: "clear-btn", onclick: () => setText("", true) }, "Clear"),
          ),
          h(
            "p",
            { class: "fine" },
            h(
              "span",
              {},
              `Amounts use a dot for decimals (up to ${INPUT_DECIMALS} places), no thousands separators. Comma, semicolon or tab separated; a header row is optional. Up to ${MAX_ROWS} recipients per batch. Collect lines from your team with `,
              h("a", { href: "#/request", onclick: (e: Event) => (e.preventDefault(), navigate(location.pathname + location.search + "#/request")) }, "payment request links"),
              ".",
            ),
          ),
        ),
        h(
          "section",
          { class: "card" },
          h("div", { class: "card-head" }, h("h2", {}, h("span", { class: "step-no" }, "2"), "Review"), summary),
          tableWrap,
        ),
        creditSlot,
      ),
      h("div", { class: "pay-side" }, panel),
    ),
  );

  // ------------------------------------------------------------------ behaviour
  function setText(value: string, replaceTextarea: boolean) {
    text = value;
    if (replaceTextarea) textarea.value = value;
    storageSet(DRAFT_KEY, value);
    success = null;
    failure = null;
    reparse();
  }

  function reparse() {
    sheet = parseSheet(text, { blocked: blockedAddresses(supportedChain(wallet.chainId)) });
    updateTable();
    updatePanel();
    void refreshQuote();
  }

  function setAsset(a: Asset) {
    asset = a;
    storageSet(ASSET_KEY, a);
    success = null;
    failure = null;
    updateTable();
    updatePanel();
    void refreshQuote();
  }

  function drawRequest() {
    if (!request) {
      clear(requestSlot);
      return;
    }
    const r = request;
    const chainNote = r.chainId && CHAINS[r.chainId] ? ` on ${CHAINS[r.chainId].label}` : "";
    clear(
      requestSlot,
      h(
        "section",
        { class: "card request-banner", id: "request-banner" },
        icon("link", "icon big"),
        h(
          "div",
          { class: "request-text" },
          h("strong", {}, `Payment request: ${r.amount} ${r.asset}${chainNote}`),
          h("span", { class: "mono break" }, r.address),
          r.note ? h("span", { class: "muted" }, `“${r.note}”`) : null,
          h("span", { class: "fine" }, "Anyone can make a request link, so check that you know this address before paying."),
        ),
        h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              class: "btn btn-primary",
              id: "add-request",
              onclick: () => {
                const line = requestLine(r);
                const base = text.trim() ? text.replace(/\s*$/, "\n") : "address,amount,label\n";
                if (asset !== r.asset) setAsset(r.asset);
                dismissRequest();
                setText(base + line + "\n", true);
              },
            },
            icon("sheet"),
            "Add to sheet",
          ),
          h("button", { class: "btn btn-ghost", onclick: () => dismissRequest() }, "Dismiss"),
        ),
      ),
    );
  }

  function dismissRequest() {
    request = null;
    const u = new URL(location.href);
    for (const k of ["pay", "amount", "asset", "note", "chain"]) u.searchParams.delete(k);
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    drawRequest();
  }

  function updateTable() {
    const total = formatAmount(sheet.total, INPUT_DECIMALS);
    const rows = sheet.rows;
    clear(
      summary,
      h("span", { class: "chip" }, `${payableRows(sheet).length} recipient${payableRows(sheet).length === 1 ? "" : "s"}`),
      h("span", { class: "chip" }, `${total} ${asset}`),
      sheet.errorCount ? h("span", { class: "chip chip-error" }, `${sheet.errorCount} with errors`) : null,
      sheet.warningCount ? h("span", { class: "chip chip-warn" }, `${sheet.warningCount} warnings`) : null,
    );
    if (!rows.length) {
      clear(tableWrap, h("div", { class: "empty" }, icon("sheet", "icon big"), h("p", {}, "Your recipients will appear here for review."), h("p", { class: "fine" }, "Tip: export the payout tab of your spreadsheet as CSV and drop it in above.")));
      return;
    }
    const highlight = failure?.row ?? quote.errorRow;
    clear(
      tableWrap,
      h(
        "table",
        { class: "lines" },
        h("thead", {}, h("tr", {}, h("th", { class: "num" }, "Line"), h("th", {}, "Recipient"), h("th", {}, "Label"), h("th", { class: "num" }, `Amount (${asset})`), h("th", { class: "center" }, "Check"))),
        h(
          "tbody",
          {},
          rows.map((r) => {
            const simFailure = highlight === r.line && !r.errors.length ? (failure?.message ?? quote.error ?? "") : "";
            const state = r.errors.length || simFailure ? "bad" : r.warnings.length ? "warn" : "";
            const main = h(
              "tr",
              { class: state, "data-line": r.line, ...(highlight === r.line ? { id: "failing-row" } : {}) },
              h("td", { class: "num muted" }, r.line),
              h("td", { class: "mono addr", title: r.address ?? r.addressText }, r.address ? r.address : r.addressText || "—"),
              h("td", { class: "label-cell" }, r.label || h("span", { class: "muted" }, "—")),
              h("td", { class: "num mono" }, r.amount ? formatAmount(r.amount, INPUT_DECIMALS) : r.amountText || "—"),
              h(
                "td",
                { class: "center" },
                r.errors.length || simFailure
                  ? h("span", { class: "status-bad", title: "Error" }, icon("alert"))
                  : r.warnings.length
                    ? h("span", { class: "status-warn", title: "Warning" }, icon("info"))
                    : h("span", { class: "status-ok", title: "OK" }, icon("check")),
              ),
            );
            if (!state) return main;
            const messages = [...r.errors, ...(simFailure ? [simFailure] : []), ...r.warnings].join(" ");
            return [main, h("tr", { class: `msg-row ${state}` }, h("td", {}), h("td", { colspan: 4 }, messages))];
          }),
        ),
        h(
          "tfoot",
          {},
          h("tr", {}, h("td", {}), h("td", { colspan: 2 }, "Total"), h("td", { class: "num mono" }, formatAmount(sheet.total, INPUT_DECIMALS)), h("td", {})),
        ),
      ),
    );
    document.getElementById("failing-row")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function removeErrorLines() {
    const bad = new Set(sheet.rows.filter((r) => r.errors.length).map((r) => r.line));
    const lines = text.replace(/\r/g, "").split("\n");
    setText(lines.filter((_, i) => !bad.has(i + 1)).join("\n"), true);
  }

  function hasDuplicates() {
    return sheet.rows.some((r) => r.warnings.some((w) => /more than once/.test(w)));
  }

  function refBytesOk() {
    return refByteLength(reference.trim()) <= 32;
  }

  /** Total of the payable lines in 18-decimal base units. */
  function totalBase() {
    return sheet.total * INPUT_SCALE;
  }

  async function refreshQuote() {
    const seq = ++quoteSeq;
    const chain = supportedChain(wallet.chainId);
    const rows = payableRows(sheet);
    if (!wallet.account || !chain) {
      quote = {};
      updatePanel();
      drawCredit();
      return;
    }
    const account = wallet.account;
    const pc = readClient(chain);
    const next: typeof quote = {};
    try {
      const status = await deploymentStatus(chain);
      next.contract = status;
      next.gasBalance = await pc.getBalance({ address: account });
      const token = tokenAddress(chain, asset);
      if (asset === "BTC") next.balance = next.gasBalance;
      else if (token) next.balance = (await pc.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account] })) as bigint;
      if (asset === "MUSD" && chain.borrow) {
        try {
          next.credit = await loadCreditLine(chain, account);
        } catch {
          next.credit = null;
        }
      }

      if (status === "live" && rows.length && !sheet.errorCount) {
        const gasPrice = await pc.getGasPrice();
        const to = rows.map((r) => r.address);
        const amounts = rows.map((r) => r.amount * INPUT_SCALE);
        const total = amounts.reduce((a, b) => a + b, 0n);
        const ref = encodeRef(refBytesOk() ? reference : "");
        if (asset === "BTC") {
          const gas = await pc.estimateContractGas({ address: chain.remitsheet, abi: REMITSHEET_ABI, functionName: "payNative", args: [to, amounts, ref], value: total, account });
          next.fee = gas * gasPrice;
        } else if (token) {
          const allowance = (await pc.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, chain.remitsheet] })) as bigint;
          if (allowance >= total) {
            next.route = "allowance";
            const gas = await pc.estimateContractGas({ address: chain.remitsheet, abi: REMITSHEET_ABI, functionName: "payToken", args: [token, to, amounts, ref], account });
            next.fee = gas * gasPrice;
          } else {
            next.route = (await permitSupported(chain, token, PERMIT_DOMAINS[asset as "MUSD" | "MEZO"])) ? "permit" : "approve";
            // Before the permit is signed the batch cannot be simulated; use a conservative upper bound.
            next.fee = tokenGasBound(rows.length) * gasPrice;
            next.feeApprox = true;
          }
        }
      }
    } catch (err) {
      const explained = explainError(err, rows.map((r) => r.line), asset);
      next.error = explained.message;
      next.errorRow = explained.row;
    }
    if (seq !== quoteSeq) return;
    const rowChanged = quote.errorRow !== next.errorRow;
    quote = next;
    if (rowChanged) updateTable();
    updatePanel();
    drawCredit();
  }

  function stepList() {
    return h(
      "ol",
      { class: "steps" },
      steps.map((s) =>
        h(
          "li",
          { class: `step step-${s.state}` },
          s.state === "active" ? icon("spinner", "icon spin") : s.state === "done" ? icon("check") : s.state === "error" ? icon("alert") : h("span", { class: "step-dot" }),
          h("span", {}, s.label, s.detail ? h("span", { class: "step-detail" }, s.detail) : null),
        ),
      ),
    );
  }

  function feeText(): string {
    if (quote.fee === undefined) return wallet.account ? "—" : "connect to estimate";
    return `${quote.feeApprox ? "≤ " : "≈ "}${formatSats(quote.fee)} (BTC)`;
  }

  function updatePanel() {
    const chain = supportedChain(wallet.chainId);
    const rows = payableRows(sheet);
    const shown = chain ?? CHAINS[DEFAULT_CHAIN];
    const assetButtons = h(
      "div",
      { class: "segmented seg-3", role: "radiogroup", "aria-label": "Asset" },
      ASSETS.map((a) =>
        h(
          "button",
          {
            class: asset === a ? "seg active" : "seg",
            role: "radio",
            "aria-checked": String(asset === a),
            "data-asset": a,
            disabled: busy || (a !== "BTC" && !tokenAddress(shown, a)),
            onclick: () => setAsset(a),
          },
          h("strong", {}, a),
          h("small", {}, a === "BTC" ? "1 transaction" : "1 signature + 1 tx"),
        ),
      ),
    );
    const refInput = h("input", { id: "ref-input", class: "input", value: reference, maxlength: 64, disabled: busy, "aria-label": "Batch reference" }) as HTMLInputElement;
    const refCounter = h("span", { class: refBytesOk() ? "fine" : "fine error" }, `${refByteLength(reference.trim())}/32 bytes · stored on-chain with the batch`);
    refInput.addEventListener("input", () => {
      reference = refInput.value;
      refCounter.textContent = `${refByteLength(reference.trim())}/32 bytes · stored on-chain with the batch`;
      refCounter.className = refBytesOk() ? "fine" : "fine error";
      payBtn.toggleAttribute("disabled", !canPay());
    });

    const dupBox = hasDuplicates()
      ? h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: allowDuplicates,
            disabled: busy,
            onchange: (e: Event) => {
              allowDuplicates = (e.target as HTMLInputElement).checked;
              payBtn.toggleAttribute("disabled", !canPay());
            },
          }),
          "Some addresses appear more than once. Pay each line anyway.",
        )
      : null;

    const total = totalBase();
    const lines: (HTMLElement | null)[] = [
      h("div", { class: "kv" }, h("span", {}, "Recipients"), h("strong", {}, String(rows.length))),
      h("div", { class: "kv" }, h("span", {}, "Total"), h("strong", { class: "mono", id: "total-amount" }, `${formatAmount(sheet.total, INPUT_DECIMALS)} ${asset}`)),
      h("div", { class: "kv" }, h("span", {}, "Network fee"), h("span", { class: "mono", id: "fee-estimate" }, feeText())),
      wallet.account && quote.balance !== undefined
        ? h("div", { class: "kv" }, h("span", {}, `Your ${asset} balance`), h("span", { class: "mono", id: "asset-balance" }, `${formatAmount(quote.balance, TOKEN_DECIMALS, 2, asset === "BTC" ? 8 : 2)} ${asset}`))
        : null,
    ];

    const needed = asset === "BTC" ? total + (quote.fee ?? 0n) : total;
    const faucet = chain?.faucetUrl;
    const short =
      !success && quote.balance !== undefined && total > 0n && quote.balance < needed
        ? h(
            "span",
            {},
            `Not enough ${asset}: you need ${formatAmount(needed, TOKEN_DECIMALS, 2, asset === "BTC" ? 8 : 2)}${asset === "BTC" ? " including the fee" : ""}.`,
            asset === "MUSD" && chain?.borrowUrl ? " You can borrow MUSD against your BTC on Mezo (see below)." : "",
            asset !== "MUSD" && faucet ? h("span", {}, " Test BTC and MEZO: ", extLink(faucet, "Mezo faucet"), ".") : null,
          )
        : asset !== "BTC" && quote.gasBalance !== undefined && quote.fee !== undefined && quote.gasBalance < quote.fee
          ? h("span", {}, "You also need a little BTC on Mezo to pay the network fee.", faucet ? h("span", {}, " Get test BTC from the ", extLink(faucet, "Mezo faucet"), ".") : null)
          : null;

    const payBtn = h(
      "button",
      { class: "btn btn-primary btn-lg", id: "pay-btn", disabled: !canPay(), onclick: () => void execute() },
      busy ? icon("spinner", "icon spin") : icon("check"),
      rows.length ? `Pay ${rows.length} recipient${rows.length === 1 ? "" : "s"}` : "Pay",
    );

    let action: HTMLElement;
    if (!wallet.account) {
      action = h("button", { class: "btn btn-primary btn-lg", onclick: () => openWalletPicker() }, icon("wallet"), "Connect wallet to pay");
    } else if (!chain) {
      action = h("button", { class: "btn btn-warn btn-lg", onclick: () => void switchTo(CHAINS[DEFAULT_CHAIN]).catch(() => undefined) }, icon("alert"), `Switch wallet to ${CHAINS[DEFAULT_CHAIN].label}`);
    } else if (quote.contract === "missing") {
      action = h(
        "div",
        { class: "notice notice-warn" },
        icon("info"),
        h("span", {}, `Remitsheet is not deployed on ${chain.label} yet. `, h("a", { href: "#/deploy" }, "Deploy it in one click"), "."),
      );
    } else if (quote.contract === "foreign") {
      action = h("div", { class: "notice notice-bad" }, icon("alert"), "The contract at the configured address is not Remitsheet. Payments are disabled.");
    } else {
      action = payBtn;
    }

    const howText =
      asset === "BTC"
        ? "All-or-nothing: either every line is paid in this one transaction, or nothing moves. Remitsheet never holds your funds."
        : quote.route === "approve"
          ? `This ${asset} token has no usable permit here, so the app asks for an approval of the exact total first, then the batch. All-or-nothing.`
          : `You sign one permit for exactly the batch total (free, no gas), then confirm one transaction. ${asset} moves straight from your wallet to each recipient and no approval is left behind. All-or-nothing.`;

    const focused = document.activeElement as HTMLInputElement | null;
    const keepFocus = focused?.id === "ref-input" ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
    clear(
      panel,
      h("h2", {}, h("span", { class: "step-no" }, "3"), "Pay"),
      h("label", { class: "field-label" }, "Asset"),
      assetButtons,
      h("label", { class: "field-label", for: "ref-input" }, "Reference"),
      refInput,
      refCounter,
      h("div", { class: "kvs" }, lines),
      sheet.errorCount
        ? h(
            "div",
            { class: "notice notice-bad" },
            icon("alert"),
            h("span", {}, `${sheet.errorCount} line${sheet.errorCount === 1 ? " has" : "s have"} errors. Fix ${sheet.errorCount === 1 ? "it" : "them"} or `, h("button", { class: "link-btn", onclick: removeErrorLines }, "remove those lines"), "."),
          )
        : null,
      short ? h("div", { class: "notice notice-warn", id: "short-notice" }, icon("alert"), short) : null,
      quote.error && !failure && !success ? h("div", { class: "notice notice-warn", id: "quote-error" }, icon("info"), quote.error) : null,
      dupBox,
      steps.length ? stepList() : null,
      failure ? h("div", { class: "notice notice-bad", id: "pay-error" }, icon("alert"), failure.message) : null,
      success ? successBox(success) : action,
      h("p", { class: "fine" }, icon("shield"), howText),
    );
    if (keepFocus) {
      refInput.focus();
      refInput.setSelectionRange(keepFocus.start, keepFocus.end);
    }
  }

  /** Mezo Borrow panel: shown for MUSD payouts when the network has the borrowing contracts. */
  function drawCredit() {
    const chain = supportedChain(wallet.chainId);
    const line = quote.credit;
    if (asset !== "MUSD" || !chain?.borrow || !wallet.account || line === undefined) {
      clear(creditSlot);
      return;
    }
    const borrowLink = chain.borrowUrl ? extLink(chain.borrowUrl, h("span", {}, "Borrow MUSD on Mezo ", icon("external")), "btn btn-secondary") : null;
    if (line === null) {
      clear(creditSlot, h("section", { class: "card credit", id: "credit-line" }, h("h3", {}, "Your Bitcoin credit line"), h("p", { class: "fine" }, "Could not read Mezo Borrow right now."), borrowLink));
      return;
    }
    const usd = (wei: bigint) => formatAmount((wei * line.price) / 10n ** 18n, 18, 0, 0);
    const shortfall = quote.balance !== undefined && totalBase() > quote.balance ? totalBase() - quote.balance : 0n;
    const rows: (HTMLElement | null)[] = [
      h("div", { class: "kv" }, h("span", {}, "BTC price (Mezo oracle)"), h("span", { class: "mono", id: "btc-price" }, `$${formatAmount(line.price, 18, 0, 0)}`)),
    ];
    let body: (HTMLElement | string | null)[] = [];
    if (line.active) {
      const ltv = loanToValue(line.coll, line.debt, line.price);
      const room = headroom(line);
      const comfortLtv = liquidationLtv(COMFORT_RATIO);
      rows.push(
        h("div", { class: "kv" }, h("span", {}, "Collateral"), h("span", { class: "mono" }, `${formatAmount(line.coll, 18, 4, 8)} BTC (≈ $${usd(line.coll)})`)),
        h("div", { class: "kv" }, h("span", {}, "Debt"), h("span", { class: "mono" }, `${formatAmount(line.debt, 18, 2, 2)} MUSD`)),
        h("div", { class: "kv" }, h("span", {}, "Loan-to-value"), h("strong", { class: "mono", id: "credit-ltv" }, formatRatio(ltv))),
        h("div", { class: "kv" }, h("span", {}, `Room to borrow up to ${formatRatio(comfortLtv).replace(/\.0%$/, "%")}`), h("span", { class: "mono", id: "credit-room" }, `${formatAmount(room, 18, 2, 2)} MUSD`)),
      );
      if (shortfall > 0n) {
        const after = loanToValue(line.coll, debtAfterBorrowing(line, shortfall), line.price);
        const risky = after > comfortLtv;
        body = [
          h(
            "div",
            { class: risky ? "notice notice-warn" : "notice", id: "credit-advice" },
            icon(risky ? "alert" : "info"),
            `This batch needs ${formatAmount(shortfall, 18, 2, 2)} MUSD more than you hold. Borrowing it on Mezo would move your loan-to-value from ${formatRatio(ltv)} to ${formatRatio(after)}${risky ? `, above the ${formatRatio(comfortLtv).replace(/\.0%$/, "%")} we suggest` : ""}.`,
          ),
        ];
      }
    } else {
      body = [
        h(
          "p",
          { class: "fine", id: "credit-none" },
          `No Mezo loan on this address yet. Mezo lets you borrow MUSD against BTC at a fixed rate instead of selling it (smallest loan ${formatAmount(line.minNetDebt, 18, 0, 0)} MUSD, one-off fee ${formatRatio(line.borrowingRate * 100n).replace(/\.0%$/, "%")}).`,
        ),
      ];
    }
    clear(
      creditSlot,
      h(
        "section",
        { class: "card credit", id: "credit-line" },
        h("h3", {}, "Your Bitcoin credit line"),
        h("div", { class: "kvs" }, rows),
        ...body,
        borrowLink,
        h("p", { class: "fine" }, `Read live from Mezo Borrow. A loan is liquidated above ${formatRatio(liquidationLtv(line.mcr))} loan-to-value, so keep a buffer.`),
      ),
    );
  }

  function successBox(s: NonNullable<typeof success>) {
    const dev = new URLSearchParams(location.search).has("dev") ? "&dev=1" : "";
    const receiptHref = `${location.pathname}?tx=${s.hash}&chain=${s.chain.id}${dev}`;
    return h(
      "div",
      { class: "success", id: "pay-success" },
      h("div", { class: "success-head" }, icon("check", "icon big"), h("div", {}, h("strong", {}, `Paid ${s.count} recipient${s.count === 1 ? "" : "s"}`), h("span", {}, `${formatAmount(s.total, INPUT_DECIMALS)} ${s.asset} · confirmed on ${s.chain.label}`))),
      h(
        "div",
        { class: "row-actions" },
        h("a", { class: "btn btn-primary", id: "open-receipt", href: receiptHref, onclick: (e: Event) => (e.preventDefault(), navigate(receiptHref)) }, "Open receipt"),
        txUrl(s.chain, s.hash) ? extLink(txUrl(s.chain, s.hash), h("span", {}, "Explorer ", icon("external")), "btn btn-secondary") : null,
      ),
      h("p", { class: "fine mono break" }, s.hash),
    );
  }

  /** False when the wallet is known to hold less than the batch needs (BTC includes the fee). */
  function balanceOk() {
    if (quote.balance === undefined) return true;
    const needed = asset === "BTC" ? totalBase() + (quote.fee ?? 0n) : totalBase();
    return quote.balance >= needed;
  }

  function canPay() {
    return (
      !busy &&
      balanceOk() &&
      !!wallet.account &&
      !!supportedChain(wallet.chainId) &&
      quote.contract === "live" &&
      quote.errorRow === undefined &&
      payableRows(sheet).length > 0 &&
      sheet.errorCount === 0 &&
      refBytesOk() &&
      (!hasDuplicates() || allowDuplicates)
    );
  }

  function setStep(i: number, state: StepState, detail?: string) {
    steps[i] = { ...steps[i], state, detail };
    updatePanel();
  }

  async function execute() {
    const chain = supportedChain(wallet.chainId);
    if (!chain || !wallet.account || !canPay()) return;
    const rows = payableRows(sheet);
    const lines = rows.map((r) => r.line);
    const to = rows.map((r) => r.address);
    const labels = rows.map((r) => r.label);
    const amounts = rows.map((r) => r.amount * INPUT_SCALE);
    const total = amounts.reduce((a, b) => a + b, 0n);
    const ref = encodeRef(reference);
    const pc = readClient(chain);
    const wc = writeClient(chain);
    const account = wallet.account;
    const payAsset = asset;
    busy = true;
    failure = null;
    success = null;
    const settle = `Settle on ${chain.label}`;
    let route: TokenRoute | "native" = "native";
    const token = tokenAddress(chain, payAsset);
    if (payAsset !== "BTC" && token) {
      const allowance = (await pc.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account, chain.remitsheet] }).catch(() => 0n)) as bigint;
      route = allowance >= total ? "allowance" : (await permitSupported(chain, token, PERMIT_DOMAINS[payAsset as "MUSD" | "MEZO"])) ? "permit" : "approve";
    }
    steps =
      route === "native" || route === "allowance"
        ? [{ label: "Check every line", state: "todo" }, { label: "Confirm in your wallet", state: "todo" }, { label: settle, state: "todo" }]
        : route === "permit"
          ? [{ label: `Sign a permit for exactly ${formatAmount(sheet.total, INPUT_DECIMALS)} ${payAsset} (free)`, state: "todo" }, { label: "Check every line", state: "todo" }, { label: "Confirm in your wallet", state: "todo" }, { label: settle, state: "todo" }]
          : [{ label: `Approve ${payAsset} (exact total)`, state: "todo" }, { label: "Check every line", state: "todo" }, { label: "Confirm in your wallet", state: "todo" }, { label: settle, state: "todo" }];
    updatePanel();
    let i = 0;
    try {
      let hash: Hex;
      if (route === "native") {
        setStep(i, "active");
        const { request: req } = await pc.simulateContract({ address: chain.remitsheet, abi: REMITSHEET_ABI, functionName: "payNative", args: [to, amounts, ref], value: total, account });
        setStep(i++, "done");
        setStep(i, "active");
        hash = await wc.writeContract({ ...req, account, chain: wc.chain });
      } else if (route === "permit") {
        setStep(i, "active", "check your wallet");
        const sig = await signPermit(chain, token!, PERMIT_DOMAINS[payAsset as "MUSD" | "MEZO"], total);
        setStep(i++, "done", "signed");
        setStep(i, "active");
        const { request: req } = await pc.simulateContract({
          address: chain.remitsheet,
          abi: REMITSHEET_ABI,
          functionName: "payTokenWithPermit",
          args: [token!, to, amounts, ref, sig.deadline, sig.v, sig.r, sig.s],
          account,
        });
        setStep(i++, "done");
        setStep(i, "active");
        hash = await wc.writeContract({ ...req, account, chain: wc.chain });
      } else {
        if (route === "approve") {
          setStep(i, "active");
          const approveHash = await wc.writeContract({ address: token!, abi: ERC20_ABI, functionName: "approve", args: [chain.remitsheet, total], account, chain: wc.chain });
          setStep(i, "active", "waiting for confirmation");
          const r = await pc.waitForTransactionReceipt({ hash: approveHash });
          if (r.status !== "success") throw new Error(`The ${payAsset} approval failed on-chain.`);
          setStep(i++, "done", "approved");
        }
        setStep(i, "active");
        const { request: req } = await pc.simulateContract({ address: chain.remitsheet, abi: REMITSHEET_ABI, functionName: "payToken", args: [token!, to, amounts, ref], account });
        setStep(i++, "done");
        setStep(i, "active");
        hash = await wc.writeContract({ ...req, account, chain: wc.chain });
      }
      setStep(i++, "done");
      setStep(i, "active", shortAddress(hash));
      storageSet(`remitsheet-mezo:labels:${hash.toLowerCase()}`, labels);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction was included but reverted, so nothing was paid. Only the network fee was charged.");
      setStep(i, "done", `block ${receipt.blockNumber}`);
      success = { hash, chain, count: rows.length, total: sheet.total, asset: payAsset };
      storageSet(DRAFT_KEY, "");
      const recent = storageGet<RecentBatch[]>(RECENT_KEY, []).filter((r) => r.hash !== hash);
      recent.unshift({ hash, chainId: chain.id, timestamp: Math.floor(Date.now() / 1000), count: rows.length, total: formatAmount(sheet.total, INPUT_DECIMALS), asset: payAsset, ref: reference.trim() });
      storageSet(RECENT_KEY, recent.slice(0, 50));
    } catch (err) {
      const explained = explainError(err, lines, payAsset);
      failure = explained;
      const active = steps.findIndex((s) => s.state === "active");
      if (active >= 0) steps[active] = { ...steps[active], state: "error" };
      if (explained.row) updateTable();
    } finally {
      busy = false;
      updatePanel();
      if (!success) void refreshQuote();
    }
  }

  drawRequest();
  updateTable();
  updatePanel();
  void refreshQuote();
  const off = onWalletChange(() => {
    reparse();
  });
  return () => off();
}


