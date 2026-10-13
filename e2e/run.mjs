// End-to-end test: local Anvil node + the built site (docs/) + an injected EIP-6963 test wallet.
// Deploys Remitsheet through the CREATE2 factory from the Deploy page, shows the Mezo Borrow credit line
// for a MUSD batch that is short, pays a 5-recipient MUSD batch with one permit signature, opens and
// prints the receipt, exports the accounting CSV, opens a per-recipient payment advice, pays a MEZO batch
// (Mezo-precompile-style permit) and a BTC batch, creates and opens a payment request link, and checks
// that a failing recipient is caught before sending.
// Test tokens: TestMUSD (OpenZeppelin ERC20Permit, same name, domain and transfer rules as MUSD) and
// TestMEZO (bool-returning permit that only accepts v = 27 or 28, like Mezo's precompiled MEZO token).
// Screenshots (1280x800) go to submission/screenshots/, other output to e2e/output/.
//
// Usage: npm run build && npm run test:e2e   (needs `anvil` on PATH or ANVIL=/path/to/anvil)
// DEMO=1 runs the same flow slowly with captions and writes submission/demo-local-chain.mp4.
// PITCH=1 is the demo cut used inside the pitch video: 1280x720, deployed by script, caption timings from
// TTS_JSON (spoken caption lengths), and a caption timeline written next to the video (PITCH_OUT).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { concat, createPublicClient, createWalletClient, getAddress, http, keccak256, slice, toHex } from "viem";
import { foundry } from "viem/chains";
import { startServer } from "../scripts/serve.mjs";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}e2e/output`;
const shots = `${root}submission/screenshots`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(shots, { recursive: true });

const PITCH = !!process.env.PITCH;
const DEMO = !!process.env.DEMO || PITCH;
const TTS = process.env.TTS_JSON ? JSON.parse(readFileSync(process.env.TTS_JSON, "utf8")) : {};
const VIEW = PITCH ? { width: 1280, height: 720 } : { width: 1280, height: 800 };
const RPC = "http://127.0.0.1:8545";
const SITE = "http://127.0.0.1:4173";
const PAYER = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"); // Anvil dev account 0
const FX = { amount: 1.0, base: "EUR", date: "2026-10-09", rates: { USD: 1.1206 } }; // published ECB rate for 9 Oct 2026
const BTC_PRICE = 83_153_555160000000000000n; // USD per BTC, 18 decimals: Mezo testnet PriceFeed on 13 Oct 2026
const E18 = 10n ** 18n;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
}

const addr = (seed) => getAddress(slice(keccak256(toHex(seed)), 12));
const artifact = (file, name) => JSON.parse(readFileSync(`${root}contracts/out/${file}/${name}.json`, "utf8"));

// ------------------------------------------------------------------ chain
// Base fee at Mezo mainnet's gas price (about 1.46 million wei per gas on 13 Oct 2026), so fees look real.
const anvil = spawn(process.env.ANVIL || "anvil", ["--port", "8545", "--chain-id", "31337", "--silent", "--block-base-fee-per-gas", "1462500"], { stdio: "inherit" });
const pc = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 100 });
const wc = createWalletClient({ chain: foundry, transport: http(RPC), account: PAYER });
for (let i = 0; ; i++) {
  try {
    await pc.getChainId();
    break;
  } catch {
    if (i > 50) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const deployed = async (file, name, args = []) => {
  const a = artifact(file, name);
  const hash = await wc.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return { address: (await pc.waitForTransactionReceipt({ hash })).contractAddress, abi: a.abi };
};
const send = async (c, functionName, args) => pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: c.address, abi: c.abi, functionName, args }) });

const musd = await deployed("MezoTokens.sol", "TestMUSD");
const mezo = await deployed("MezoTokens.sol", "TestMEZO");
const troveManager = await deployed("MezoBorrowMocks.sol", "MockTroveManager");
const priceFeed = await deployed("MezoBorrowMocks.sol", "MockPriceFeed", [BTC_PRICE]);
const borrowerOperations = await deployed("MezoBorrowMocks.sol", "MockBorrowerOperations");
const rejecting = await deployed("Mocks.sol", "RejectingRecipient");
await send(musd, "mint", [PAYER, 3_000n * E18]);
await send(mezo, "mint", [PAYER, 50_000n * E18]);
// A Mezo loan of 3,000 MUSD against 0.2 BTC (about 16,630 USD): loan-to-value 18%.
await send(troveManager, "setTrove", [PAYER, 2n * 10n ** 17n, 3_000n * E18, 0n]);
const deployment = JSON.parse(readFileSync(`${root}contracts/deployment.json`, "utf8"));
check("Remitsheet not deployed before the test", (await pc.getCode({ address: deployment.address })) === undefined);

// ------------------------------------------------------------------ site + browser
const server = await startServer(`${root}docs`, 4173);
const browser = await chromium.launch({ slowMo: DEMO ? 90 : 0 });
const context = await browser.newContext({
  viewport: VIEW,
  acceptDownloads: true,
  recordVideo: { dir: `${out}/video`, size: VIEW },
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE });
let signatureRequests = 0;
await context.exposeFunction("__e2eRpc", async (method, params) => {
  if (method === "eth_signTypedData_v4") signatureRequests++;
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  });
  return res.json();
});
await context.addInitScript(({ account }) => {
  const listeners = {};
  const provider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "wallet_switchEthereumChain") {
        if (params?.[0]?.chainId === "0x7a69") return null;
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      }
      if (method === "wallet_addEthereumChain") throw Object.assign(new Error("Test wallet: local chain only"), { code: 4001 });
      // Mezo mainnet fee levels on 13 Oct 2026: gas price 1,462,500 wei, priority fee 162,500 wei.
      if (method === "eth_gasPrice") return "0x1650e4";
      if (method === "eth_maxPriorityFeePerGas") return "0x27ac4";
      if (method === "eth_sendTransaction" && params?.[0] && !params[0].gasPrice && !params[0].maxFeePerGas) {
        params = [{ ...params[0], maxFeePerGas: "0x2dc6c0", maxPriorityFeePerGas: "0x27ac4" }]; // 3,000,000 and 162,500 wei
      }
      const res = await window.__e2eRpc(method, params ?? []);
      if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code, data: res.error.data });
      return res.result;
    },
    on(ev, fn) {
      (listeners[ev] ||= []).push(fn);
    },
    removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
  };
  const icon =
    "data:image/svg+xml;base64," +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#334155"/><path d="M9 16h14M16 9v14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>');
  const info = { uuid: "4f1b2c3d-0000-4000-8000-00000000e2e0", name: "Test Wallet (local Anvil)", icon, rdns: "dev.remitsheet.testwallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, { account: PAYER });
await context.addInitScript(() => {
  window.__caption = (text) => {
    let el = document.getElementById("__caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__caption";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:1040px;padding:14px 22px;border-radius:14px;background:rgba(15,23,42,.92);color:#fff;font:600 21px/1.35 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = text ? "block" : "none";
  };
});
const localConfig = {
  chains: {
    31337: {
      musd: musd.address,
      mezo: mezo.address,
      borrow: { troveManager: troveManager.address, priceFeed: priceFeed.address, borrowerOperations: borrowerOperations.address },
      borrowUrl: "https://testnet.mezo.org",
    },
  },
};
await context.route("**/config.json", (route) => route.fulfill({ json: localConfig }));
let fxRequests = 0;
await context.route("https://api.frankfurter.dev/**", (route) => {
  fxRequests++;
  return route.fulfill({ json: FX, headers: { "access-control-allow-origin": "*" } });
});

const page = await context.newPage();
const t0 = Date.now(); // the recording starts with the page
const timeline = [];
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const blockedHere = []; // public Mezo RPC calls made before the test wallet connects; this sandbox has no route to mezo.org
page.on("requestfailed", (r) => {
  const host = new URL(r.url()).hostname;
  if (/mezo\.org$|boar\.network$/.test(host)) blockedHere.push(host);
  else pageErrors.push(`request failed: ${r.url()}`);
});
page.on("console", (m) => m.type() === "error" && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(m.text()) && pageErrors.push(m.text()));
// Screenshots are only taken in the normal run; captions and pauses only appear in DEMO and PITCH mode.
const shot = async (name) => {
  if (DEMO) return;
  await page.screenshot({ path: `${shots}/${name}.png` });
};
const say = async (text, ms = 2600, { pitch = true } = {}) => {
  if (!DEMO || (PITCH && !pitch)) return;
  await page.evaluate((t) => window.__caption(t), text);
  const spoken = TTS[text]?.dur;
  if (PITCH && spoken) timeline.push({ text, t: Date.now() - t0 });
  await page.waitForTimeout(PITCH && spoken ? Math.round(spoken * 1000) + 350 : ms);
};
const csvRows = (raw) => raw.replace(/^﻿/, "").trim().split(/\r?\n/);
const exportCsv = async (name) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  const path = `${out}/${name}`;
  await download.saveAs(path);
  return readFileSync(path, "utf8");
};

try {
  // ---------------------------------------------------------------- 1. deploy
  if (PITCH) {
    // The pitch video skips the Deploy page: deploy through the CREATE2 factory directly, then connect.
    await pc.waitForTransactionReceipt({ hash: await wc.sendTransaction({ to: deployment.create2Factory, data: concat([deployment.salt, artifact("Remitsheet.sol", "Remitsheet").bytecode.object]) }) });
    await page.goto(`${SITE}/?dev=1`);
    await page.click("#connect-btn");
    await page.click("text=Test Wallet (local Anvil)");
    await page.waitForSelector("#pay-btn");
    await say("Recorded on a local test chain with test tokens. The live app runs on Mezo testnet");
  } else {
    if (DEMO) {
      await page.goto(`${SITE}/?dev=1`);
      await say("Remitsheet for Mezo: pay your whole team in MUSD, without selling your Bitcoin", 4200);
      await say("This walkthrough runs on a local test chain with test tokens; the live app runs on Mezo testnet", 3600);
    }
    await page.goto(`${SITE}/?dev=1#/deploy`);
    await say("Deploy once: an ownerless contract, same address on every chain", 2800);
    await page.click("#connect-btn");
    await page.click("text=Test Wallet (local Anvil)");
    await page.waitForSelector("#deploy-btn");
    await page.waitForFunction(() => /sat/.test(document.querySelector("#deploy-fee")?.textContent || ""));
    await shot("01-deploy");
    await page.click("#deploy-btn");
    await page.waitForSelector("#deploy-live", { timeout: 30000 });
    await say("Deployed, and the code hash is verified before the app uses it", 2600);
    await shot("02-deployed");
  }
  const code = await pc.getCode({ address: deployment.address });
  check("contract deployed at the predicted CREATE2 address", keccak256(code) === deployment.runtimeCodeHash, deployment.address);

  // ---------------------------------------------------------------- 2. validation
  if (!PITCH) await page.click("a.nav-link:has-text('Pay')");
  const bad = [
    "address,amount,label",
    `${addr("r1")},120.00,Ana Petrova - logo design`,
    `0x${addr("r2").slice(2).replace(/[a-fA-F]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))},50,Typo in address`,
    `${addr("r1")},10,Same person twice`,
    `${addr("r3")},0,Nothing`,
    `${addr("r4")},12.123456789,Too precise`,
    `${musd.address},5,MUSD token contract`,
  ].join("\n");
  await page.fill("#sheet-input", bad);
  await page.waitForSelector(".chip-error");
  await page.evaluate(() => window.scrollTo(0, 560));
  await say("Paste or upload a CSV. Every line is checked: checksums, duplicates, decimals, token contracts", 4600);
  await shot("03-validation");
  const errorRows = await page.locator("tr.bad:not(.msg-row)").count();
  check("validation flags bad lines", errorRows === 4, `${errorRows} error rows`);

  // ---------------------------------------------------------------- 3. MUSD batch: short, credit line, then one-signature payout
  const musdRows = [
    [addr("alice"), "1200.00", "Ana Petrova · logo design"],
    [addr("bob"), "2450.50", "Jonas K. · backend sprint 41"],
    [addr("carol"), "380.00", "Mia Rossi · translation DE"],
    [addr("dave"), "500.00", "Docs bounty #12"],
    [addr("erin"), "715.25", "Leo Martin · QA October"],
  ];
  await page.fill("#sheet-input", "address,amount,label\n" + musdRows.map((r) => r.join(",")).join("\n"));
  await page.fill("#ref-input", "October contractors");
  await page.waitForSelector("#credit-advice", { timeout: 15000 });
  const ltvBefore = await page.textContent("#credit-ltv");
  const advice = await page.textContent("#credit-advice");
  check("credit line shows the Mezo loan-to-value", ltvBefore.trim() === "18.0%", ltvBefore);
  check("credit line explains the shortfall and the loan-to-value after borrowing it", /2,245\.75 MUSD more/.test(advice) && /18\.0% to 31\.6%/.test(advice), advice);
  check("short notice points at borrowing", /borrow MUSD against your BTC/i.test(await page.textContent("#short-notice")));
  check("Pay is disabled while the MUSD balance is short", await page.isDisabled("#pay-btn"));
  await page.evaluate(() => document.querySelector("#credit-line").scrollIntoView({ block: "center" }));
  await say("Short on MUSD for this payroll? Remitsheet reads your Mezo loan live", 3600);
  await say("and shows what borrowing the missing 2,245.75 MUSD would do to your loan-to-value", 4200);
  await shot("04-credit-line");

  // Simulate borrowing the shortfall on Mezo (on a real network this happens in the Mezo app).
  const borrowed = 2_300n * E18;
  await send(musd, "mint", [PAYER, borrowed]);
  await send(troveManager, "setTrove", [PAYER, 2n * 10n ** 17n, 3_000n * E18 + borrowed + borrowed / 1000n, 0n]);
  await say("Here the borrow is simulated. On Mezo you borrow it in the Mezo app", 3200);
  await page.fill("#sheet-input", "address,amount,label\n" + musdRows.map((r) => r.join(",")).join("\n") + "\n"); // re-read balances
  await page.waitForFunction(() => !document.querySelector("#short-notice") && /≤/.test(document.querySelector("#fee-estimate")?.textContent || ""), null, { timeout: 15000 });
  await shot("05-review");
  check("MUSD has no allowance before paying", (await pc.readContract({ address: musd.address, abi: musd.abi, functionName: "allowance", args: [PAYER, deployment.address] })) === 0n);
  const sigBefore = signatureRequests;
  await page.click("#pay-btn");
  await page.waitForSelector("#pay-success", { timeout: 30000 });
  await page.evaluate(() => document.querySelector("#pay-success").scrollIntoView({ block: "center" }));
  await say("One permit signature for exactly the total, one transaction: every line is paid, or nothing moves", 4200);
  await shot("06-paid");
  check("exactly one signature request (EIP-2612 permit)", signatureRequests - sigBefore === 1, String(signatureRequests - sigBefore));
  for (const [a, amount] of musdRows) {
    const bal = await pc.readContract({ address: musd.address, abi: musd.abi, functionName: "balanceOf", args: [a] });
    const expected = BigInt(Math.round(Number(amount) * 100)) * 10n ** 16n;
    check(`MUSD recipient ${a.slice(0, 8)} received ${amount}`, bal === expected, String(bal));
  }
  check("no MUSD allowance left after the batch", (await pc.readContract({ address: musd.address, abi: musd.abi, functionName: "allowance", args: [PAYER, deployment.address] })) === 0n);
  check("permit nonce used once", (await pc.readContract({ address: musd.address, abi: musd.abi, functionName: "nonces", args: [PAYER] })) === 1n);
  check("contract holds no MUSD", (await pc.readContract({ address: musd.address, abi: musd.abi, functionName: "balanceOf", args: [deployment.address] })) === 0n);

  // ---------------------------------------------------------------- 4. receipt, PDF, CSV
  await page.click("#open-receipt");
  await page.waitForSelector(".receipt-lines tbody tr");
  await say("A receipt rebuilt from the chain: anyone with the link can verify it", 3400);
  if (DEMO) {
    await page.evaluate(() => window.scrollTo(0, 400));
    await say("Prints cleanly to PDF", 2200, { pitch: false });
  }
  const receiptUrl = page.url();
  const txHash = new URL(receiptUrl).searchParams.get("tx");
  const rc = await pc.getTransactionReceipt({ hash: txHash });
  console.log(`MUSD permit batch of 5: gasUsed ${rc.gasUsed}`);
  check("receipt shows 5 lines", (await page.locator(".receipt-lines tbody tr").count()) === 5);
  check("receipt shows labels saved at payment time", (await page.textContent(".receipt-lines")).includes("Mia Rossi"));
  check("receipt shows the batch reference", (await page.textContent(".meta")).includes("October contractors"));
  check("receipt shows MUSD", (await page.textContent(".receipt-total")).includes("MUSD"));
  await shot("07-receipt");
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: `${root}submission/receipt-example.pdf`, format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
  if (DEMO) await page.evaluate(() => window.scrollTo(0, 0));
  const csvRaw = await exportCsv("accounting-musd.csv");
  await say("Accounting CSV with USD and EUR values at the ECB reference rate of the day", 3400);
  check("CSV starts with a UTF-8 byte order mark for spreadsheet apps", csvRaw.charCodeAt(0) === 0xfeff);
  const csv = csvRows(csvRaw);
  writeFileSync(`${root}submission/accounting-example.csv`, csvRaw);
  check("CSV has header + 5 payments + 1 fee row", csv.length === 7, `${csv.length} lines`);
  check("CSV values 1200 MUSD at 1 USD and converts at ECB 1.1206 to 1070.85 EUR", csv[1].includes(",MUSD,1200.00,1.00,1200.00,") && csv[1].includes(",1070.85,"), csv[1]);
  check("CSV names the rate source and date", csv[1].includes("2026-10-09") && csv[1].includes("ECB euro reference rate"));
  check("CSV fee row values BTC with Mezo's PriceFeed at the payment block", csv[6].startsWith("network_fee,") && csv[6].includes("83153.56") && csv[6].includes("PriceFeed"), csv[6]);
  check("FX source was requested", fxRequests > 0);

  // ---------------------------------------------------------------- 5. payment advice for one recipient
  await page.goto(`${receiptUrl}&to=${musdRows[2][0]}`);
  await page.waitForSelector(".receipt-lines tbody tr");
  check("advice shows a single line", (await page.locator(".receipt-lines tbody tr").count()) === 1);
  await say("Payment advice: send each person a link with only their line", 3000, { pitch: false });
  await shot("08-advice");

  // ---------------------------------------------------------------- 6. MEZO batch (precompile-style permit)
  await page.goto(`${SITE}/?dev=1`);
  await page.click("button.seg[data-asset='MEZO']");
  await say("Grants and community rewards in MEZO: the same one-signature flow", 3000);
  const mezoRows = [
    [addr("g1"), "1500", "Grant wave 1 · team Orchid"],
    [addr("g2"), "750", "Grant wave 1 · team Pinecone"],
    [addr("g3"), "250.5", "Docs bounty"],
  ];
  await page.fill("#sheet-input", "address,amount,label\n" + mezoRows.map((r) => r.join(",")).join("\n"));
  await page.fill("#ref-input", "Grants wave 1");
  await page.waitForFunction(() => /≤/.test(document.querySelector("#fee-estimate")?.textContent || ""), null, { timeout: 15000 });
  await page.click("#pay-btn");
  await page.waitForSelector("#pay-success", { timeout: 30000 });
  for (const [a, amount] of mezoRows) {
    const bal = await pc.readContract({ address: mezo.address, abi: mezo.abi, functionName: "balanceOf", args: [a] });
    check(`MEZO recipient ${a.slice(0, 8)} received ${amount}`, bal === BigInt(Math.round(Number(amount) * 10)) * 10n ** 17n, String(bal));
  }
  check("no MEZO allowance left", (await pc.readContract({ address: mezo.address, abi: mezo.abi, functionName: "allowance", args: [PAYER, deployment.address] })) === 0n);
  await page.click("#open-receipt");
  await page.waitForSelector(".receipt-lines tbody tr");
  await shot("09-mezo-receipt");
  const mezoCsv = csvRows(await exportCsv("accounting-mezo.csv"));
  check("MEZO rows carry the amount and say there is no USD price", mezoCsv[1].includes(",MEZO,1500.00,") && mezoCsv[1].includes("no USD price for MEZO"), mezoCsv[1]);

  // ---------------------------------------------------------------- 7. BTC batch
  await page.goto(`${SITE}/?dev=1`);
  await page.click("button.seg[data-asset='BTC']");
  const btcRows = [
    [addr("b1"), "0.0125", "Hardware reimbursement"],
    [addr("b2"), "0.00031415", "Bug bounty (31,415 sats)"],
  ];
  await page.fill("#sheet-input", "address,amount,label\n" + btcRows.map((r) => r.join(",")).join("\n"));
  await page.fill("#ref-input", "BTC payouts");
  await page.waitForFunction(() => /≈/.test(document.querySelector("#fee-estimate")?.textContent || ""), null, { timeout: 15000 });
  await say("Or pay in BTC itself, down to the satoshi", 2600);
  await page.click("#pay-btn");
  await page.waitForSelector("#pay-success", { timeout: 30000 });
  check("BTC recipient 1 received 0.0125", (await pc.getBalance({ address: btcRows[0][0] })) === 125n * 10n ** 14n);
  check("BTC recipient 2 received 31,415 sats", (await pc.getBalance({ address: btcRows[1][0] })) === 31_415n * 10n ** 10n);
  await page.click("#open-receipt");
  await page.waitForSelector(".receipt-lines tbody tr");
  const btcCsv = csvRows(await exportCsv("accounting-btc.csv"));
  // 0.0125 BTC x 83,153.55516 USD = 1,039.42 USD; / 1.1206 = 927.56 EUR
  check("BTC line valued at the PriceFeed price and converted to EUR", btcCsv[1].includes(",BTC,0.0125,83153.56,1039.42,") && btcCsv[1].includes(",927.56,"), btcCsv[1]);

  // ---------------------------------------------------------------- 8. payment request link
  await page.goto(`${SITE}/?dev=1#/request`);
  await say("Contractors can send you a payment request link instead of an address in a chat", 3400);
  const requester = addr("zoe");
  await page.fill("#req-address", requester);
  await page.fill("#req-amount", "640");
  await page.fill("#req-note", "Invoice 2026-031, illustrations");
  await page.click("#req-make");
  const link = await page.inputValue("#req-link");
  check("request link carries address, amount, asset and note", link.includes(`pay=${requester}`) && link.includes("amount=640") && link.includes("asset=MUSD") && link.includes("note=Invoice"), link);
  await shot("10-request-link");
  await page.goto(link);
  await page.waitForSelector("#request-banner");
  await say("Opening it offers to add that line to your sheet, so a whole team can be paid at once", 3600);
  await shot("11-request-opened");
  await page.click("#add-request");
  await page.waitForFunction((a) => document.querySelector("#sheet-input")?.value.includes(a), requester);
  const sheetText = await page.inputValue("#sheet-input");
  check("request line added to the sheet with its note", sheetText.includes(`${requester},640,"Invoice 2026-031, illustrations"`), sheetText);
  check("request parameters removed from the address bar", !page.url().includes("pay="));

  // ---------------------------------------------------------------- 9. failing recipient is caught before sending
  await page.goto(`${SITE}/?dev=1`);
  await page.click("button.seg[data-asset='BTC']");
  const failing = [
    [addr("f1"), "0.001", "OK"],
    [addr("f2"), "0.002", "OK"],
    [rejecting.address, "0.003", "Contract that refuses payments"],
  ];
  await page.fill("#sheet-input", "address,amount,label\n" + failing.map((r) => r.join(",")).join("\n"));
  await page.waitForSelector("#quote-error", { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 560));
  const quoteError = await page.textContent("#quote-error");
  check("simulation points at the failing line", /Line 4/.test(quoteError), quoteError);
  check("failing line is marked in the table", (await page.locator("tr.msg-row.bad").count()) === 1);
  check("Pay is disabled while a line would fail", await page.isDisabled("#pay-btn"));
  check("nothing was sent to the other lines", (await pc.getBalance({ address: addr("f1") })) === 0n);
  await shot("12-failing-line");
  await say("A recipient that would reject the payment is caught before you sign", 3800);
  if (DEMO && !PITCH) {
    await page.goto(`${SITE}/?dev=1#/about`);
    await say("Open source, no custody, no fees, no tracking. Built on Mezo.", 3600);
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  if (blockedHere.length) console.log(`info: ${blockedHere.length} request(s) to ${[...new Set(blockedHere)].join(", ")} were blocked by this test environment (expected)`);
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();
  server.close();
  anvil.kill();
  if (DEMO && videoPath) {
    const target = PITCH ? process.env.PITCH_OUT || `${out}/pitch-demo.mp4` : `${root}submission/demo-local-chain.mp4`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", videoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-r", "30", "-movflags", "+faststart", target]);
    if (PITCH) writeFileSync(target.replace(/\.mp4$/, ".timeline.json"), JSON.stringify(timeline, null, 2));
    console.log(`wrote ${target}`);
  }
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
