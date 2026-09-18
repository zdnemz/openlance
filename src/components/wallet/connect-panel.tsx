"use client";

/**
 * Connect panel — the hybrid wallet entry point:
 *  · five anvil personas (one click = connected + signed in)
 *  · injected browser wallets (MetaMask & friends) via window.ethereum
 * SIWE runs directly in the click handler: connect resolves the account,
 * then the signature is requested — one deliberate user gesture.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AddressAvatar, press } from "@/components/design";
import { PERSONAS, useWallet, hasInjected } from "@/lib/wallet";
import { loginWithWallet } from "@/lib/siwe";
import { useSession } from "@/lib/session";
import { Wallet, SealCheck, ArrowRight, Info, Plugs } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";

export function ConnectPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { connectPersona, connectInjected, disconnect, address } = useWallet();
  const session = useSession();
  const [signingIn, setSigningIn] = useState(false);
  const injectedAvailable = hasInjected();

  async function connectAndSignIn(wallet: () => void | Promise<void>, walletAddress: string) {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await wallet();
      if (session.token && session.boundAddress === walletAddress.toLowerCase()) {
        onOpenChange(false);
        return;
      }
      await loginWithWallet(walletAddress);
      toast.success("Signed in", { description: "Session token issued — you are who your key says you are." });
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (!/reject|denied/i.test(message)) {
        toast.error("Wallet or sign-in failed", { description: message });
      }
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-raised max-w-md gap-0 rounded-3xl border-line p-0">
        <DialogHeader className="space-y-2 px-7 pb-5 pt-7">
          <DialogTitle className="text-xl tracking-tight">Pick a seat at the table</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-dim">
            Devnet personas sign locally with public anvil test keys — instant, zero setup. Browser wallets ride the
            same surface through the injected provider.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto px-4 pb-4">
          {PERSONAS.map((persona, i) => {
            const active = address?.toLowerCase() === persona.address.toLowerCase();
            return (
              <button
                key={persona.address}
                type="button"
                disabled={signingIn}
                onClick={() => {
                  if (active) {
                    disconnect();
                    return;
                  }
                  void connectAndSignIn(() => connectPersona(i), persona.address);
                }}
                className={`group flex w-full items-center gap-4 rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 ${press} ${
                  active
                    ? "border-rose-accent/40 bg-rose-soft"
                    : "border-transparent hover:border-line hover:bg-white/[0.04]"
                } disabled:opacity-50`}
              >
                <AddressAvatar address={persona.address} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{persona.name}</span>
                    {active && <SealCheck weight="fill" className="h-3.5 w-3.5 text-rose-bright" />}
                  </span>
                  <span className="num mt-0.5 block truncate text-[11px] uppercase tracking-wider text-faint">
                    {persona.role}
                  </span>
                  <span className="mt-1 block truncate text-xs text-faint">{persona.blurb}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-70" />
              </button>
            );
          })}
        </div>

        <div className="hairline-t px-4 py-4">
          <button
            type="button"
            disabled={!injectedAvailable || signingIn}
            onClick={() => {
              if (!injectedAvailable || signingIn) return;
              setSigningIn(true);
              void (async () => {
                try {
                  await connectInjected();
                  const addr = useWallet.getState().address;
                  if (!addr) throw new Error("No account returned");
                  if (session.token && session.boundAddress === addr.toLowerCase()) {
                    onOpenChange(false);
                    return;
                  }
                  await loginWithWallet(addr);
                  toast.success("Signed in", { description: "Session token issued by the API." });
                  onOpenChange(false);
                } catch (err) {
                  const message = err instanceof Error ? err.message : "Unknown error";
                  if (!/reject|denied/i.test(message)) toast.error("Wallet or sign-in failed", { description: message });
                } finally {
                  setSigningIn(false);
                }
              })();
            }}
            className={`flex w-full items-center gap-3 rounded-2xl px-5 py-3.5 text-sm font-medium text-white transition-all ${press} ${
              injectedAvailable ? "bg-rose-accent hover:bg-rose-bright" : "cursor-not-allowed bg-white/[0.06] text-faint"
            }`}
          >
            {injectedAvailable ? <Wallet weight="bold" className="h-4 w-4" /> : <Plugs className="h-4 w-4" />}
            {injectedAvailable ? "Browser wallet — MetaMask / injected" : "No browser wallet detected"}
          </button>
          <p className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-relaxed text-faint">
            <Info className="mt-px h-3 w-3 shrink-0" />
            Browser wallets need the anvil network (chain 31337, RPC {typeof window !== "undefined" ? window.location.origin : ""}
            /api/rpc). Personas work everywhere, instantly.
          </p>
          {address && (
            <button
              type="button"
              onClick={() => {
                disconnect();
                onOpenChange(false);
              }}
              className="num mt-3 w-full text-center text-[11px] text-faint underline-offset-4 hover:text-dim hover:underline"
            >
              disconnect current wallet
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
