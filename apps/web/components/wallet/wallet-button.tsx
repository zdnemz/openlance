"use client";

/** Header wallet control: connect → sign-in → session chip with menu. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useWalletHydrated, fetchBalance } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { loginWithWallet, disconnectAndLogout } from "@/lib/siwe";
import { ConnectPanel } from "@/components/wallet/connect-panel";
import { ROLE_HOME } from "@/lib/role-routes";
import { AddressAvatar } from "@/components/design";
import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, Copy, SealCheck, SignOut, Spinner, UserCircle } from "@/components/icons";
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
      <span className="inline-flex h-11 w-[150px] animate-pulse border-2 border-line bg-ink-raised" aria-hidden />
    );
  }

  if (!address) {
    return (
      <>
        <Button size="sm" onClick={() => setPanelOpen(true)}>
          Connect wallet
        </Button>
        <ConnectPanel open={panelOpen} onOpenChange={setPanelOpen} />
      </>
    );
  }

  if (!signedIn) {
    return (
      <div className="flex items-center gap-2">
        <span className="num hidden border-2 border-line bg-ink-raised px-3 py-2 text-xs text-dim sm:block">
          {shortAddress(address, 4)}
        </span>
        <Button size="sm" onClick={signIn} disabled={signing}>
          {signing ? <Spinner className="h-4 w-4 animate-spin" /> : <SealCheck weight="bold" className="h-4 w-4" />}
          Prove ownership
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {!compact && balance && (
        <span className="num hidden border-2 border-line bg-ink-raised px-3 py-2 text-xs text-dim md:block">
          {balance} ETH
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="pixel-press flex min-h-11 cursor-pointer items-center gap-2.5 border-2 border-line-strong bg-ink-raised py-0.5 pl-0.5 pr-3 text-left transition-colors hover:border-rose-light"
          >
            <AddressAvatar address={address} size={36} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium leading-tight">
                    {session.user?.displayName ?? shortAddress(address, 4)}
                  </span>
                  {session.user?.kycStatus === "verified" && <SealCheck weight="fill" className="h-4 w-4 shrink-0 text-state-released" />}
                </span>
                <span className="num block text-[13px] leading-tight text-faint">
                  {/* Role only — the seal above already says verified, and the
                      unverified states have their own prompts (onboarding). */}
                  {session.user ? session.user.role : shortAddress(address, 4)}
                </span>
              </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="num font-normal text-faint">
            <button
              className="flex min-h-8 w-full cursor-pointer items-center gap-2 text-left font-sans text-[14px] normal-case hover:text-foreground"
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
              {copied ? <Check className="h-4 w-4 text-state-released" /> : <Copy className="h-4 w-4 opacity-60" />}
            </button>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-2 text-sm">
            <Link href="/profile/me">
              <UserCircle className="h-5 w-5" /> My profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-sm"
            onClick={async () => {
              await disconnectAndLogout();
              toast("Signed out");
            }}
          >
            <SignOut className="h-5 w-5" /> Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
