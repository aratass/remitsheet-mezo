import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  hashDomain,
  http,
  keccak256,
  parseSignature,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { type ChainConfig, type Hex, type PermitDomain } from "./config";
import { CREATE2_FACTORY, REMITSHEET_RUNTIME_HASH } from "./generated/remitsheet";
import { wallet } from "./wallet";

export function viemChain(c: ChainConfig): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: c.explorer ? { default: { name: "Mezo explorer", url: c.explorer } } : undefined,
  });
}

/** Reads through the connected wallet when it is on `c`, otherwise through the public RPC. */
export function readClient(c: ChainConfig): PublicClient {
  const transport = wallet.provider && wallet.chainId === c.id ? custom(wallet.provider) : http(c.rpcUrl, { retryCount: 2 });
  return createPublicClient({ chain: viemChain(c), transport, pollingInterval: 1000 }) as PublicClient;
}

/** Always reads through the public RPC (used for historical reads that some wallets do not forward). */
export function publicClient(c: ChainConfig): PublicClient {
  return createPublicClient({ chain: viemChain(c), transport: http(c.rpcUrl, { retryCount: 2 }), pollingInterval: 1000 }) as PublicClient;
}

export function writeClient(c: ChainConfig): WalletClient {
  if (!wallet.provider || !wallet.account) throw new Error("Connect a wallet first.");
  return createWalletClient({ chain: viemChain(c), transport: custom(wallet.provider), account: wallet.account });
}

export type DeploymentStatus = "live" | "missing" | "foreign";

/** Checks that the code at `address` is exactly the Remitsheet runtime code. */
export async function deploymentStatus(c: ChainConfig, address: Hex = c.remitsheet): Promise<DeploymentStatus> {
  const code = await readClient(c).getCode({ address });
  if (!code || code === "0x") return "missing";
  return keccak256(code) === REMITSHEET_RUNTIME_HASH ? "live" : "foreign";
}

export async function factoryAvailable(c: ChainConfig): Promise<boolean> {
  const code = await readClient(c).getCode({ address: CREATE2_FACTORY });
  return !!code && code !== "0x";
}

export const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * True when `token` accepts EIP-2612 permits signed for `domain`: the token's DOMAIN_SEPARATOR() must
 * equal the separator computed from the expected name, version, chain id and token address. If it
 * does not (or the token has no permit), the app falls back to approve + pay.
 */
export async function permitSupported(c: ChainConfig, token: Hex, domain: PermitDomain): Promise<boolean> {
  try {
    const onChain = (await readClient(c).readContract({ address: token, abi: ERC20_ABI, functionName: "DOMAIN_SEPARATOR" })) as Hex;
    const expected = hashDomain({
      domain: { name: domain.name, version: domain.version, chainId: c.id, verifyingContract: token },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    return onChain.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

export type PermitSignature = { deadline: bigint; v: number; r: Hex; s: Hex };

/**
 * Asks the wallet to sign an EIP-2612 permit that lets Remitsheet move exactly `value` of `token` from
 * the connected account, valid for 30 minutes. Signing costs nothing and moves nothing by itself.
 */
export async function signPermit(c: ChainConfig, token: Hex, domain: PermitDomain, value: bigint): Promise<PermitSignature> {
  const account = wallet.account;
  if (!account) throw new Error("Connect a wallet first.");
  const pc = readClient(c);
  const nonce = (await pc.readContract({ address: token, abi: ERC20_ABI, functionName: "nonces", args: [account] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const signature = await writeClient(c).signTypedData({
    account,
    domain: { name: domain.name, version: domain.version, chainId: c.id, verifyingContract: token },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: account, spender: c.remitsheet, value, nonce, deadline },
  });
  const { r, s, yParity } = parseSignature(signature);
  // Mezo's precompiled tokens accept only v = 27 or 28; OpenZeppelin tokens accept the same.
  return { deadline, v: 27 + (yParity ?? 0), r, s };
}

// ---------------------------------------------------------------- Mezo borrowing system (read-only)

export const TROVE_MANAGER_ABI = [
  { type: "function", name: "getTroveStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "getEntireDebtAndColl",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "coll", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "interest", type: "uint256" },
      { name: "pendingCollateral", type: "uint256" },
      { name: "pendingPrincipal", type: "uint256" },
      { name: "pendingInterest", type: "uint256" },
    ],
  },
  { type: "function", name: "MCR", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CCR", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const PRICE_FEED_ABI = [{ type: "function", name: "fetchPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

export const BORROWER_OPERATIONS_ABI = [
  { type: "function", name: "borrowingRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minNetDebt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type ExplainedError = { message: string; row?: number };

/**
 * Turns wallet, RPC and contract errors into a sentence a person can act on. `rowLines` maps batch
 * indexes back to sheet line numbers so a failing recipient can be pointed at.
 */
export function explainError(err: unknown, rowLines: number[] = [], assetSymbol = "BTC"): ExplainedError {
  const e = err as { code?: number; shortMessage?: string; message?: string };
  if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied (message )?signature/i.test(String(e?.message))) {
    return { message: "You cancelled the request in your wallet. Nothing was sent." };
  }
  if (err instanceof BaseError) {
    const revert = err.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      const args = (revert.data.args ?? []) as readonly unknown[];
      const line = (i: unknown) => rowLines[Number(i)];
      switch (revert.data.errorName) {
        case "TransferFailed": {
          const l = line(args[0]);
          return {
            row: l,
            message:
              assetSymbol === "BTC"
                ? `Line ${l ?? Number(args[0]) + 1} (${String(args[1])}) cannot receive BTC. It may be a contract that rejects payments. Remove that line and try again. Nothing was sent.`
                : `The ${assetSymbol} transfer to line ${l ?? Number(args[0]) + 1} (${String(args[1])}) failed. Check your ${assetSymbol} balance, or remove that line (${assetSymbol === "MUSD" ? "MUSD cannot be sent to its own token contract" : "it may not accept the token"}). Nothing was sent.`,
          };
        }
        case "ZeroAddress":
          return { row: line(args[0]), message: `Line ${line(args[0])} has the zero address.` };
        case "ZeroAmount":
          return { row: line(args[0]), message: `Line ${line(args[0])} has a zero amount.` };
        case "ValueMismatch":
          return { message: "The amount sent does not match the batch total. Reload the page and try again." };
        case "EmptyBatch":
          return { message: "The batch is empty." };
        case "LengthMismatch":
          return { message: "Internal error: recipients and amounts differ in length." };
        case "InvalidToken":
          return { message: `The ${assetSymbol} token address is not a contract on this network.` };
        case "PermitFailed":
          return { message: `The ${assetSymbol} signature was not accepted (it expired, or the batch changed after you signed). Nothing was sent. Press Pay again to sign a new one.` };
      }
    }
    const text = `${err.shortMessage} ${err.details ?? ""}`;
    if (/insufficient funds|exceeds balance|insufficient balance/i.test(text)) {
      return { message: "Your balance is too low to cover this batch plus the network fee (paid in BTC)." };
    }
    if (/exceeds (block|transaction) gas limit|gas limit too high|intrinsic gas too high|out of gas/i.test(text)) {
      return { message: "This batch is too large for one transaction. Split the sheet into smaller batches." };
    }
    return { message: err.shortMessage || err.message };
  }
  return { message: e?.shortMessage || e?.message || String(err) };
}
