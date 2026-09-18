"use client";

/**
 * SIWE → API JWT session (EIP-4361), wallet-agnostic:
 * dev personas sign locally; injected browser wallets sign via their provider.
 * The nonce endpoint returns the server's expected domain/chainId/statement,
 * so the message always matches verification no matter which host serves UI.
 */
import { get, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import { signMessage } from "@/lib/wallet";
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

export async function logout() {
  try {
    await post("/auth/logout");
  } catch {
    /* token already dead — clearing locally is what matters */
  }
  useSession.getState().clear();
}
