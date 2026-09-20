"use client";

/**
 * Wallet layer — real injected wallets only (viem + EIP-1193, no wagmi).
 *
 * Real-only: the deterministic anvil persona keys are gone. Users connect
 * their own browser wallet (MetaMask / Coinbase / Rabby). Chain is
 * env-driven (CHAIN_ID / CHAIN_RPC_URL via /overview runtime); reads ride
 * the same-origin /api/rpc relay, writes go through the injected provider
 * after a chainId check + automatic switch/add.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { encodeFunctionData, decodeFunctionResult, type Abi } from "viem";

export const FALLBACK_CHAIN_ID = 31337;

/** Chain metadata for wallet_addEthereumChain (anvil + Base Sepolia). */
function chainParams(chainId: number, rpcUrl?: string) {
  if (chainId === 84532)
    return {
      chainId: `0x${chainId.toString(16)}`,
      chainName: "Base Sepolia",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: [rpcUrl || "https://sepolia.base.org"],
      blockExplorerUrls: ["https://sepolia.basescan.org"],
    };
  return {
    chainId: `0x${chainId.toString(16)}`,
    chainName: "Anvil Devnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: [rpcUrl || `${typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/api/rpc`],
    blockExplorerUrls: [],
  };
}

/** Ensure the injected wallet sits on the expected chain; switch/add if needed. */
export async function ensureChain(expectedChainId: number, rpcUrl?: string): Promise<void> {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("No injected wallet detected");
  const current = (await window.ethereum.request({ method: "eth_chainId" })) as string;
  if (Number(current) === expectedChainId) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${expectedChainId.toString(16)}` }],
    });
  } catch (err) {
    const e = err as { code?: number };
    if (e?.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [chainParams(expectedChainId, rpcUrl)] });
    } else throw err;
  }
}

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

/* ── relay RPC (same-origin → env chain) ────────────────────────────────── */

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

/**
 * Read a contract function through the relay (eth_call). Used by the UI to
 * fetch live round/arbiter state straight from the chain — money-relevant
 * truth is always re-derived from the contract, never trusted from the API.
 */
export async function readContract<T = unknown>(opts: {
  to: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  /** Called with the revert/transport reason on failure (reads stay null-safe). */
  onError?: (functionName: string, message: string) => void;
}): Promise<T | null> {
  const fail = (message: string) => {
    opts.onError?.(opts.functionName, message);
    return null;
  };
  try {
    const data = encodeFunctionData({ abi: opts.abi, functionName: opts.functionName, args: opts.args ?? [] });
    const raw = await rpc<`0x${string}` | null>("eth_call", [{ to: opts.to, data }, "latest"]);
    if (!raw || raw === "0x") return fail("empty response — no contract code at target?");
    try {
      return decodeFunctionResult({ abi: opts.abi, functionName: opts.functionName, data: raw }) as T;
    } catch (err) {
      return fail(`decode failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/* ── wallet store (injected only) ─────────────────────────────────────── */

interface WalletState {
  kind: "injected" | null;
  address: string | null;
  connectInjected: (expectedChainId?: number, rpcUrl?: string) => Promise<void>;
  disconnect: () => void;
}

export const useWallet = create<WalletState>()(
  persist(
    (set) => ({
      kind: null,
      address: null,
      connectInjected: async (expectedChainId, rpcUrl) => {
        if (typeof window === "undefined" || !window.ethereum) throw new Error("No injected wallet detected — install MetaMask, Coinbase, or Rabby");
        // eth_requestAccounts silently returns the last-authorized account, so
        // returning users never get a choice. Requesting permissions first
        // forces the wallet's account picker every single connect.
        try {
          await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
        } catch (err) {
          const code = (err as { code?: number })?.code;
          if (code === 4001) throw new Error("Connection request rejected");
          // No permission API (-32601 etc.) → fall through; the accounts call
          // below still connects, just without forcing the picker.
        }
        const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (!accounts?.length) throw new Error("No accounts returned");
        if (expectedChainId) await ensureChain(expectedChainId, rpcUrl);
        set({ kind: "injected", address: accounts[0]!.toLowerCase() });
        void window.ethereum.on?.("accountsChanged", (...args: unknown[]) => {
          const accs = args[0] as string[] | undefined;
          if (!accs?.length) set({ kind: null, address: null });
          else set({ address: accs[0]!.toLowerCase() });
        });
        void window.ethereum.on?.("chainChanged", () => window.location.reload());
      },
      disconnect: () => set({ kind: null, address: null }),
    }),
    {
      name: "el:wallet",
      partialize: (s) => ({ kind: s.kind, address: s.address }),
    },
  ),
);

/**
 * True once the persisted wallet has been rehydrated from localStorage.
 *
 * SSR + the first client render both see `address: null`; zustand/persist then
 * reads localStorage and flips in `address`, which changes rendered markup and
 * trips React's hydration check. Components that branch on `address` MUST gate
 * on this hook and render a stable placeholder until it returns true.
 *
 * Backed by `useSyncExternalStore` so the server snapshot is `false` (SSR and
 * the first client render agree) and the value flips reactively when rehydrate
 * lands. `persist` is absent on the server, so every access is guarded.
 */
export function useWalletHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => useWallet.persist?.onFinishHydration(onChange) ?? (() => {}),
    () => useWallet.persist?.hasHydrated() ?? true,
    () => false,
  );
}

/* ── signing + sending (injected only) ─────────────────────────────────── */

export function hasInjected(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

/** EIP-191 personal_sign via the injected provider — returns a 0x hex signature. */
export async function signMessage(message: string): Promise<string> {
  const state = useWallet.getState();
  if (!state.address) throw new Error("No wallet connected");
  // injected: convert UTF-8 → hex bytes for personal_sign
  const hex = `0x${Array.from(new TextEncoder().encode(message))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  return (await window.ethereum!.request({ method: "personal_sign", params: [hex, state.address] })) as string;
}

/**
 * EIP-712 `eth_signTypedData_v4` via the injected provider.
 *
 * Used by gasless sponsorship: the user signs a SponsorshipSession voucher once
 * at login and a ForwardRequest per money action. Unlike `personal_sign` this
 * shows structured data (human-readable) in the wallet, which is the whole point
 * of using EIP-712 rather than a replayable hash.
 */
export async function signTypedData(args: {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}): Promise<string> {
  const state = useWallet.getState();
  if (!state.address) throw new Error("No wallet connected");
  if (typeof window === "undefined" || !window.ethereum) throw new Error("No injected wallet detected");
  const payload = JSON.stringify({
    domain: args.domain,
    types: { EIP712Domain: [], ...args.types },
    primaryType: args.primaryType,
    message: args.message,
  });
  return (await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [state.address, payload],
  })) as string;
}

/** Sign + send a contract call. Returns the tx hash. */
export async function sendContractCall(opts: {
  to: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: bigint;
  /** Reject before signing when the wallet sits on another chain (wrong-chain sends revert or mis-fire). */
  expectedChainId?: number;
}): Promise<string> {
  const state = useWallet.getState();
  if (!state.address) throw new Error("No wallet connected");
  if (opts.expectedChainId) await ensureChain(opts.expectedChainId);
  const data = encodeFunctionData({ abi: opts.abi, functionName: opts.functionName, args: opts.args ?? [] });

  return (await window.ethereum!.request({
    method: "eth_sendTransaction",
    params: [{ from: state.address, to: opts.to, data, ...(opts.value ? { value: `0x${opts.value.toString(16)}` } : {}) }],
  })) as string;
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

/** Read the active chainId from the injected provider (null when disconnected). */
export async function activeChainId(): Promise<number | null> {
  try {
    const id = (await window.ethereum!.request({ method: "eth_chainId" })) as string;
    return Number(id);
  } catch {
    return null;
  }
}
