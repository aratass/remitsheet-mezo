// Renders the pitch deck: submission/deck.pdf (16:9, one slide per page) and submission/slides/NN.png
// (1280x720, also used as stills in the pitch video). Screenshots come from the end-to-end test.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const logo = readFileSync(`${root}web/public/logo.svg`, "utf8");
const img = (name) => `data:image/png;base64,${readFileSync(`${root}submission/screenshots/${name}.png`).toString("base64")}`;
const outDir = `${root}submission/slides`;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const slide = (cls, body) => `<section class="slide ${cls}">${body}<div class="foot"><span class="mini">${logo}</span>Remitsheet for Mezo<span class="url">aratass.github.io/remitsheet-mezo</span></div></section>`;

const slides = [
  slide(
    "title",
    `<div class="brand">${logo}<span>Remitsheet</span><em>for Mezo</em></div>
     <h1>Pay your whole team in <b>MUSD</b>,<br>without selling your Bitcoin</h1>
     <p class="sub">One signature, one Mezo transaction, a receipt and an accounting export.</p>
     <p class="meta">Mezo Buildathon · Wave 1 · Track 2: Access and Distribution (also fits Track 1)</p>`,
  ),
  slide(
    "problem",
    `<h2>The problem</h2>
     <div class="cards three">
       <div class="c"><h3>Payday is many transfers</h3><p>Paying 20 contractors, bounty winners or grantees means 20 transactions and 20 chances to mistype an address.</p></div>
       <div class="c"><h3>Approvals pile up</h3><p>Every token payout needs an approval first, and approvals are often left unlimited long after payday.</p></div>
       <div class="c"><h3>Dollars mean selling BTC</h3><p>Bitcoin treasuries sell BTC to pay in dollars, and the accountant still wants receipts and EUR values.</p></div>
     </div>`,
  ),
  slide(
    "solution",
    `<h2>The solution</h2>
     <div class="steps">
       <div class="s"><span>1</span><h3>Paste a sheet</h3><p>address, amount, label. Every line is checked before anything moves.</p></div>
       <div class="s"><span>2</span><h3>Sign once</h3><p>One EIP-2612 permit for exactly the total, then one transaction pays everyone in MUSD, MEZO or BTC.</p></div>
       <div class="s"><span>3</span><h3>Keep the paperwork</h3><p>Receipt from the chain, PDF, payment advice per person, CSV with USD and EUR values.</p></div>
     </div>
     <div class="callout">Short on MUSD? The app reads your <b>Mezo Borrow</b> loan and shows what borrowing the gap against your BTC does to your loan-to-value, then sends you to Mezo to borrow it.</div>`,
  ),
  slide(
    "shots",
    `<h2>Product</h2>
     <div class="pair"><figure><img src="${img("04-credit-line")}"><figcaption>Mezo Borrow credit line for a short MUSD batch</figcaption></figure>
     <figure><img src="${img("07-receipt")}"><figcaption>Receipt rebuilt from the chain, with USD and EUR export</figcaption></figure></div>`,
  ),
  slide(
    "integration",
    `<h2>How deep it goes into Mezo</h2>
     <table class="t">
       <tr><th>MUSD</th><td>Main payout asset. EIP-2612 permit (domain "Mezo USD" v1), verified against <code>DOMAIN_SEPARATOR()</code> before signing. Valued at 1 USD.</td></tr>
       <tr><th>MEZO</th><td>Grants and rewards. Mezo's precompiled token: its permit returns a bool and needs v = 27 or 28; the contract handles both permit styles.</td></tr>
       <tr><th>BTC</th><td>Native payouts down to the satoshi; fees shown in sats.</td></tr>
       <tr><th>Mezo Borrow</th><td>Live reads of <code>TroveManager</code>, <code>PriceFeed</code> and <code>BorrowerOperations</code>: collateral, debt, loan-to-value, room to borrow, fee-inclusive effect of borrowing the shortfall.</td></tr>
       <tr><th>PriceFeed history</th><td>BTC lines and the network fee are valued at Mezo's BTC/USD price at the payment block.</td></tr>
       <tr><th>Request links</th><td>Contractors send a link with address, amount and asset; payers collect them into one batch.</td></tr>
     </table>`,
  ),
  slide(
    "tech",
    `<h2>Built to be used, not just demoed</h2>
     <div class="cards two">
       <div class="c"><h3>Contract</h3><ul><li>No owner, no fees, no upgrades, holds no funds</li><li>All-or-nothing batches</li><li>Permit owner is always the caller; a front-run permit cannot break or hijack a batch</li><li>Same CREATE2 address on Mezo testnet and mainnet</li></ul></div>
       <div class="c"><h3>Tested</h3><ul><li>49 Foundry tests: unit, fuzz, permit, reentrancy, failing tokens</li><li>27 unit tests (sheet checks, money math, credit line, request links)</li><li>44 end-to-end browser checks on a local chain</li><li>200 lines fit in one Mezo block: at most about 1,100 sats</li></ul></div>
     </div>`,
  ),
  slide(
    "market",
    `<h2>Who it is for</h2>
     <div class="cards two">
       <div class="c"><h3>Users</h3><ul><li>Bitcoin-holding startups, studios and DAOs paying contractors in dollars</li><li>Grant and bounty programs paying many winners in MEZO or MUSD</li><li>Freelancers who send request links instead of addresses in a chat</li><li>Desktop web, any EIP-6963 wallet, worldwide</li></ul></div>
       <div class="c"><h3>Why it grows MUSD</h3><ul><li>Every payroll run moves MUSD to people who may never have held it</li><li>Each request link brings a new payer to Mezo</li><li>Borrowing for payroll is recurring MUSD demand</li><li>Business model: free open-source core, paid team features later (schedules, approvals, accounting connectors)</li></ul></div>
     </div>`,
  ),
  slide(
    "roadmap",
    `<h2>Next milestones</h2>
     <div class="road">
       <div class="m"><b>Wave 2 · by 15 Nov</b><p>Borrow-and-pay in one transaction with <code>withdrawMUSDWithSignature</code> (BorrowerOperationsSignatures), Mezo Passport for Bitcoin wallets, mainnet deployment.</p></div>
       <div class="m"><b>December</b><p>Recurring payroll schedules, Safe multisig approvals, saved recipient lists.</p></div>
       <div class="m"><b>Q1 2027</b><p>Accounting connectors and invoice import, hosted team plan.</p></div>
     </div>
     <p class="team">Built by Arminas Attas (solo: product, contracts, front end) · github.com/aratass · MIT licensed</p>`,
  ),
];

const css = `
  @page { size: 1280px 720px; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif; color: #0f172a; }
  .slide { position: relative; width: 1280px; height: 720px; overflow: hidden; padding: 64px 80px; page-break-after: always;
           background: radial-gradient(1100px 560px at 90% 10%, #ffe4cc 0%, rgba(255,228,204,0) 60%), linear-gradient(160deg, #fffaf5 0%, #fbf1e8 100%); }
  h1, h2, h3 { font-family: Poppins, system-ui, sans-serif; letter-spacing: -0.02em; margin: 0; }
  h2 { font-size: 40px; margin-bottom: 34px; }
  h3 { font-size: 22px; margin-bottom: 10px; }
  p, li, td { font-size: 20px; line-height: 1.45; color: #334155; }
  code { font-family: "DejaVu Sans Mono", monospace; font-size: 0.85em; background: #fff1e6; padding: 1px 5px; border-radius: 5px; color: #9a3412; }
  .foot { position: absolute; left: 80px; right: 80px; bottom: 26px; display: flex; align-items: center; gap: 10px; font-size: 15px; color: #64748b; }
  .foot .mini svg { width: 22px; height: 22px; display: block; }
  .foot .url { margin-left: auto; }
  .title .brand { display: flex; align-items: center; gap: 18px; font-family: Poppins, sans-serif; font-weight: 700; font-size: 44px; }
  .title .brand svg { width: 84px; height: 84px; }
  .title .brand em { font-style: normal; color: #c2410c; font-weight: 600; }
  .title h1 { font-size: 62px; line-height: 1.08; margin: 54px 0 24px; }
  .title h1 b { color: #c2410c; }
  .title .sub { font-size: 26px; margin: 0 0 30px; }
  .title .meta { font-size: 18px; color: #64748b; }
  .cards { display: grid; gap: 24px; }
  .cards.three { grid-template-columns: repeat(3, 1fr); }
  .cards.two { grid-template-columns: repeat(2, 1fr); }
  .c { background: #fff; border: 1px solid #f3dcc8; border-radius: 18px; padding: 26px 28px; box-shadow: 0 10px 30px rgba(15,23,42,.06); }
  .c ul { margin: 0; padding-left: 22px; } .c li { margin-bottom: 8px; font-size: 19px; }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .s { background: #fff; border: 1px solid #f3dcc8; border-radius: 18px; padding: 24px 26px; }
  .s span { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: #c2410c; color: #fff; font-weight: 700; font-size: 20px; margin-bottom: 14px; }
  .callout { margin-top: 30px; background: #9a3412; color: #fff; border-radius: 16px; padding: 20px 26px; font-size: 21px; line-height: 1.45; }
  .callout b { color: #fde68a; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
  figure { margin: 0; } figure img { width: 100%; border-radius: 14px; border: 1px solid #e2e8f0; box-shadow: 0 16px 40px rgba(15,23,42,.14); }
  figcaption { font-size: 17px; color: #475569; margin-top: 10px; text-align: center; }
  .t { border-collapse: collapse; width: 100%; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(15,23,42,.06); }
  .t th { text-align: left; width: 210px; padding: 13px 20px; font-family: Poppins, sans-serif; font-size: 19px; color: #9a3412; border-bottom: 1px solid #f3e6da; vertical-align: top; }
  .t td { padding: 13px 20px 13px 0; font-size: 18px; border-bottom: 1px solid #f3e6da; }
  .road { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
  .m { background: #fff; border-top: 5px solid #c2410c; border-radius: 14px; padding: 22px 24px; box-shadow: 0 10px 30px rgba(15,23,42,.06); }
  .m b { font-family: Poppins, sans-serif; font-size: 21px; } .m p { font-size: 19px; margin: 10px 0 0; }
  .team { margin-top: 40px; font-size: 19px; color: #475569; }
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${slides.join("")}</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: `${root}submission/deck.pdf`, width: "1280px", height: "720px", printBackground: true });
const sections = await page.$$("section.slide");
for (let i = 0; i < sections.length; i++) {
  await sections[i].screenshot({ path: `${outDir}/${String(i + 1).padStart(2, "0")}.png` });
}
await browser.close();
console.log(`wrote submission/deck.pdf and ${sections.length} slides in submission/slides/`);
