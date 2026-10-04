"use client";

/**
 * Connect panel — real wallets only.
 * Injected provider (MetaMask / Coinbase / Rabby) → chain check/switch
 * (env CHAIN_ID via runtime) → SIWE sign-in. No personas, no dev keys.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { press } from "@/components/design";
import { useWallet, hasInjected } from "@/lib/wallet";
import { useRuntime } from "@/lib/runtime";
import { loginWithWallet, disconnectAndLogout } from "@/lib/siwe";
import { useSession } from "@/lib/session";
import { ROLE_HOME } from "@/lib/role-routes";
import { Info, Plugs, Spinner, Wallet } from "@/components/icons";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function ConnectPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { connectInjected, address } = useWallet();
  const chainId = useRuntime((s) => s.chainId);
  // `chainId` defaults to 31337 until /overview answers, and `load()` swallows
  // its error — so a fast click (or an API blip) ran `ensureChain(31337)` and
  // walked a Base Sepolia user onto Anvil while the copy said otherwise.
  const runtimeLoaded = useRuntime((s) => s.loaded);
  const session = useSession();
  const router = useRouter();
  const [signingIn, setSigningIn] = useState(false);
  const injectedAvailable = hasInjected();

  async function connectReal() {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await connectInjected(chainId);
      const addr = useWallet.getState().address;
      if (!addr) throw new Error("No account returned");
      if (session.token && session.boundAddress === addr.toLowerCase()) {
        onOpenChange(false);
        return;
      }
      await loginWithWallet(addr);
      toast.success("Signed in", { description: "SIWE session issued — identity follows your key." });
      onOpenChange(false);
      // Always aim at the seat home and let the proxy decide. The verify
      // response just stamped `el_onboarded` + `el_role` from the server, so a
      // registered user lands in the app (and /onboarding is one-way) while a
      // new one is bounced straight back — no client-side guess, and no
      // re-entering onboarding from here.
      router.replace(ROLE_HOME);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (!/reject|denied/i.test(message)) toast.error("Wallet or sign-in failed", { description: message });
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-raised max-w-md gap-0 border-line p-0">
        <DialogHeader className="space-y-2 px-7 pb-5 pt-7">
          <DialogTitle className="text-xl tracking-tight">Connect your wallet</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-dim">
            Real wallet, real keys. Your browser wallet signs a SIWE message — no passwords, no custodial accounts.
            New here? After connecting you pick a role (client / freelancer / arbiter) and verify identity.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 pb-4">
          <button
            type="button"
            disabled={!injectedAvailable || signingIn || !runtimeLoaded}
            onClick={() => void connectReal()}
            className={`flex w-full items-center justify-center gap-3 px-5 py-4 text-sm font-medium text-white ${press} ${              injectedAvailable && runtimeLoaded ? "bg-rose-accent hover:bg-rose-bright" : "cursor-not-allowed bg-white/[0.06] text-faint"
            }`}
          >
            {signingIn ? <Spinner className="h-4 w-4 animate-spin" /> : injectedAvailable ? <Wallet weight="bold" className="h-4 w-4" /> : <Plugs className="h-4 w-4" />}
            {signingIn
              ? "Waiting for signature…"
              : !runtimeLoaded
                ? "Reading chain config…"
                : injectedAvailable ? "Connect browser wallet" : "No browser wallet detected"}
          </button>
          <p className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-relaxed text-faint">
            <Info className="mt-px h-3 w-3 shrink-0" />
            {injectedAvailable
              ? runtimeLoaded
                ? `We will ask your wallet to switch to chain ${chainId} if needed, then request one signature (SIWE). Testnet only — no real funds.`
                : "Waiting for the API to report which chain this deployment uses."
              : "Install MetaMask, Coinbase Wallet, or Rabby, then reload. Mobile wallets work via their in-app browser."}
          </p>
          {address && (
            <button
              type="button"
              onClick={() => {
                void disconnectAndLogout().then(() => onOpenChange(false));
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
