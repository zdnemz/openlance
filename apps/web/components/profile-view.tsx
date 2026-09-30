"use client";

/**
 * ProfileView — the single canonical profile card (identity, stats, reviews).
 * Rendered read-only at /profile/[address]; editable ONLY at /profile/me
 * (`allowEdit`), which is also proxy-gated to verified users — so unfinished
 * users have no edit path, page or API.
 *
 * The card is shaped by the OWNER's seat, not the viewer's. Role is locked for
 * good after onboarding (users.ts switchRole), so the two "wrong-side" derived
 * stats per seat are not "not yet" — they are permanently zero. Rendering them
 * anyway is what this component used to do for all three seats.
 *
 * Invariant: every field the card renders is editable, and every field the form
 * edits is rendered. `avatarUrl` is in the DB and the API contract but is
 * rendered and edited by neither — deliberately, see EditProfile.
 */
import { useState } from "react";
import Link from "next/link";
import { useUser, useUserReviews, useArbiters, useInvalidate, patch } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useRuntime } from "@/lib/runtime";
import { TIER_NAMES, PROFILE_FORM, arbiterStanding, roleLabel } from "@/lib/roles";
import type { ProfileField } from "@/lib/roles";
import {
  AddressAvatar, Chip, EthAmount, ListHead, Skeleton, EmptyState, Copyable, InlineLoading,
} from "@/components/design";
import { shortAddress, timeAgo, dateLabel } from "@/lib/format";
import { Star } from "@phosphor-icons/react/dist/csr/Star";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import type { ArbiterView, PublicUser } from "@/lib/types";

type Stat = { label: string; value: React.ReactNode; tone?: string };

/**
 * The stats a seat can actually move.
 *
 *  · client     — pays out, hires. `totalEarnedWei`/`completedAsFreelancer` are
 *                 unreachable for this seat, so they are not shown as 0.
 *  · freelancer — earns, ships. `totalPaidWei`/`completedAsClient` likewise.
 *  · arbiter    — neither. Their track record is registry standing, read live
 *                 from ArbiterRegistry (see ArbiterView). NOTE: an arbiter's
 *                 real income is ArbiterView.totalEarnedWei (lifetime fees from
 *                 the ledger) — user.stats.totalEarnedWei is marketplace money
 *                 and is permanently 0 for this seat. Do not swap them.
 */
function statsFor(user: PublicUser, arbiter: ArbiterView | undefined): Stat[] {
  if (user.role === "client") {
    return [
      { label: "paid via escrow", value: <EthAmount wei={user.stats.totalPaidWei} decimals={4} />, tone: "text-state-submitted" },
      { label: "projects completed", value: <span className="num">{user.stats.completedProjectsAsClient}</span> },
    ];
  }
  if (user.role === "freelancer") {
    return [
      { label: "earned", value: <EthAmount wei={user.stats.totalEarnedWei} decimals={4} />, tone: "text-state-released" },
      { label: "projects completed", value: <span className="num">{user.stats.completedProjectsAsFreelancer}</span> },
    ];
  }
  if (!arbiter) return [];
  return [
    { label: "trust score", value: <span className="num">{arbiter.trustScore}</span>, tone: arbiter.trustScore > 0 ? "text-state-released" : undefined },
    { label: "tier", value: <span>{TIER_NAMES[arbiter.tier] ?? "Unstaked"}</span> },
    { label: "stake", value: <EthAmount wei={arbiter.stakeWei} />, tone: "text-dim" },
    { label: "cases resolved", value: <span className="num">{arbiter.resolutions}</span> },
  ];
}

export function ProfileView({ address, allowEdit }: { address: string; allowEdit: boolean }) {
  const session = useSession();
  const minStakeWei = useRuntime((s) => s.minStakeWei);
  const { data: user, isLoading } = useUser(address);
  const { data: reviews } = useUserReviews(address);
  const { data: arbiters, isLoading: arbitersLoading } = useArbiters();
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

  const isArbiterSeat = user.role === "arbiter";
  // A review is always client ↔ freelancer (reviews.ts pins revieweeId to the
  // other side of the project). Arbiters are drawn in as voters, never as a
  // project side — so this seat can never receive one. Don't promise a section
  // that is empty for the same reason the old zero stats were.
  const showReviews = !isArbiterSeat;
  const stats = statsFor(user, arbiter);
  const avgRating = reviews?.length ? reviews.reduce((a, r) => a + r.rating, 0) / reviews.length : null;

  return (
    <div className="space-y-9">
      {/* identity card */}
      <div className="glass rounded-3xl p-7 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-center gap-5">
            <AddressAvatar address={address} size={72} />
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-semibold tracking-tight">{user.displayName ?? shortAddress(address)}</h1>
                <Chip>{roleLabel(user.role)}</Chip>
                {user.kycStatus === "verified" && <span className="num flex items-center gap-1 rounded-full bg-state-released/10 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-state-released"><SealCheck weight="fill" className="h-3 w-3" /> verified</span>}
                {arbitersLoading && <InlineLoading label="arbiter…" />}
                {!isArbiterSeat && arbiter?.registered && (
                  <span className="flex items-center gap-1.5 rounded-full bg-state-split/10 px-2.5 py-0.5 text-[11px] text-state-split">
                    <SealCheck weight="fill" className="h-3.5 w-3.5" /> arbiter · trust {arbiter.trustScore}
                  </span>
                )}
              </div>
              <Copyable text={address} className="mt-1.5 text-[13px]">
                <span className="num text-dim">{shortAddress(address, 6)}</span>
              </Copyable>
              <div className="num mt-2 flex items-center gap-3 text-[11px] text-faint">
                <span>joined {dateLabel(user.createdAt)}</span>
                {user.kycStatus !== "verified" && <span>kyc {user.kycStatus}</span>}
              </div>
            </div>
          </div>
          {allowEdit && isMe && !editing && (
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
        {isArbiterSeat ? (
          <ArbiterStanding
            arbiter={arbiter}
            loading={arbitersLoading}
            minStakeWei={minStakeWei}
            stats={stats}
          />
        ) : stats.length > 0 && (
          <div className={`mt-7 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-6 ${stats.length > 2 ? "sm:grid-cols-4" : "sm:grid-cols-2"}`}>
            {stats.map((s) => <Stat key={s.label} {...s} />)}
          </div>
        )}
      </div>

      {/* reviews */}
      {showReviews && (
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
                    <span className="num text-[11px] text-faint">
                      {timeAgo(r.createdAt)}{r.txHash && <> · tx {r.txHash.slice(0, 8)}…</>}
                    </span>
                  </div>
                  {r.body && <p className="mt-2.5 max-w-[62ch] text-[13.5px] leading-relaxed text-dim">{r.body}</p>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Arbiter seat — the standing IS the profile. The roster is built from
 * `rosterSnapshot()`, so an address that has never staked (or any RPC/mock-mode
 * failure) has no row at all. That is a "not yet", not a zero: say so, and
 * point at the one action that creates the row.
 */
function ArbiterStanding({ arbiter, loading, minStakeWei, stats }: { arbiter: ArbiterView | undefined; loading: boolean; minStakeWei: string; stats: Stat[] }) {
  if (loading) return <Skeleton className="mt-7 h-24 w-full rounded-2xl" />;
  if (!arbiter?.registered) {
    return (
      <div className="mt-7 border-t border-line pt-6">
        <EmptyState
          title="No registry standing yet"
          body="Arbiters earn trust by staking collateral and ruling on disputes. Until then there is nothing on-chain to show — and nothing to show as a zero."
          action={<Link href="/stake" className="text-sm text-rose-bright hover:underline">Stake to join the registry →</Link>}
        />
      </div>
    );
  }
  const st = arbiterStanding(arbiter, minStakeWei);
  return (
    <div className="mt-7 border-t border-line pt-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="text-[11px] uppercase tracking-[0.14em] text-faint">registry standing</span>
        <span className="rounded-full px-2.5 py-0.5 text-[11px]" style={{ color: st.color, background: `color-mix(in oklab, ${st.color} 9%, transparent)` }}>{st.label}</span>
        {arbiter.registeredAt && <span className="num text-[11px] text-faint">registered {dateLabel(arbiter.registeredAt)}</span>}
        <Link href="/arbiters" className="num ml-auto text-[11.5px] text-faint underline-offset-4 hover:text-state-split hover:underline">roster →</Link>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
        {stats.map((s) => <Stat key={s.label} {...s} />)}
      </div>
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

type LinkRow = { k: string; v: string };

/**
 * /users/me — the only editable profile form.
 *
 * Edits exactly the fields the card renders: name, links, skills, bio. All four
 * are present for every seat; PROFILE_FORM decides the wording and the lead
 * position. `avatarUrl` is deliberately absent from both sides — it is in the
 * DB and the API contract but nothing renders or sets it, so the card and the
 * form agree by both ignoring it.
 */
function EditProfile({ onDone, user }: { onDone: () => void; user: PublicUser }) {
  const copy = PROFILE_FORM[user.role];
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [skills, setSkills] = useState(user.skills.join(", "));
  const [links, setLinks] = useState<LinkRow[]>(
    Object.entries(user.links ?? {}).map(([k, v]) => ({ k, v })),
  );
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidate();

  const setLink = (i: number, patch: Partial<LinkRow>) =>
    setLinks((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  /** Blank rows are dropped; a half-filled row is an error, not a silent skip. */
  function collectLinks(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of links) {
      const k = r.k.trim();
      const v = r.v.trim();
      if (!k && !v) continue;
      if (!k) throw new Error(`"${v}" needs a label`);
      try {
        new URL(v);
      } catch {
        throw new Error(`"${v}" is not a valid URL`);
      }
      out[k] = v;
    }
    return out;
  }

  const field = (f: ProfileField) => {
    if (f === "name") {
      return (
        <div className="space-y-2">
          <label htmlFor="profile-name" className="text-[13px] font-medium">{copy.name}</label>
          <Input id="profile-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-10 border-line bg-white/[0.03] text-sm" />
        </div>
      );
    }
    if (f === "skills") {
      return (
        <div className="space-y-2">
          <label htmlFor="profile-skills" className="text-[13px] font-medium">{copy.skills} (comma-separated)</label>
          <Input id="profile-skills" value={skills} onChange={(e) => setSkills(e.target.value)} className="h-10 border-line bg-white/[0.03] text-sm" />
        </div>
      );
    }
    if (f === "bio") {
      return (
        <div className="space-y-2">
          <label htmlFor="profile-bio" className="text-[13px] font-medium">{copy.bio}</label>
          <Textarea id="profile-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} />
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium" id="profile-links-label">{copy.links}</span>
          <button
            type="button"
            onClick={() => setLinks((rows) => [...rows, { k: "", v: "" }])}
            className="num text-[11.5px] text-rose-bright hover:underline"
          >
            + add
          </button>
        </div>
        {links.length === 0 ? (
          <p className="num text-[11.5px] text-faint">None yet — the card renders these as labelled links.</p>
        ) : (
          <div className="space-y-2">
            {links.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.k}
                  onChange={(e) => setLink(i, { k: e.target.value })}
                  placeholder="label"
                  aria-label={`${copy.links} label ${i + 1}`}
                  className="h-10 w-32 shrink-0 border-line bg-white/[0.03] text-sm"
                />
                <Input
                  value={r.v}
                  onChange={(e) => setLink(i, { v: e.target.value })}
                  placeholder="https://…"
                  aria-label={`${copy.links} URL ${i + 1}`}
                  className="h-10 border-line bg-white/[0.03] text-sm"
                />
                <Button
                  variant="ghost"
                  onClick={() => setLinks((rows) => rows.filter((_, n) => n !== i))}
                  aria-label={`Remove ${r.k || `link ${i + 1}`}`}
                  className="h-10 w-10 shrink-0 rounded-full p-0 text-faint hover:text-state-disputed"
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /**
   * Seat order decides sequence; layout only pairs ADJACENT narrow fields
   * (name/skills — one input each) onto one row. `links` carries three inputs
   * and `bio` wants width, so both always take a full row.
   */
  const narrow = (f: ProfileField) => f === "name" || f === "skills";
  const rows: (ProfileField | ProfileField[])[] = [];
  for (const f of copy.order) {
    const last = rows[rows.length - 1];
    if (narrow(f) && Array.isArray(last) && last.length === 1) last.push(f);
    else rows.push(narrow(f) ? [f] : f);
  }

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-6">
      {rows.map((r, i) =>
        Array.isArray(r) ? (
          <div key={i} className="grid gap-4 sm:grid-cols-2">
            {r.map((f) => <div key={f}>{field(f)}</div>)}
          </div>
        ) : (
          <div key={i}>{field(r)}</div>
        ),
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              // Send the trimmed value even when empty — "" is what clears the
              // column. Omitting the key means "leave unchanged", which is why
              // an emptied field used to silently keep its old value.
              await patch("/users/me", {
                displayName: displayName.trim(),
                bio: bio.trim(),
                skills: skills.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20),
                links: collectLinks(),
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
        {/* `/arbiters` is arbiter-only in the seat matrix, so this sent every
            client and freelancer who opened Edit to a bounce off /dashboard. */}
        {user.role === "arbiter" && (
          <Link href="/arbiters" className="num ml-auto text-[11.5px] text-faint underline-offset-4 hover:text-state-split hover:underline">
            arbiter staking &amp; registry →
          </Link>
        )}
      </div>
    </div>
  );
}
