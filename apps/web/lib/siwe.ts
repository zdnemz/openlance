"use client";

/**
 * SIWE → API JWT session (EIP-4361), real injected wallets only.
 * The nonce endpoint returns the server's expected domain/chainId/statement,
 * so the message always matches verification no matter which host serves UI.
 */
import { get, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { signMessage, signTypedData, useWallet } from "@/lib/wallet";
import { useSponsorship } from "@/lib/sponsorship-store";
import { getAddress } from "viem";
import type { PublicUser } from "@/lib/types";

interface NonceResponse {
  nonce: string;
  expiresInSeconds: number;
  siwe: { domain: string; chainId: number; statement: string };
}

export function buildSiweMessage(args: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}): string {
  return [
    `${args.domain} wants you to sign in with your Ethereum account:`,
    args.address,
    "",
    args.statement,
    "",
    `URI: ${args.uri}`,
    "Version: 1",
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
    `Expiration Time: ${args.expirationTime}`,
  ].join("\n");
}

interface VoucherChallengeResponse {
  enabled: boolean;
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: { owner: string; issuedAt: number; expiry: number; sessionId: `0x${string}` };
  forwardRequestTypes: Record<string, unknown>;
  sessionId: `0x${string}`;
}

/** Throws Error with a human message on any failure. */
export async function loginWithWallet(address: string): Promise<void> {
  // EXACTLY ONE signature per login, whichever path runs:
  //   • forwarder configured → one EIP-712 voucher that logs you in AND arms
  //     gasless (same digest the contract verifies).
  //   • no forwarder          → one SIWE personal_sign, user-paid gas.
  //
  // The fallback therefore covers "voucher unavailable" and nothing else. It
  // must NOT catch a signing/verify failure: the user already declined (or we
  // already burned their signature) and silently re-prompting with a *different*
  // message is what turned one login into two wallet popups. Anything past the
  // challenge fetch propagates.
  let voucher: VoucherChallengeResponse | null = null;
  try {
    voucher = await get<VoucherChallengeResponse>(`/auth/voucher-challenge?address=${address}`);
  } catch {
    /* challenge endpoint unreachable — SIWE below */
  }
  const voucherDomain = voucher?.domain as { verifyingContract?: string } | undefined;
  if (voucher?.enabled && voucherDomain?.verifyingContract && voucher.message) {
    const signature = await signTypedData({
      domain: voucher.domain,
      types: voucher.types,
      primaryType: voucher.primaryType,
      message: { ...voucher.message },
    });
    const result = await post<{ token: string; user: PublicUser; sponsorship: { sessionId: string; expiresAt: string } }>("/auth/verify", {
      sessionId: voucher.message.sessionId,
      issuedAt: voucher.message.issuedAt,
      expiry: voucher.message.expiry,
      signature,
    });
    useSession.getState().setSession(result.token, result.user, address.toLowerCase());
    useSponsorship.getState().setSession({
      sessionId: result.sponsorship.sessionId as `0x${string}`,
      expiresAt: result.sponsorship.expiresAt,
      domain: voucher.domain,
      forwardRequestTypes: voucher.forwardRequestTypes,
    });
    return;
  }

  const nonceData = await get<NonceResponse>("/auth/nonce");
  const { nonce, siwe } = nonceData;
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const uri = typeof window !== "undefined" ? window.location.origin : `http://${siwe.domain}`;
  const message = buildSiweMessage({
    domain: siwe.domain,
    address: getAddress(address), // EIP-55 — the parser rejects non-checksummed addresses
    statement: siwe.statement,
    uri,
    chainId: siwe.chainId,
    nonce,
    issuedAt,
    expirationTime,
  });
  const signature = await signMessage(message);
  const result = await post<{ token: string; user: PublicUser }>("/auth/verify", {
    message,
    signature,
  });
  useSession.getState().setSession(result.token, result.user, address.toLowerCase());
  // No second signature here. This path is only reached when there is no
  // forwarder to sign a sponsorship voucher against, so arming one would cost
  // the user a second popup to gain nothing.
  //
  // Clear rather than leave whatever localStorage holds: the store persists
  // across logins, and a session minted by a PREVIOUS sign-in would otherwise
  // outlive this one — money actions would then take the gasless branch against
  // a voucher the server no longer has a row for.
  useSponsorship.getState().clear();
}

/**
 * Full logout: revoke the server JWT first (otherwise it stays replayable for
 * its 12h life), then drop the local session + wallet. Every disconnect button
 * must go through here — clearing the wallet alone is not a logout.
 */
export async function disconnectAndLogout(): Promise<void> {
  try {
    await post("/auth/logout");
  } catch {
    /* token already dead — clearing locally is what matters */
  }
  useSession.getState().clear();
  useSponsorship.getState().clear();
  useWallet.getState().disconnect();
}
