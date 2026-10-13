# AKINDO submission: Mezo Buildathon, Wave 1

Wave 1 build period: 16 to 26 Oct 2026, deadline **26 Oct 2026, 15:00 UTC** (17:00 in Vilnius). Program page: https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10

Copy each field into the AKINDO submission form. Replace every `«…»` placeholder first (HIS-STEPS.md says where each value comes from).

## Requirement checklist (from the program page)

| Requirement | How Remitsheet meets it |
|---|---|
| Integrates MUSD and/or MEZO | Both. MUSD is the main payout asset (EIP-2612 permit, valued at 1 USD), MEZO is paid through its precompile permit, and the app reads Mezo Borrow live for MUSD payouts |
| Working deployment on Mezo, Ethereum, Base or BNB Chain (Mezo testnet accepted) | Contract `0xfB87f0a4df8Fa0FBBe505BF4Af27aEEebEafA570` on Mezo testnet, first batch: «TESTNET_RECEIPT_URL» |
| Developed during the hackathon, or a new extension of an existing product | Extension of Remitsheet (open source, first built for Arc: https://aratass.github.io/remitsheet/). The Mezo edition, permit flow, Mezo Borrow credit line, MEZO and BTC payouts, PriceFeed valuation and request links are new |
| Extends MUSD or MEZO utility | Gives MUSD a payroll and invoice use case, sends short users to Mezo Borrow, and turns every request link into a new MUSD payer |
| Testnet or mainnet link to the live project | https://aratass.github.io/remitsheet-mezo/ |
| Public GitHub repository | https://github.com/aratass/remitsheet-mezo |
| Project deck | https://github.com/aratass/remitsheet-mezo/blob/main/submission/deck.pdf |
| 2-minute pitch video | «PITCH_VIDEO_URL» (file: https://github.com/aratass/remitsheet-mezo/blob/main/submission/pitch-video.mp4, 1 min 55 s) |

## Form fields

**Project name**
Remitsheet for Mezo

**Project category** (3 to 5 words)
Payroll and batch payment systems

**TL;DR** (one sentence)
Remitsheet pays a whole spreadsheet of contractors, grantees or employees in MUSD, MEZO or BTC with one permit signature and one Mezo transaction, shows your Mezo Borrow loan while you do it, and gives you receipts and a USD and EUR accounting export.

**How it works** (problem, how it functions, how MUSD and MEZO are used)

*Problem.* Teams that pay many people on-chain (contractors, bounty and grant winners, DAO contributors, payroll) send dozens of transfers one by one, approve each token separately and often leave unlimited approvals behind, then rebuild the paperwork by hand for their accountant. Teams whose treasury is Bitcoin usually sell BTC to pay in dollars.

*How it works.*
1. Paste or upload a sheet (`address, amount, label`) or collect lines from payment request links. Every line is checked before anything moves: checksums, duplicates, zero amounts, decimals, and addresses that are token, oracle or Mezo Borrow contracts.
2. For MUSD and MEZO you sign one EIP-2612 permit for exactly the batch total (free, valid 30 minutes) and confirm one transaction: `payTokenWithPermit` moves the tokens from your wallet straight to every recipient. No separate approval, nothing left approved, and the batch is all-or-nothing. BTC batches are a single `payNative` transaction.
3. Before you sign, the batch is simulated and any recipient that would reject the payment is highlighted.
4. Afterwards you get a receipt rebuilt from the chain (printable as PDF), a payment advice link per recipient, and a CSV with USD and EUR values for each line.

*How MUSD and MEZO are used.*
- **MUSD** is the main payout asset. The app verifies MUSD's EIP-712 domain ("Mezo USD", version 1) against `DOMAIN_SEPARATOR()` before asking for a signature, and values MUSD at 1 USD in the export.
- **Mezo Borrow:** for MUSD batches the app reads your trove live from `TroveManager`, the BTC price from Mezo's `PriceFeed` and the fee from `BorrowerOperations`. It shows collateral, debt, loan-to-value, how much you could still borrow up to 50% loan-to-value and, when the batch is short, exactly how borrowing the missing MUSD would move your loan-to-value (fee included), with a button to Mezo Borrow. Bitcoin holders pay their team in dollars without selling BTC.
- **MEZO** is paid through Mezo's precompiled token, whose permit returns a bool and only accepts v = 27 or 28; the contract handles both permit styles, so grant programs can pay many winners in MEZO with one signature.
- **BTC** lines and the network fee are valued at the BTC/USD price Mezo's `PriceFeed` reported at the payment block.
- **Payment request links** let a contractor send an address, amount, asset and note as one link; the payer collects them into one batch. Each link brings a new payer to MUSD on Mezo.

The contract has no owner, fees, upgrades or custody, is deployed through the CREATE2 factory at the same address on Mezo testnet and mainnet, and is covered by 49 Foundry tests (unit, fuzz, permit, reentrancy, failing tokens), 27 unit tests and a 44-check end-to-end browser test.

**Target group**
Track 2 (Access and Distribution): small Bitcoin-holding companies, studios and DAOs that pay contractors in dollars; grant, bounty and ecosystem programs that pay many winners in MEZO or MUSD; and freelancers who would rather send a request link than an address in a chat. Experience level: anyone who can export a spreadsheet and use a browser wallet. Region: worldwide (EUR export for European bookkeeping). Desktop web, any EIP-6963 wallet (Rabby, MetaMask).

**Tech stack**
Solidity 0.8.30 with Foundry (forge, anvil); TypeScript and viem with no framework, bundled with esbuild; Playwright for end-to-end tests; GitHub Pages hosting. Standards: EIP-2612 permits, EIP-712, EIP-6963 wallet discovery, CREATE2 deterministic deployment. Mezo contracts used: MUSD, MEZO precompile, TroveManager, PriceFeed, BorrowerOperations.

**Track**
Track 2: Access and Distribution for MUSD/MEZO

**Chain deployed on**
Mezo (testnet, chain 31611). The same contract address works on Mezo mainnet once deployed.

**Project status**
Existing project with new features added during the hackathon. Existing product: Remitsheet for Arc, https://aratass.github.io/remitsheet/ (source: https://github.com/aratass/remitsheet). New for Mezo: the Mezo edition with MUSD, MEZO and BTC payouts, one-signature permit batches (new contract function `payTokenWithPermit`), the Mezo Borrow credit line, PriceFeed valuation and payment request links.

**Project readiness**
Testnet deployment.

**Future milestones**
1. **Wave 2, by 15 Nov 2026:** borrow and pay in one transaction using Mezo's `BorrowerOperationsSignatures.withdrawMUSDWithSignature` (the borrower signs once and the borrowed MUSD goes straight to the payees), Mezo Passport so Bitcoin wallets can pay, and a mainnet deployment.
2. **December 2026:** recurring payroll schedules, Safe multisig approvals and saved recipient lists.
3. **Q1 2027:** accounting connectors and invoice import, and a hosted team plan.

**Team info**
Arminas Attas, solo builder (product, smart contracts, front end). GitHub: https://github.com/aratass «X_OR_LINKEDIN_URL_IF_ANY». Telegram: @Herbzzz.

**Links**
- Live app (Mezo testnet): https://aratass.github.io/remitsheet-mezo/
- GitHub: https://github.com/aratass/remitsheet-mezo
- Contract on Mezo testnet: https://explorer.test.mezo.org/address/0xfB87f0a4df8Fa0FBBe505BF4Af27aEEebEafA570
- First testnet batch receipt: «TESTNET_RECEIPT_URL»
- Deck: https://github.com/aratass/remitsheet-mezo/blob/main/submission/deck.pdf
- Pitch video: «PITCH_VIDEO_URL»

**Wallet for the MEZO reward** (asked during KYB, not on the form)
«MEZO_PAYOUT_ADDRESS» (your Rabby main address works: it receives MEZO on Mezo mainnet)
