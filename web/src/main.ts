import { CHAINS, DEFAULT_CHAIN, REPO_URL, addressUrl, loadRuntimeConfig, supportedChain } from "./config";
import { shortAddress } from "./format";
import { clear, extLink, h, icon } from "./ui";
import { availableWallets, connect, disconnect, onWalletChange, reconnect, startDiscovery, switchTo, wallet } from "./wallet";
import { renderPay } from "./pay";
import { renderReceipt, renderReceiptLookup } from "./receipt";
import { renderDeploy } from "./deploy";
import { renderAbout } from "./about";
import { renderRequest } from "./request";

const app = document.getElementById("app")!;
let unmount: (() => void) | undefined;

function route(): { name: string; params: URLSearchParams } {
  const params = new URLSearchParams(location.search);
  if (params.get("tx")) return { name: "receipt", params };
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (hash === "deploy") return { name: "deploy", params };
  if (hash === "about") return { name: "about", params };
  if (hash === "receipt") return { name: "lookup", params };
  if (hash === "request") return { name: "request", params };
  return { name: "pay", params };
}

export function navigate(path: string): void {
  history.pushState(null, "", path);
  render();
}

function navLink(href: string, label: string, active: boolean) {
  return h(
    "a",
    {
      href,
      class: active ? "nav-link active" : "nav-link",
      onclick: (e: Event) => {
        e.preventDefault();
        navigate(href);
      },
    },
    label,
  );
}

function renderHeader(current: string) {
  const header = document.getElementById("site-header")!;
  const base = location.pathname;
  const dev = new URLSearchParams(location.search).has("dev") ? "?dev=1" : "";
  clear(
    header,
    h(
      "div",
      { class: "header-inner" },
      h(
        "a",
        { href: base + dev, class: "brand", onclick: (e: Event) => (e.preventDefault(), navigate(base + dev)) },
        h("img", { src: "logo.svg", alt: "", width: 28, height: 28 }),
        h("span", {}, "Remitsheet"),
      ),
      h(
        "nav",
        { class: "nav" },
        navLink(base + dev, "Pay", current === "pay"),
        navLink(`${base}${dev}#/request`, "Request", current === "request"),
        navLink(`${base}${dev}#/receipt`, "Receipts", current === "receipt" || current === "lookup"),
        navLink(`${base}${dev}#/about`, "How it works", current === "about"),
        navLink(`${base}${dev}#/deploy`, "Deploy", current === "deploy"),
      ),
      h("div", { class: "wallet-area", id: "wallet-area" }),
    ),
  );
  renderWalletArea();
}

function renderWalletArea() {
  const area = document.getElementById("wallet-area");
  if (!area) return;
  if (!wallet.account) {
    clear(area, h("button", { class: "btn btn-primary", id: "connect-btn", onclick: () => openWalletPicker() }, icon("wallet"), "Connect wallet"));
    return;
  }
  const chain = supportedChain(wallet.chainId);
  const badge = chain
    ? h("span", { class: chain.testnet ? "badge badge-test" : "badge badge-ok", title: `Chain ID ${chain.id}` }, h("span", { class: "dot" }), chain.label)
    : h(
        "button",
        { class: "btn btn-warn btn-sm", onclick: () => void switchTo(CHAINS[DEFAULT_CHAIN]).catch(() => undefined) },
        icon("alert"),
        `Switch to ${CHAINS[DEFAULT_CHAIN].label}`,
      );
  const addressHref = chain ? addressUrl(chain, wallet.account) : undefined;
  clear(
    area,
    badge,
    h(
      "div",
      { class: "account" },
      wallet.info?.icon ? h("img", { src: wallet.info.icon, alt: "", width: 18, height: 18 }) : icon("wallet"),
      extLink(addressHref, shortAddress(wallet.account), "mono"),
      h("button", { class: "link-btn", title: "Disconnect", onclick: () => disconnect() }, "Disconnect"),
    ),
  );
}

export function openWalletPicker(): void {
  const wallets = availableWallets();
  const close = () => overlay.remove();
  const list = wallets.length
    ? wallets.map((w) =>
        h(
          "button",
          {
            class: "wallet-option",
            onclick: async () => {
              close();
              try {
                await connect(w);
                if (!supportedChain(wallet.chainId)) await switchTo(CHAINS[DEFAULT_CHAIN]).catch(() => undefined);
              } catch (err) {
                alertBox((err as Error).message || "Could not connect.");
              }
            },
          },
          w.info.icon ? h("img", { src: w.info.icon, alt: "", width: 28, height: 28 }) : icon("wallet"),
          h("span", {}, w.info.name),
        ),
      )
    : [
        h(
          "p",
          {},
          "No browser wallet found. Install ",
          extLink("https://rabby.io", "Rabby"),
          " or ",
          extLink("https://metamask.io/download", "MetaMask"),
          ", then reload this page.",
        ),
      ];
  const overlay: HTMLDivElement = h(
    "div",
    { class: "modal-backdrop", onclick: (e: Event) => e.target === overlay && close() },
    h("div", { class: "modal", role: "dialog", "aria-label": "Connect a wallet" }, h("h3", {}, "Connect a wallet"), ...list, h("button", { class: "btn btn-ghost", onclick: close }, "Cancel")),
  );
  document.body.appendChild(overlay);
}

function alertBox(message: string) {
  const overlay = h(
    "div",
    { class: "modal-backdrop" },
    h("div", { class: "modal" }, h("p", {}, message), h("button", { class: "btn btn-primary", onclick: () => overlay.remove() }, "OK")),
  );
  document.body.appendChild(overlay);
}

function renderFooter() {
  const footer = document.getElementById("site-footer")!;
  const chain = CHAINS[DEFAULT_CHAIN];
  clear(
    footer,
    h(
      "div",
      { class: "footer-inner" },
      h("span", {}, "Remitsheet · open source (MIT) · no tracking, no backend, no custody"),
      h(
        "span",
        { class: "footer-links" },
        extLink(REPO_URL, "Source code"),
        extLink(addressUrl(chain, chain.remitsheet), "Contract"),
        extLink("https://mezo.org/docs/developers/", "Mezo docs"),
      ),
    ),
  );
}

function render() {
  unmount?.();
  unmount = undefined;
  const r = route();
  renderHeader(r.name);
  const view = h("main", { class: "view" });
  clear(app, view);
  switch (r.name) {
    case "receipt":
      unmount = renderReceipt(view, r.params);
      break;
    case "lookup":
      unmount = renderReceiptLookup(view);
      break;
    case "deploy":
      unmount = renderDeploy(view);
      break;
    case "about":
      unmount = renderAbout(view);
      break;
    case "request":
      unmount = renderRequest(view);
      break;
    default:
      unmount = renderPay(view);
  }
  window.scrollTo(0, 0);
}

async function start() {
  startDiscovery();
  await loadRuntimeConfig();
  onWalletChange(() => renderWalletArea());
  window.addEventListener("popstate", render);
  window.addEventListener("hashchange", render);
  renderFooter();
  render();
  await reconnect();
}

void start();
