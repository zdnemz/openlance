"use client";

/** Header wallet control: connect → sign-in → session chip with menu. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useWalletHydrated, fetchBalance } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { loginWithWallet, disconnectAndLogout } from "@/lib/siwe";
import { ConnectPanel } from "@/components/wallet/connect-panel";
import { ROLE_HOME } from "@/lib/role-routes";
import { AddressAvatar, press } from "@/components/design";
import { shortAddress } from "@/lib/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SealCheck, SignOut, UserCircle, Copy, Check, Spinner } from "@phosphor-icons/react";
import Link from "next/link";
import { toast } from "sonner";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const { address } = useWallet();
  const hydrated = useWalletHydrated();
  const session = useSession();
  const router = useRouter();

  const signedIn = !!session.token && !!address && session.boundAddress === address.toLowerCase();

  // A write moves the balance without changing `address`, so reading once on
  // connect left the pill showing the pre-transaction number (a deposit looked
  // like it never left the wallet). Re-read on a slow tick and on focus.
  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let alive = true;
    const read = () => {
      void fetchBalance(address)
        .then((wei) => {
          if (alive) setBalance((Number(wei) / 1e18).toFixed(2));
        })
        .catch(() => {});
    };
    read();
    const tick = setInterval(read, 10_000);
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      clearInterval(tick);
      window.removeEventListener("focus", read);
    };
  }, [address]);

  const signIn = async () => {
    if (!address || signing) return;
    setSigning(true);
    try {
      await loginWithWallet(address);
      toast.success("Signed in", { description: "Session token issued by the API." });
      // The proxy owns the seat decision: the verify response stamped
      // `el_onboarded` + `el_role`, so a registered user goes straight to the
      // app and an unfinished one is bounced back to /onboarding.
      router.replace(ROLE_HOME);
    } catch (err) {
      toast.error("Sign-in failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSigning(false);
    }
  };

  // Persisted wallet: stable placeholder until localStorage rehydrates, so the
  // server-rendered markup matches the first client render.
  if (!hydrated) {
    return (
      <span className="inline-flex h-[38px] w-[128px] animate-pulse border border-line bg-white/[0.03]" aria-hidden />
    );
  }

  if (!address) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className={`inline-flex items-center gap-2 bg-rose-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-rose-bright ${press}`}
        >
          Connect wallet
        </button>
        <ConnectPanel open={panelOpen} onOpenChange={setPanelOpen} />
      </>
    );
  }

  if (!signedIn) {
    return (
      <div className="flex items-center gap-2">
        <span className="num hidden border border-line bg-white/[0.03] px-3 py-2 text-xs text-dim sm:block">
          {shortAddress(address, 4)}
        </span>
        <button
          type="button"
          onClick={signIn}
          disabled={signing}
          className={`inline-flex items-center gap-2 bg-rose-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-rose-bright disabled:opacity-60 ${press}`}
        >
          {signing ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <SealCheck weight="bold" className="h-3.5 w-3.5" />}
          Prove ownership
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {!compact && balance && (
        <span className="num hidden border border-line bg-white/[0.03] px-3 py-2 text-xs text-dim md:block">
          {balance} ETH
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`flex items-center gap-2.5 border border-line bg-white/[0.04] py-1.5 pl-1.5 pr-3.5 text-left hover:border-line-strong ${press}`}
          >
            <AddressAvatar address={address} size={28} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium leading-tight">
                    {session.user?.displayName ?? shortAddress(address, 4)}
                  </span>
                  {session.user?.kycStatus === "verified" && <SealCheck weight="fill" className="h-3 w-3 shrink-0 text-state-released" />}
                </span>
                <span className="num block text-[11px] leading-tight text-faint">
                  {/* Role only — the seal above already says verified, and the
                      unverified states have their own prompts (onboarding). */}
                  {session.user ? session.user.role : shortAddress(address, 4)}
                </span>
              </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-raised w-56 border-line">
          <DropdownMenuLabel className="num text-[11px] text-faint">
            <button
              className="flex w-full items-center gap-1.5 text-left hover:text-foreground"
              onClick={() => {
                // A permission-denied clipboard rejects with no handler, so the
                // promise escaped unhandled — and the check-mark still appeared,
                // telling the user the address was copied when it was not.
                void navigator.clipboard
                  ?.writeText(address)
                  .then(() => setCopied(true))
                  .catch(() => toast.error("Could not copy", { description: "Your browser blocked clipboard access." }))
                  .finally(() => setTimeout(() => setCopied(false), 1200));
              }}
            >
              {shortAddress(address)}
              {copied ? <Check className="h-3 w-3 text-state-released" /> : <Copy className="h-3 w-3 opacity-50" />}
            </button>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-white/[0.06]" />
          <DropdownMenuItem asChild className="gap-2 text-sm">
            <Link href="/profile/me">
              <UserCircle className="h-4 w-4" /> My profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-sm"
            onClick={async () => {
              await disconnectAndLogout();
              toast("Signed out");
            }}
          >
            <SignOut className="h-4 w-4" /> Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
