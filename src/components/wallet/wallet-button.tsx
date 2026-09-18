"use client";

/** Header wallet control: connect → sign-in → session chip with menu. */
import { useEffect, useState } from "react";
import { useWallet, fetchBalance, personaForAddress } from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { loginWithWallet, logout } from "@/lib/siwe";
import { ConnectPanel } from "@/components/wallet/connect-panel";
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
  const { address, disconnect } = useWallet();
  const session = useSession();

  const persona = personaForAddress(address);
  const signedIn = !!session.token && !!address && session.boundAddress === address.toLowerCase();

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let alive = true;
    void fetchBalance(address)
      .then((wei) => {
        if (alive) setBalance((Number(wei) / 1e18).toFixed(2));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);

  const signIn = async () => {
    if (!address || signing) return;
    setSigning(true);
    try {
      await loginWithWallet(address);
      toast.success("Signed in", { description: "Session token issued by the API." });
    } catch (err) {
      toast.error("Sign-in failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSigning(false);
    }
  };

  if (!address) {
    return (
      <>
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className={`inline-flex items-center gap-2 rounded-full bg-rose-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-rose-bright ${press}`}
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
        <span className="num hidden rounded-full border border-line bg-white/[0.03] px-3 py-2 text-xs text-dim sm:block">
          {shortAddress(address, 4)}
        </span>
        <button
          type="button"
          onClick={signIn}
          disabled={signing}
          className={`inline-flex items-center gap-2 rounded-full bg-rose-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-rose-bright disabled:opacity-60 ${press}`}
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
        <span className="num hidden rounded-full border border-line bg-white/[0.03] px-3 py-2 text-xs text-dim md:block">
          {balance} ETH
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`flex items-center gap-2.5 rounded-full border border-line bg-white/[0.04] py-1.5 pl-1.5 pr-3.5 text-left hover:border-line-strong ${press}`}
          >
            <AddressAvatar address={address} size={28} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium leading-tight">
                  {session.user?.displayName ?? persona?.name ?? shortAddress(address, 4)}
                </span>
                {persona && <SealCheck weight="fill" className="h-3 w-3 shrink-0 text-rose-bright" />}
              </span>
              <span className="num block text-[10px] leading-tight text-faint">
                {persona ? persona.role : shortAddress(address, 4)}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-raised w-56 rounded-2xl border-line">
          <DropdownMenuLabel className="num text-[11px] text-faint">
            <button
              className="flex w-full items-center gap-1.5 text-left hover:text-foreground"
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {shortAddress(address)}
              {copied ? <Check className="h-3 w-3 text-state-released" /> : <Copy className="h-3 w-3 opacity-50" />}
            </button>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-white/[0.06]" />
          <DropdownMenuItem asChild className="gap-2 rounded-lg text-sm">
            <Link href={`/profile/${address}`}>
              <UserCircle className="h-4 w-4" /> Public profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 rounded-lg text-sm"
            onClick={async () => {
              await logout();
              disconnect();
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
