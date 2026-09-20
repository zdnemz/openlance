"use client";

/**
 * Client-side gasless sponsorship.
 *
 *   loginWithWallet() → beginSponsorshipSession()   (ONE EIP-712 signature)
 *   money action      → relayForwardRequest()        (per-action signature; no gas)
 *
 * The user NEVER pays gas for sponsored actions: the server relayer submits the
 * meta-tx. The EIP-712 session voucher lives for the login session (JWT TTL).
 */
import { get, post } from "@/lib/api";
import { signTypedData, useWallet } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { useSponsorship } from "@/lib/sponsorship-store";
import { encodeFunctionData, type Abi } from "viem";

interface ChallengeResponse {
  enabled: boolean;
  domain: { name: string; version: string; chainId: number; verifyingContract: string | null };
  types: Record<string, unknown>;
  primaryType: string;
  message: { owner: string; issuedAt: number; expiry: number; sessionId: `0x${string}` };
  forwardRequestTypes: Record<string, unknown>;
  sessionId: `0x${string}`;
}

/**
 * Runs immediately after a successful SIWE login: fetches the challenge, signs
 * ONE EIP-712 SponsorshipSession voucher, and stores it server-side + locally.
 * Non-fatal — if sponsorship is disabled or the user declines, money actions
 * simply fall back to normal user-paid gas.
 */
export async function beginSponsorshipSession(): Promise<boolean> {
  try {
    const challenge = await get<ChallengeResponse>("/auth/sponsorship");
    if (!challenge.enabled || !challenge.domain.verifyingContract) {
      useSponsorship.getState().clear();
      return false;
    }
    const signature = await signTypedData({
      domain: challenge.domain,
      types: challenge.types,
      primaryType: challenge.primaryType,
      message: challenge.message,
    });
    const stored = await post<{ sessionId: string; expiresAt: string }>("/auth/sponsorship", {
      sessionId: challenge.message.sessionId,
      issuedAt: challenge.message.issuedAt,
      expiry: challenge.message.expiry,
      signature,
    });
    useSponsorship.getState().setSession({
      sessionId: stored.sessionId as `0x${string}`,
      expiresAt: stored.expiresAt,
      domain: challenge.domain,
      forwardRequestTypes: challenge.forwardRequestTypes,
    });
    return true;
  } catch {
    // Declined / unsupported wallet / disabled → stay on the user-paid path.
    useSponsorship.getState().clear();
    return false;
  }
}

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
