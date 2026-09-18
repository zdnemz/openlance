"use client";

/**
 * Wallet layer — viem-only, zero connector machinery.
 *
 * Two wallet kinds ride one interface:
 *  · personas   — deterministic anvil test keys signing LOCALLY in the tab
 *                 (viem LocalAccount); transactions are signed client-side
 *                 and relayed to the chain through the same-origin /api/rpc.
 *  · injected   — window.ethereum (MetaMask & friends) via direct EIP-1193.
 *
 * The 4GB dev box could not hold a turbopack dev server WITH the wagmi
 * module graph alongside the chain stack, so this layer hand-rolls the
 * ~150 lines wagmi was providing: connect, signMessage, sendTransaction,
 * balance. Smaller graph, faster compiles, same wallet-agnostic UX.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { encodeFunctionData, type Abi } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const CHAIN_ID = 31337;

/** Minimal EIP-1193 injected-provider typing. */
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  }
}

export interface Persona {
  key: `0x${string}`;
  address: string;
  name: string;
  role: string;
  blurb: string;
}

/** anvil deterministic accounts #0,1,2,3,5 — public test keys, zero value. */
export const PERSONAS: Persona[] = [
  {
    key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    name: "Mara Voss",
    role: "client · admin",
    blurb: "Studio Halo founder — posts jobs, funds escrow",
  },
  {
    key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    name: "Dario Kessler",
    role: "freelancer",
    blurb: "Protocol engineer — ships milestones, submits on-chain",
  },
  {
    key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    address: "0x3c44cddddb6a900fa2b585dd299e03d12fa4293bc",
    name: "Junko Almeida",
    role: "client + freelancer",
    blurb: "Full-stack dev — both sides of the market",
  },
  {
    key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    name: "Rhys Okafor",
    role: "freelancer",
    blurb: "Front-end engineer — realtime UIs",
  },
  {
    key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    address: "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
    name: "Ingrid Salm",
    role: "arbiter",
    blurb: "Security researcher — resolves disputes, SBT-staked",
  },
];

/* ── relay RPC (same-origin → anvil) ────────────────────────────────────── */

export function relayRpcUrl(): string {
  if (typeof window !== "undefined") return `${window.location.origin}/api/rpc`;
  return "http://localhost:3000/api/rpc";
}

export async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(relayRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export async function fetchBalance(address: string): Promise<bigint> {
  return rpc<bigint>("eth_getBalance", [address, "latest"]);
}

/* ── wallet store ───────────────────────────────────────────────────────── */

type WalletKind = "persona" | "injected";

interface WalletState {
  kind: WalletKind | null;
  personaIndex: number | null;
  address: string | null;
  connectPersona: (index: number) => void;
  connectInjected: () => Promise<void>;
  disconnect: () => void;
}

export const useWallet = create<WalletState>()(
  persist(
    (set) => ({
      kind: null,
      personaIndex: null,
      address: null,
      connectPersona: (index) => {
        const p = PERSONAS[index];
        if (!p) return;
        set({ kind: "persona", personaIndex: index, address: p.address });
      },
      connectInjected: async () => {
        if (typeof window === "undefined" || !window.ethereum) throw new Error("No injected wallet detected");
        const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (!accounts?.length) throw new Error("No accounts returned");
        set({ kind: "injected", personaIndex: null, address: accounts[0]!.toLowerCase() });
        void window.ethereum.on?.("accountsChanged", (accs: string[]) => {
          if (!accs?.length) set({ kind: null, personaIndex: null, address: null });
          else set({ address: accs[0]!.toLowerCase() });
        });
      },
      disconnect: () => set({ kind: null, personaIndex: null, address: null }),
    }),
    {
      name: "el:wallet",
      partialize: (s) => ({ kind: s.kind, personaIndex: s.personaIndex, address: s.address }),
    },
  ),
);

/* ── signing + sending ──────────────────────────────────────────────────── */

function personaAccount(): PrivateKeyAccount {
  const index = useWallet.getState().personaIndex;
  if (useWallet.getState().kind !== "persona" || index === null) throw new Error("No persona wallet connected");
  return privateKeyToAccount(PERSONAS[index]!.key);
}

export function hasInjected(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

/** EIP-191 personal_sign — returns a 0x hex signature. */
export async function signMessage(message: string): Promise<string> {
  const state = useWallet.getState();
  if (!state.address) throw new Error("No wallet connected");
  if (state.kind === "persona") {
    return personaAccount().signMessage({ message });
  }
  // injected: convert UTF-8 → hex bytes for personal_sign
  const hex = `0x${Array.from(new TextEncoder().encode(message))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  return (await window.ethereum!.request({ method: "personal_sign", params: [hex, state.address] })) as string;
}

/** Sign + send a contract call. Returns the tx hash. */
export async function sendContractCall(opts: {
  to: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: bigint;
}): Promise<string> {
  const state = useWallet.getState();
  if (!state.address) throw new Error("No wallet connected");
  const data = encodeFunctionData({ abi: opts.abi, functionName: opts.functionName, args: opts.args ?? [] });

  if (state.kind === "injected") {
    return (await window.ethereum!.request({
      method: "eth_sendTransaction",
      params: [{ from: state.address, to: opts.to, data, ...(opts.value ? { value: `0x${opts.value.toString(16)}` } : {}) }],
    })) as string;
  }

  // persona: sign a legacy tx locally, push the raw bytes through the relay
  const account = personaAccount();
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc<string>("eth_getTransactionCount", [state.address, "latest"]),
    rpc<string>("eth_gasPrice", []),
  ]);
  const gasHex = await rpc<string>("eth_estimateGas", [{ from: state.address, to: opts.to, data, ...(opts.value ? { value: `0x${opts.value.toString(16)}` } : {}) }]).catch(() => "0x7a120");
  const signed = await account.signTransaction({
    chainId: CHAIN_ID,
    to: opts.to as `0x${string}`,
    data: data as `0x${string}`,
    value: opts.value ?? 0n,
    gas: BigInt(gasHex ?? "0x7a120") || 300000n,
    gasPrice: BigInt(gasPriceHex ?? "0x3b9aca00") || 1_000_000_000n,
    nonce: Number(BigInt(nonceHex ?? "0x0")),
    type: "legacy",
  });
  return rpc<string>("eth_sendRawTransaction", [signed]);
}

/** Wait for a receipt via the relay. */
export async function waitForReceipt(hash: string, timeoutMs = 30_000): Promise<{ status: "success" | "reverted"; blockNumber: number }> {
  const started = Date.now();
  for (;;) {
    const receipt = await rpc<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      return { status: receipt.status === "0x1" ? "success" : "reverted", blockNumber: Number(BigInt(receipt.blockNumber)) };
    }
    if (Date.now() - started > timeoutMs) throw new Error("Transaction not mined within 30s");
    await new Promise((r) => setTimeout(r, 700));
  }
}

export function personaForAddress(address: string | undefined | null): Persona | undefined {
  if (!address) return undefined;
  return PERSONAS.find((p) => p.address.toLowerCase() === address.toLowerCase());
}
