"use client";

/** /profile/:address — public identity: chain-derived stats, reviews, badge. */
import { use, useState } from "react";
import { useUser, useUserReviews, useArbiters, useProjects, useInvalidate, patch, post } from "@/lib/queries";
import { useSession } from "@/lib/session";
import {
  AddressAvatar, Chip, EthAmount, ListHead, Skeleton, EmptyState, StatusBadge, press, Copyable,
} from "@/components/design";
import { shortAddress, timeAgo, dateLabel } from "@/lib/format";
import { personaForAddress } from "@/lib/wallet";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useRegisterArbiter } from "@/lib/register-arbiter";

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const session = useSession();
  const { data: user, isLoading } = useUser(address);
  const { data: reviews } = useUserReviews(address);
  const { data: arbiters } = useArbiters();
  const arbiter = arbiters?.find((a) => a.address.toLowerCase() === address.toLowerCase());
  const isMe = session.user?.walletAddress?.toLowerCase() === address.toLowerCase() && !!session.token;
  const [editing, setEditing] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-36 w-full rounded-3xl" />
        <Skeleton className="h-64 w-full rounded-3xl" />
      </div>
    );
  }
  if (!user) {
    return <EmptyState title="No profile at that address" body="Profiles are created on first sign-in — the wallet IS the identity." />;
  }

  const persona = personaForAddress(address);
  const avgRating = reviews?.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null;

  return (
    <div className="space-y-9">
      {/* identity card */}
      <div className="glass rounded-3xl p-7 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-center gap-5">
            <AddressAvatar address={address} size={72} />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl font-semibold tracking-tight">{user.displayName ?? shortAddress(address)}</h1>
                {persona && <span className="num rounded-full bg-rose-soft px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-rose-bright">devnet persona</span>}
                {arbiter?.registered && (
                  <span className="flex items-center gap-1.5 rounded-full bg-state-split/10 px-2.5 py-0.5 text-[10.5px] text-state-split">
                    <SealCheck weight="fill" className="h-3.5 w-3.5" /> arbiter · trust {arbiter.trustScore}
                  </span>
                )}
              </div>
              <Copyable text={address} className="mt-1.5 text-[13px]">
                <span className="num text-dim">{shortAddress(address, 6)}</span>
              </Copyable>
              <div className="num mt-2 flex items-center gap-3 text-[11px] text-faint">
                <span>joined {dateLabel(user.createdAt)}</span>
                <span>role {user.role}</span>
              </div>
            </div>
          </div>
          {isMe && !editing && (
            <Button variant="ghost" onClick={() => setEditing(true)} className="rounded-full border border-line px-4 text-[12.5px] text-dim hover:text-foreground">
              <PencilSimple className="mr-2 h-3.5 w-3.5" /> Edit profile
            </Button>
          )}
        </div>

        {user.bio && !editing && <p className="mt-5 max-w-[58ch] text-[14px] leading-relaxed text-dim">{user.bio}</p>}
        {user.links && Object.keys(user.links).length > 0 && !editing && (
          <div className="num mt-4 flex flex-wrap gap-5 text-[12px]">
            {Object.entries(user.links).map(([k, v]) => (
              <a key={k} href={v} target="_blank" rel="noreferrer" className="text-rose-bright hover:underline">{k}</a>
            ))}
          </div>
        )}
        {user.skills.length > 0 && !editing && (
          <div className="mt-5 flex flex-wrap gap-2">{user.skills.map((s) => <Chip key={s}>{s}</Chip>)}</div>
        )}

        {editing && <EditProfile onDone={() => setEditing(false)} user={user} />}

        {/* chain-derived stats — derived, never writable */}
        <div className="mt-7 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-6 sm:grid-cols-4">
          <Stat label="earned" value={<EthAmount wei={user.stats.totalEarnedWei} />} tone="text-state-released" />
          <Stat label="paid via escrow" value={<EthAmount wei={user.stats.totalPaidWei} />} tone="text-state-submitted" />
          <Stat label="completed as freelancer" value={<span className="num">{user.stats.completedProjectsAsFreelancer}</span>} />
          <Stat label="completed as client" value={<span className="num">{user.stats.completedProjectsAsClient}</span>} />
        </div>
      </div>

      {/* reviews */}
      <section>
        <div className="flex items-baseline justify-between">
          <ListHead>Reviews received</ListHead>
          {avgRating !== null && (
            <span className="num flex items-center gap-1.5 text-[12px] text-dim">
              <Star weight="fill" className="h-3.5 w-3.5 text-amber-300" />
              {avgRating.toFixed(1)} · {reviews?.length} reviews
            </span>
          )}
        </div>
        {!reviews?.length ? (
          <EmptyState className="mt-4" title="No reviews yet" body="Reviews unlock after on-chain settlement — one per side per milestone, bound to the settlement tx." />
        ) : (
          <div className="mt-4 divide-y divide-white/[0.05] overflow-hidden rounded-3xl border border-line">
            {reviews.map((r) => (
              <div key={r.id} className="bg-white/[0.012] px-6 py-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} weight={n <= r.rating ? "fill" : "regular"} className={`h-3.5 w-3.5 ${n <= r.rating ? "text-amber-300" : "text-faint"}`} />
                    ))}
                  </div>
                  <span className="num text-[10.5px] text-faint">{timeAgo(r.createdAt)} · tx {r.txHash?.slice(0, 8)}…</span>
                </div>
                {r.body && <p className="mt-2.5 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{r.body}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="num text-[11px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className={`mt-1.5 text-xl font-medium tracking-tight ${tone}`}>{value}</div>
    </div>
  );
}

function EditProfile({ onDone, user }: { onDone: () => void; user: import("@/lib/types").PublicUser }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [skills, setSkills] = useState(user.skills.join(", "));
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();
  const registerArbiter = useRegisterArbiter();

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Display name</label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-10 border-line bg-white/[0.03] text-sm" />
        </div>
        <div className="space-y-2">
          <label className="text-[13px] font-medium">Skills (comma-separated)</label>
          <Input value={skills} onChange={(e) => setSkills(e.target.value)} className="h-10 border-line bg-white/[0.03] text-sm" />
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-[13px] font-medium">Bio</label>
        <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} className="resize-none border-line bg-white/[0.03] text-sm" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await patch("/users/me", {
                displayName: displayName.trim() || undefined,
                bio: bio.trim() || undefined,
                skills: skills.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20),
              });
              invalidate.user(user.walletAddress);
              onDone();
              toast.success("Profile updated");
            } catch (err) {
              toast.error("Update failed", { description: err instanceof Error ? err.message : "Unknown error" });
            } finally {
              setSaving(false);
            }
          }}
          className="rounded-full bg-rose-accent px-6 hover:bg-rose-bright"
        >
          <Check className="mr-2 h-4 w-4" /> Save
        </Button>
        <Button variant="ghost" onClick={onDone} className="rounded-full border border-line px-5 text-dim">
          <X className="mr-2 h-4 w-4" /> Cancel
        </Button>
        <button type="button" onClick={registerArbiter} className="num ml-auto text-[11.5px] text-faint underline-offset-4 hover:text-state-split hover:underline">
          admin: register this address as arbiter (on-chain)
        </button>
      </div>
    </div>
  );
}
