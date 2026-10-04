"use client";

/**
 * Client-side gasless relaying.
 *
 *   login        → lib/siwe.ts  (ONE signature: the voucher doubles as the login)
 *   money action → relayForwardRequest()  (per-action signature; no gas)
 *
 * The user NEVER pays gas for sponsored actions: the server relayer submits the
 * meta-tx. The EIP-712 session voucher lives for the login session (JWT TTL).
 *
 * There is deliberately no "arm gasless after login" call: a second signature
 * at login is the thing this design exists to prevent. A deployment with a
 * forwarder gets gasless from the login voucher itself; one without cannot
 * relay at all, so an extra popup would buy nothing.
 */
import { post } from "@/lib/api";
import { signTypedData, useWallet } from "@/lib/wallet";
import { useSponsorship } from "@/lib/sponsorship-store";
import { useRuntime } from "@/lib/runtime";
import { encodeFunctionData, type Abi } from "viem";

/**
 * Sign a ForwardRequest and hand it to the relayer. Returns the tx hash.
 * Throws if there is no active session (caller should fall back to user-paid).
 */
export async function relayForwardRequest(opts: {
  to: string;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  value?: bigint;
  gas?: bigint;
}): Promise<string> {
  const state = useSponsorship.getState();
  const wallet = useWallet.getState();
  if (!state.sessionId || !state.expiresAt || !wallet.address) throw new Error("No active sponsorship session");
  if (new Date(state.expiresAt).getTime() < Date.now()) throw new Error("Sponsorship session expired");

  const data = encodeFunctionData({ abi: opts.abi, functionName: opts.functionName, args: opts.args ?? [] });

  // Per-user nonce: the forwarder uses OZ Nonces(owner). The backend tracks the
  // count; here we ask for the next nonce via the challenge-free counter the
  // server maintains. Simplest robust approach: the server owns the nonce, so we
  // sign a request with the nonce it returns.
  const prepared = await post<{ request: RelayRequestWire; sessionId: `0x${string}`; types: Record<string, unknown>; domain: Record<string, unknown> }>(
    "/relay/prepare",
    { to: opts.to, value: (opts.value ?? 0n).toString(), gas: (opts.gas ?? 1_000_000n).toString(), data },
  );

  // Sign only what we asked for. The server echoes the request back with its
  // nonce and deadline; signing that echo unchecked let a compromised API get a
  // valid signature for ANY call (e.g. fundFromCredit to its own wallet).
  const forwarder = useRuntime.getState().sponsorshipForwarder;
  const r = prepared.request;
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  if (
    !same(r.from, wallet.address) || !same(r.to, opts.to) || !same(r.data, data)
    || BigInt(r.value) !== (opts.value ?? 0n) || BigInt(r.gas) > (opts.gas ?? 1_000_000n)
    || (forwarder && !same((prepared.domain as { verifyingContract?: string }).verifyingContract, forwarder))
  ) {
    throw new Error("Relay request does not match the action — refusing to sign");
  }

  // EIP-712 uint fields must be bigint/number in the signed message (wallets
  // reject string-encoded integers against uint types).
  const message = {
    from: prepared.request.from,
    to: prepared.request.to,
    value: BigInt(prepared.request.value),
    gas: BigInt(prepared.request.gas),
    nonce: BigInt(prepared.request.nonce),
    deadline: prepared.request.deadline,
    data: prepared.request.data,
    sessionId: prepared.sessionId,
  };

  const signature = await signTypedData({
    domain: prepared.domain,
    types: prepared.types,
    primaryType: "ForwardRequest",
    message,
  });

  const result = await post<{ txHash: string }>("/relay", {
    request: prepared.request,
    sessionId: prepared.sessionId,
    signature,
  });
  return result.txHash;
}

/** Wire shape mirrored by the backend relay schema. */
export interface RelayRequestWire {
  from: string;
  to: string;
  value: string;
  gas: string;
  nonce: string;
  deadline: number;
  data: string;
}
