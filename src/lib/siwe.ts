"use client";

/**
 * SIWE → API JWT session (EIP-4361), real injected wallets only.
 * The nonce endpoint returns the server's expected domain/chainId/statement,
 * so the message always matches verification no matter which host serves UI.
 */
import { get, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { signMessage, useWallet } from "@/lib/wallet";
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

/** Throws Error with a human message on any failure. */
export async function loginWithWallet(address: string): Promise<void> {
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
  useWallet.getState().disconnect();
}
