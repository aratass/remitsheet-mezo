import { concat } from "viem";
import { CHAINS, DEFAULT_CHAIN, REPO_URL, addressUrl, supportedChain, txUrl, type ChainConfig, type Hex } from "./config";
import { deploymentStatus, explainError, factoryAvailable, readClient, writeClient } from "./chain";
import { formatSats } from "./format";
import { CREATE2_FACTORY, CREATE2_SALT, REMITSHEET_ABI, REMITSHEET_INIT_CODE, REMITSHEET_RUNTIME_HASH } from "./generated/remitsheet";
import { openWalletPicker } from "./main";
import { clear, extLink, h, icon, storageGet, storageSet } from "./ui";
import { onWalletChange, switchTo, wallet } from "./wallet";

type State =
  | { kind: "checking" }
  | { kind: "live"; address: Hex }
  | { kind: "missing"; factory: boolean; fee?: bigint }
  | { kind: "foreign" }
  | { kind: "error"; message: string };

export function renderDeploy(root: HTMLElement): () => void {
  let state: State = { kind: "checking" };
  let busy = false;
  let result: { hash: Hex; address: Hex } | null = null;
  let failure: string | null = null;
  let seq = 0;

  const target = (): ChainConfig => supportedChain(wallet.chainId) ?? CHAINS[DEFAULT_CHAIN];

  async function check() {
    const s = ++seq;
    const chain = target();
    state = { kind: "checking" };
    draw();
    try {
      const status = await deploymentStatus(chain);
      let next: State;
      if (status === "live") next = { kind: "live", address: chain.remitsheet };
      else if (status === "foreign") next = { kind: "foreign" };
      else {
        const factory = await factoryAvailable(chain);
        let fee: bigint | undefined;
        if (wallet.account && wallet.chainId === chain.id) {
          try {
            const pc = readClient(chain);
            const gas = factory
              ? await pc.estimateGas({ account: wallet.account, to: CREATE2_FACTORY, data: concat([CREATE2_SALT, REMITSHEET_INIT_CODE]) })
              : await pc.estimateGas({ account: wallet.account, data: REMITSHEET_INIT_CODE });
            fee = gas * (await pc.getGasPrice());
          } catch {
            fee = undefined;
          }
        }
        next = { kind: "missing", factory, fee };
      }
      if (s === seq) state = next;
    } catch (err) {
      if (s === seq) state = { kind: "error", message: explainError(err).message };
    }
    draw();
  }

  async function deploy() {
    const chain = target();
    if (!wallet.account || wallet.chainId !== chain.id || state.kind !== "missing") return;
    busy = true;
    failure = null;
    draw();
    try {
      const wc = writeClient(chain);
      const pc = readClient(chain);
      let hash: Hex;
      let address: Hex;
      if (state.factory) {
        hash = await wc.sendTransaction({ account: wallet.account, chain: wc.chain, to: CREATE2_FACTORY, data: concat([CREATE2_SALT, REMITSHEET_INIT_CODE]) });
        const r = await pc.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error("The deployment transaction reverted.");
        address = chain.remitsheet;
      } else {
        hash = await wc.deployContract({ account: wallet.account, chain: wc.chain, abi: REMITSHEET_ABI, bytecode: REMITSHEET_INIT_CODE });
        const r = await pc.waitForTransactionReceipt({ hash });
        if (r.status !== "success" || !r.contractAddress) throw new Error("The deployment transaction reverted.");
        address = r.contractAddress;
        // Remember the non-deterministic address in this browser; publish it in config.json for everyone.
        const overrides = storageGet<Record<string, string>>("remitsheet-mezo:overrides", {});
        overrides[String(chain.id)] = address;
        storageSet("remitsheet-mezo:overrides", overrides);
        chain.remitsheet = address;
      }
      if ((await deploymentStatus(chain, address)) !== "live") throw new Error("The contract code at the new address does not match Remitsheet.");
      result = { hash, address };
      state = { kind: "live", address };
    } catch (err) {
      failure = explainError(err).message;
    } finally {
      busy = false;
      draw();
    }
  }

  function draw() {
    const chain = target();
    const onTarget = !!wallet.account && wallet.chainId === chain.id;
    let body: Node;
    switch (state.kind) {
      case "checking":
        body = h("div", { class: "notice" }, icon("spinner", "icon spin"), `Checking ${chain.label}…`);
        break;
      case "live":
        body = h(
          "div",
          { class: "success", id: "deploy-live" },
          h("div", { class: "success-head" }, icon("check", "icon big"), h("div", {}, h("strong", {}, `Remitsheet is live on ${chain.label}`), h("span", { class: "mono break" }, state.address))),
          h(
            "div",
            { class: "row-actions" },
            extLink(addressUrl(chain, state.address), h("span", {}, "View contract ", icon("external")), "btn btn-secondary"),
            result ? extLink(txUrl(chain, result.hash), h("span", {}, "Deployment transaction ", icon("external")), "btn btn-ghost") : null,
            h("a", { class: "btn btn-primary", href: location.pathname + (new URLSearchParams(location.search).has("dev") ? "?dev=1" : "") }, "Start a batch"),
          ),
          result && result.address.toLowerCase() !== CHAINS[chain.id].remitsheet.toLowerCase()
            ? h("p", { class: "fine" }, `Deployed without the CREATE2 factory. Add "remitsheet": "${result.address}" for chain ${chain.id} to config.json so every visitor uses it.`)
            : null,
        );
        break;
      case "foreign":
        body = h("div", { class: "notice notice-bad" }, icon("alert"), `There is code at ${chain.remitsheet} on ${chain.label}, but it is not Remitsheet. Do not use it.`);
        break;
      case "error":
        body = h("div", { class: "notice notice-bad" }, icon("alert"), state.message, " ", h("button", { class: "link-btn", onclick: () => void check() }, "Retry"));
        break;
      case "missing": {
        const fee = state.fee !== undefined ? `≈ ${formatSats(state.fee)} (BTC)` : onTarget ? "—" : "connect to estimate";
        const action = !wallet.account
          ? h("button", { class: "btn btn-primary btn-lg", onclick: () => openWalletPicker() }, icon("wallet"), "Connect wallet")
          : !onTarget
            ? h("button", { class: "btn btn-warn btn-lg", onclick: () => void switchTo(chain).catch(() => undefined) }, `Switch wallet to ${chain.label}`)
            : h(
                "button",
                { class: "btn btn-primary btn-lg", id: "deploy-btn", disabled: busy, onclick: () => void deploy() },
                busy ? icon("spinner", "icon spin") : icon("rocket"),
                busy ? "Deploying…" : `Deploy on ${chain.label}`,
              );
        body = h(
          "div",
          {},
          h("div", { class: "kvs" }, h("div", { class: "kv" }, h("span", {}, "Status"), h("strong", {}, "Not deployed yet")), h("div", { class: "kv" }, h("span", {}, "Network fee"), h("span", { class: "mono", id: "deploy-fee" }, fee)), h("div", { class: "kv" }, h("span", {}, "Method"), h("span", {}, state.factory ? "CREATE2 factory (same address everywhere)" : "Standard deployment (factory not found)"))),
          action,
          chain.faucetUrl ? h("p", { class: "fine" }, "Deploying costs a tiny amount of test BTC for gas. Get some from the ", extLink(chain.faucetUrl, "Mezo faucet"), ".") : null,
          failure ? h("div", { class: "notice notice-bad" }, icon("alert"), failure) : null,
        );
        break;
      }
    }

    clear(
      root,
      h(
        "section",
        { class: "card narrow" },
        h("h1", {}, "Deploy Remitsheet"),
        h(
          "p",
          { class: "muted" },
          "Remitsheet is a single contract with no owner, no fees and no upgrade path. It is deployed through the standard CREATE2 factory, so it has the same address on every network and anyone can deploy it. Deploying it gives nobody any control over it.",
        ),
        h(
          "div",
          { class: "kvs" },
          h("div", { class: "kv" }, h("span", {}, "Network"), h("strong", {}, `${chain.label} (chain ${chain.id})`)),
          h("div", { class: "kv" }, h("span", {}, "Contract address"), h("span", { class: "mono break", id: "canonical-address" }, chain.remitsheet)),
        ),
        body,
      ),
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "Verify it yourself"),
        h(
          "dl",
          { class: "meta single" },
          h("div", { class: "meta-item" }, h("dt", {}, "Runtime code hash"), h("dd", { class: "mono break" }, REMITSHEET_RUNTIME_HASH)),
          h("div", { class: "meta-item" }, h("dt", {}, "CREATE2 factory"), h("dd", { class: "mono break" }, CREATE2_FACTORY)),
          h("div", { class: "meta-item" }, h("dt", {}, "Salt"), h("dd", { class: "mono break" }, CREATE2_SALT)),
          h("div", { class: "meta-item" }, h("dt", {}, "Compiler"), h("dd", {}, "solc 0.8.30, optimizer 20,000 runs, EVM cancun, no metadata hash")),
        ),
        h(
          "p",
          { class: "fine" },
          "This page and the receipt page check that the code at the address hashes to the value above before using it. Source, tests and the compiler input for explorer verification are in the ",
          extLink(REPO_URL, "repository"),
          ".",
        ),
      ),
    );
  }

  void check();
  const off = onWalletChange(() => {
    result = null;
    failure = null;
    void check();
  });
  return () => off();
}
