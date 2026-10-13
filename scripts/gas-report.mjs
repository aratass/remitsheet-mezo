// Measures full transaction gas (intrinsic + calldata + execution) for batches of 10, 50 and 200
// recipients on a local Anvil node: BTC (payNative), MUSD with a permit (payTokenWithPermit) and MUSD
// after an approval (payToken), using TestMUSD (OpenZeppelin ERC20Permit, the same code MUSD inherits).
// Fees are priced at Mezo mainnet's gas price on 13 Oct 2026 (1,462,500 wei per gas; 1 sat = 1e10 wei).
// Usage: npm run contracts:build && node scripts/gas-report.mjs   (needs `anvil`, or ANVIL=/path/to/anvil)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { concat, createPublicClient, createWalletClient, getAddress, http, keccak256, maxUint256, parseSignature, slice, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const root = new URL("..", import.meta.url).pathname;
const RPC = "http://127.0.0.1:8547";
// Anvil's first well-known development key (public test key, local chain only).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const PAYER = account.address;
const anvil = spawn(process.env.ANVIL || "anvil", ["--port", "8547", "--silent", "--gas-limit", "100000000"], { stdio: "inherit" });
const pc = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 50 });
const wc = createWalletClient({ chain: foundry, transport: http(RPC), account });
for (let i = 0; ; i++) {
  try {
    await pc.getChainId();
    break;
  } catch {
    if (i > 50) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const wait = async (hash) => pc.waitForTransactionReceipt({ hash });
const json = (file, name) => JSON.parse(readFileSync(`${root}contracts/out/${file}/${name}.json`, "utf8"));

const dep = JSON.parse(readFileSync(`${root}contracts/deployment.json`, "utf8"));
const rs = json("Remitsheet.sol", "Remitsheet");
const deployRc = await wait(await wc.sendTransaction({ to: dep.create2Factory, data: concat([dep.salt, rs.bytecode.object]) }));
const musdArt = json("MezoTokens.sol", "TestMUSD");
const deployToken = async () => {
  const address = (await wait(await wc.deployContract({ abi: musdArt.abi, bytecode: musdArt.bytecode.object }))).contractAddress;
  await wait(await wc.writeContract({ address, abi: musdArt.abi, functionName: "mint", args: [PAYER, 10n ** 30n] }));
  return address;
};
const musdPermit = await deployToken();
const musdApproved = await deployToken();
await wait(await wc.writeContract({ address: musdApproved, abi: musdArt.abi, functionName: "approve", args: [dep.address, maxUint256] }));

let seed = 0;
const recipients = (n) => Array.from({ length: n }, () => getAddress(slice(keccak256(toHex(`gas ${seed++}`)), 12)));
const REF = toHex("gas", { size: 32 });
const GAS_PRICE = 1_462_500n;
const sats = (gas) => Math.round(Number(gas * GAS_PRICE) / 1e10).toLocaleString("en-US");

async function permitFor(token, value) {
  const nonce = await pc.readContract({ address: token, abi: musdArt.abi, functionName: "nonces", args: [PAYER] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = await account.signTypedData({
    domain: { name: "Mezo USD", version: "1", chainId: 31337, verifyingContract: token },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner: PAYER, spender: dep.address, value, nonce, deadline },
  });
  const { r, s, yParity } = parseSignature(signature);
  return [deadline, 27 + yParity, r, s];
}

const rows = [];
for (const n of [10, 50, 200]) {
  for (const existing of [false, true]) {
    const amounts = Array.from({ length: n }, (_, i) => BigInt(i + 1) * 10n ** 16n);
    const total = amounts.reduce((a, b) => a + b, 0n);
    // BTC
    let to = recipients(n);
    if (existing) for (const a of to) await wait(await wc.sendTransaction({ to: a, value: 1n }));
    const native = await wait(await wc.writeContract({ address: dep.address, abi: rs.abi, functionName: "payNative", args: [to, amounts, REF], value: total, gas: 30_000_000n }));
    // MUSD with permit
    to = recipients(n);
    if (existing) for (const a of to) await wait(await wc.writeContract({ address: musdPermit, abi: musdArt.abi, functionName: "transfer", args: [a, 1n] }));
    const sig = await permitFor(musdPermit, total);
    const permit = await wait(await wc.writeContract({ address: dep.address, abi: rs.abi, functionName: "payTokenWithPermit", args: [musdPermit, to, amounts, REF, ...sig], gas: 30_000_000n }));
    // MUSD after an approval
    to = recipients(n);
    if (existing) for (const a of to) await wait(await wc.writeContract({ address: musdApproved, abi: musdArt.abi, functionName: "transfer", args: [a, 1n] }));
    const approved = await wait(await wc.writeContract({ address: dep.address, abi: rs.abi, functionName: "payToken", args: [musdApproved, to, amounts, REF], gas: 30_000_000n }));
    rows.push({ n, existing, native: native.gasUsed, permit: permit.gasUsed, approved: approved.gasUsed });
  }
}
anvil.kill();

const cell = (gas, n) => `${gas.toLocaleString("en-US")} (${(gas / BigInt(n)).toLocaleString("en-US")})`;
console.log(`Deployment through the CREATE2 factory: ${deployRc.gasUsed.toLocaleString("en-US")} gas (${sats(deployRc.gasUsed)} sats at 1,462,500 wei per gas)\n`);
console.log("| Recipients | Recipient accounts | BTC: gas (per line) | sats | MUSD with permit: gas (per line) | sats | MUSD after approval: gas (per line) | sats |");
console.log("|---:|---|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.n} | ${r.existing ? "already funded" : "new"} | ${cell(r.native, r.n)} | ${sats(r.native)} | ${cell(r.permit, r.n)} | ${sats(r.permit)} | ${cell(r.approved, r.n)} | ${sats(r.approved)} |`);
}
