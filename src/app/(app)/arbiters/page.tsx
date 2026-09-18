"use client";

/** /arbiters — the trust registry: SBT badges, scores, SLA record. */
import { useArbiters, useOverview } from "@/lib/queries";
import { AddressAvatar, SectionLabel, Skeleton, EmptyState, press } from "@/components/design";
import { shortAddress, dateLabel } from "@/lib/format";
import Link from "next/link";
import { Scales } from "@phosphor-icons/react/dist/csr/Scales";
import { SealCheck } from "@phosphor-icons/react/dist/csr/SealCheck";

export default function ArbitersPage() {
  const { data: arbiters, isLoading } = useArbiters();
  const registered = (arbiters ?? []).filter((a) => a.registered);

  return (
    <div className="space-y-9">
      <div>
        <SectionLabel>trust registry</SectionLabel>
        <h1 className="mt-2.5 text-3xl font-semibold tracking-tighter md:text-4xl">Arbiters stake their name.</h1>
        <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-dim">
          Arbiters hold a soulbound badge (ERC-5194) whose trust score moves with their record: +1 per resolution
          inside the 72h SLA, −2 when the clock expires — and the slash is permissionless on-chain. Scores can't be
          bought, transferred, or reset.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44 rounded-3xl" />
          <Skeleton className="h-44 rounded-3xl" />
        </div>
      ) : !registered.length ? (
        <EmptyState
          icon={<Scales className="h-5 w-5" />}
          title="No registered arbiters yet"
          body="The registry mints badges on registration. The admin wallet registers arbiters with a single on-chain call."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {registered.map((a) => (
            <Link key={a.address} href={`/profile/${a.address}`} className="glass group rounded-3xl p-6 transition-all hover:border-line-strong">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <AddressAvatar address={a.address} size={46} />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[15.5px] font-medium">{a.profile?.displayName ?? shortAddress(a.address)}</span>
                      <SealCheck weight="fill" className="h-4 w-4 text-rose-bright" />
                    </div>
                    <div className="num mt-0.5 text-[11px] text-faint">registered {dateLabel(a.registeredAt)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`num text-3xl font-medium tracking-tight ${a.trustScore > 0 ? "text-state-released" : "text-dim"}`}>
                    {a.trustScore}
                  </div>
                  <div className="num text-[9.5px] uppercase tracking-[0.14em] text-faint">trust</div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4 text-center">
                <Stat label="resolutions" value={a.resolutions} />
                <Stat label="within SLA" value={a.resolutionsWithinSla} tone="text-state-released" />
                <Stat label="late" value={a.resolutionsLate} tone={a.resolutionsLate > 0 ? "text-state-disputed" : "text-dim"} />
              </div>

              <div className="num mt-4 flex items-center justify-between text-[10.5px] text-faint">
                <span>badge {a.sbtTokenId ? `#${BigInt(a.sbtTokenId)}` : "pending"} · soulbound</span>
                <span>transfer() reverts by design</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "text-foreground" }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`num text-lg font-medium ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-faint">{label}</div>
    </div>
  );
}
