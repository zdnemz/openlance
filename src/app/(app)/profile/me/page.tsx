"use client";

/** /profile/me — your card, and the ONLY place it is editable. */
import Link from "next/link";
import { useSession, useSessionHydrated } from "@/lib/session";
import { useWalletHydrated } from "@/lib/wallet";
import { EmptyState, Skeleton } from "@/components/design";
import { ProfileView } from "@/components/profile-view";

export default function MyProfilePage() {
  const session = useSession();
  const sessionHydrated = useSessionHydrated();
  const walletHydrated = useWalletHydrated();
  const ready = sessionHydrated && walletHydrated;

  if (!ready) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-36 w-full rounded-3xl" />
        <Skeleton className="h-64 w-full rounded-3xl" />
      </div>
    );
  }

  const address = session.token ? session.user?.walletAddress : undefined;
  if (!address) {
    return (
      <EmptyState
        className="mt-16"
        title="Your profile lives behind your key"
        body="Connect a wallet and prove ownership — then this page is yours to edit."
        action={<Link href="/onboarding" className="text-sm text-rose-bright hover:underline">Go to onboarding</Link>}
      />
    );
  }
  return <ProfileView address={address} allowEdit />;
}
