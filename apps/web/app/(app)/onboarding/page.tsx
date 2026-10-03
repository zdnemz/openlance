"use client";

/**
 * Onboarding — connect → pick role → verify KYC → enter app.
 * Strict step machine: the role is only submitted via the step-2 confirm
 * button, and the identity form (step 3) never renders before that. Single
 * permanent role (locked once KYC starts); arbiter stakes LATER (on the
 * stake page), never upfront.
 * Step state derives from the server user + a local confirm flag, so a
 * reload resumes where the user left off.
 *
 * There is no "you're in" step to click through: the KYC response stamps
 * `el_onboarded`, and `enterApp` is a full document load so the edge proxy —
 * the one owner of the gate — decides where a finished user goes. A soft
 * `router.push` would stay on this page and re-derive the answer client-side,
 * which is what left users parked on a dead-end panel.
 */
import { useEffect, useRef, useState } from "react";
import { post } from "@/lib/api";
import { useSession, useSessionHydrated } from "@/lib/session";
import { useWallet, useWalletHydrated, readContract } from "@/lib/wallet";
import { ConnectPanel } from "@/components/wallet/connect-panel";
import { ROLES, roleFromOrdinal } from "@/lib/roles";
import { ROLE_HOME } from "@/lib/role-routes";
import { ROLE_REGISTRY_ABI } from "@/lib/contracts";
import { useRuntime } from "@/lib/runtime";
import { claimSeatAction, useChainAction } from "@/lib/chain-actions";
import { COUNTRIES } from "@/lib/countries";
import { press } from "@/components/design";
import type { PublicUser, UserRole } from "@/lib/types";
import {
  CheckCircle, Circle, Spinner, SealCheck, ShieldCheck, Check, CaretDown, ArrowLeft,
  IdentificationCard, IdentificationBadge, Fingerprint, Scan, Globe, User as UserIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

export default function OnboardingPage() {
  const session = useSession();
  const walletAddress = useWallet((s) => s.address);
  const sessionHydrated = useSessionHydrated();
  const walletHydrated = useWalletHydrated();
  const hydrated = sessionHydrated && walletHydrated;
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Deliberate submit, not inferred state: step 3 unlocks only after the
  // step-2 confirm button fires (server state alone can't say "chosen").
  const [roleConfirmed, setRoleConfirmed] = useState(false);

  if (!hydrated) return <div className="py-20 text-center text-sm text-faint">Loading…</div>;

  const user = session.user;
  const step =
    !walletAddress || !session.token ? 1
    : user?.kycStatus === "pending" ? 3
    : roleConfirmed ? 3
    : 2;

  /**
   * Hand the routing decision to the edge proxy.
   *
   * `location.assign` (not `router.push`) is load-bearing: the KYC response
   * only just set the gate cookie, and a soft navigation can be served from
   * the client router cache without ever re-running the proxy. A document load
   * always does — so the proxy sends a verified user to the seat home, and
   * bounces an unfinished one straight back here.
   */
  function enterApp() {
    window.location.assign(ROLE_HOME);
  }

  return (
    <div className="mx-auto max-w-2xl py-10">
      <h1 className="font-display text-3xl tracking-tight">Join OpenLance</h1>
      <p className="mt-2 text-sm text-dim">Testnet only — no real funds. Simulated KYC, real wallet signatures.</p>

      <ol className="mt-8 flex items-center gap-2 text-[12px]">
        {["Connect", "Role", "Verify", "Done"].map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            {step > i + 1 ? <CheckCircle weight="fill" className="h-4 w-4 text-state-released" /> : <Circle className="h-4 w-4 text-faint" />}
            <span className={step === i + 1 ? "text-foreground" : "text-faint"}>{label}</span>
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-3xl border border-line bg-white/[0.012] p-6">
        {step === 1 && (
          <div>
            <h2 className="text-lg font-medium">1 — Connect a real wallet</h2>
            <p className="mt-1 text-sm text-dim">MetaMask, Coinbase, or Rabby. One SIWE signature proves ownership.</p>
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="mt-4 rounded-full bg-rose-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-rose-bright"
            >
              {walletAddress ? "Sign in" : "Connect wallet"}
            </button>
            <ConnectPanel open={panelOpen} onOpenChange={setPanelOpen} />
          </div>
        )}

        {step === 2 && user && (
          <RoleStep user={user} busy={busy} setBusy={setBusy} onConfirm={() => setRoleConfirmed(true)} />
        )}

        {step === 3 && user && (
          <KycStep user={user} busy={busy} setBusy={setBusy} onDone={enterApp} onBack={() => setRoleConfirmed(false)} />
        )}
      </div>
    </div>
  );
}

/**
 * The seat the CHAIN holds for a wallet. `off` is a deployment with no
 * RoleRegistry (the DB column is the seat there and nothing is claimed);
 * `unreadable` is a registry we could not ask, which must not be mistaken for
 * "unclaimed" — the API refuses the write in that case, and so does this step.
 */
type SeatState =
  | { state: "off" }
  | { state: "unreadable" }
  | { state: "none" }
  | { state: "claimed"; role: UserRole }
  | { state: "loading" };

function useOnchainSeat(address: string | null): SeatState {
  const roleRegistry = useRuntime((s) => s.roleRegistry);
  const [seat, setSeat] = useState<SeatState>({ state: "loading" });
  useEffect(() => {
    if (!roleRegistry) {
      setSeat({ state: "off" });
      return;
    }
    if (!address) {
      setSeat({ state: "loading" });
      return;
    }
    let cancelled = false;
    setSeat({ state: "loading" });
    void (async () => {
      const raw = await readContract<number>({
        to: roleRegistry,
        abi: ROLE_REGISTRY_ABI,
        functionName: "roleOf",
        args: [address],
      });
      if (cancelled) return;
      const role = raw === null ? null : roleFromOrdinal(Number(raw));
      setSeat(role ? { state: "claimed", role } : raw === null ? { state: "unreadable" } : { state: "none" });
    })();
    return () => { cancelled = true; };
  }, [roleRegistry, address]);
  return seat;
}

function RoleStep({ user, busy, setBusy, onConfirm }: { user: PublicUser; busy: boolean; setBusy: (v: boolean) => void; onConfirm: () => void }) {
  const session = useSession();
  const chain = useChainAction();
  const seat = useOnchainSeat(useWallet((s) => s.address));
  // Selection is local-only until confirm: tapping a card never touches the API.
  const [selectedRole, setSelectedRole] = useState<UserRole>(user.role);
  // A claimed seat is the wallet's own — there is nothing left to choose, and
  // the API refuses any other answer, so the picker would only offer a lie.
  const claimed = seat.state === "claimed" ? seat.role : null;
  const seatRole = claimed ?? selectedRole;

  async function confirm() {
    setBusy(true);
    try {
      // Claim FIRST: the API only mirrors a seat the chain already holds, so a
      // claim that never lands must leave nothing to write. `off` means this
      // deployment has no wallet-owned seat, so there is nothing to claim; a
      // claimed seat is already on-chain and is mirrored as-is.
      if (seat.state === "none") {
        const claim = await claimSeatAction(chain.run)(seatRole);
        if (!claim.ok) return;
      }
      const updated = await post<PublicUser>("/users/me/role", { role: seatRole });
      session.setUser(updated);
      toast.success(`Role → ${seatRole}`);
      onConfirm();
    } catch (err) {
      toast.error("Role save failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }
  const selected = ROLES.find((r) => r.id === seatRole);
  return (
    <div>
      <h2 className="text-lg font-medium">{claimed ? "2 — Your seat" : "2 — Pick your seat (permanent)"}</h2>
      <p className="mt-1 text-sm text-dim">
        {claimed
          ? "This wallet already claimed a seat on-chain — it outlives our database, so the choice is already made."
          : "One active role. Seats are strictly separated — the proxy guards every page to its seat. Confirm to continue to identity."}
      </p>

      {claimed ? (
        <div className="mt-4 rounded-2xl border border-rose-accent/50 bg-rose-soft px-4 py-3.5">
          <div className="text-sm font-medium">{selected?.title} · claimed on-chain</div>
          <div className="text-xs text-dim">{selected?.blurb}</div>
          <div className="mt-0.5 text-[11px] text-faint">{selected?.kyc}</div>
        </div>
      ) : (
        <div className="mt-4 grid gap-2" role="radiogroup" aria-label="Role">
          {ROLES.map((r) => {
            const active = selectedRole === r.id;
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => setSelectedRole(r.id)}
                className={`rounded-2xl border px-4 py-3.5 text-left transition-colors ${press} ${
                  active
                    ? "border-rose-accent/50 bg-rose-soft"
                    : "border-transparent hover:border-line hover:bg-white/[0.04]"
                } disabled:opacity-60`}
              >
                <div className="text-sm font-medium">{r.title} {user.role === r.id && "· current"}</div>
                <div className="text-xs text-dim">{r.blurb}</div>
                <div className="mt-0.5 text-[11px] text-faint">{r.kyc}</div>
              </button>
            );
          })}
        </div>
      )}

      {seat.state === "unreadable" && (
        <p role="status" className="mt-3 text-[12.5px] text-amber-300">
          Couldn&apos;t read your on-chain seat. Confirm is disabled until the registry answers — a seat we cannot verify is not one we will hand out.
        </p>
      )}

      <button
        type="button"
        disabled={busy || seat.state === "loading" || seat.state === "unreadable"}
        onClick={() => void confirm()}
        className={`mt-4 inline-flex items-center gap-2 rounded-full bg-rose-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-bright disabled:opacity-60 ${press}`}
      >
        {busy ? <Spinner className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Saving…" : seat.state === "loading" ? "Checking your seat…" : `Continue with ${selected?.title ?? seatRole}`}
      </button>
    </div>
  );
}

/* ── KYC ────────────────────────────────────────────────────────────────────
 * Simulated identity check, depth matched to the active role. Same API as
 * before — only the surface is redesigned: an up-front checklist of what
 * each level inspects, labeled fields with inline validity, a segmented ID
 * picker, a mock liveness scan for arbiters, and a pending timeline.
 */

const KYC_LEVELS: Record<UserRole, { name: string; eta: string; checks: string[] }> = {
  client: { name: "Light", eta: "verified instantly", checks: ["Full name", "Country of residence"] },
  freelancer: { name: "Standard", eta: "short simulated review", checks: ["Full name", "Country of residence", "Government-issued ID"] },
  arbiter: { name: "Enhanced", eta: "enhanced simulated review", checks: ["Full name", "Country of residence", "Government-issued ID", "Liveness check"] },
};

const ID_TYPES = [
  { id: "passport", label: "Passport", Icon: IdentificationCard },
  { id: "drivers_license", label: "Driver's license", Icon: IdentificationBadge },
  { id: "national_id", label: "National ID", Icon: Fingerprint },
] as const;

type LivePhase = "idle" | "scanning" | "done";

const maskId = (s: string) => (s.length <= 4 ? "••••" : `•••• ${s.slice(-4)}`);

function KycStep({ user, busy, setBusy, onDone, onBack }: { user: PublicUser; busy: boolean; setBusy: (v: boolean) => void; onDone?: () => void; onBack?: () => void }) {
  const session = useSession();
  const level = KYC_LEVELS[user.role];
  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState<string>("passport");
  const [idNumber, setIdNumber] = useState("");
  const [livePhase, setLivePhase] = useState<LivePhase>("idle");
  const [submitted, setSubmitted] = useState<{ fullName: string; country: string; idType?: string; idNumber?: string } | null>(null);
  const scanTimer = useRef<number | null>(null);
  useEffect(() => () => { if (scanTimer.current) window.clearTimeout(scanTimer.current); }, []);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await post<{ user: PublicUser; autoVerified: boolean }>("/users/me/kyc", {
        fullName: fullName.trim(), country: country.trim(),
        ...(user.role !== "client" ? { idType, idNumber: idNumber.trim() } : {}),
        ...(user.role === "arbiter" ? { livenessConfirmed: livePhase === "done" } : {}),
      });
      session.setUser(res.user);
      setSubmitted({ fullName: fullName.trim(), country: country.trim(), ...(user.role !== "client" ? { idType, idNumber: idNumber.trim() } : {}) });
      toast.success(res.autoVerified ? "KYC verified (simulated)" : "KYC submitted (simulated)");
      // Only leave once the server actually verified. A freelancer/arbiter
      // submission comes back `pending` (this role's cookie is stamped
      // el_onboarded=0), so navigating here would bounce straight back through
      // the proxy and throw away the review details we just rendered. They
      // leave via the reviewer-approval path instead.
      if (res.user.kycStatus === "verified") onDone?.();
    } catch (err) {
      toast.error("KYC failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      const updated = await post<PublicUser>("/users/me/kyc?action=approve", {});
      session.setUser(updated);
      toast.success("KYC approved (demo reviewer)");
      onDone?.();
    } catch (err) {
      toast.error("Approve failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  }

  function startLiveness() {
    if (livePhase !== "idle" || busy) return;
    setLivePhase("scanning");
    scanTimer.current = window.setTimeout(() => setLivePhase("done"), 1400);
  }

  if (user.kycStatus === "pending") {
    return (
      <div>
        <KycHeader level={level} role={user.role} />
        {/* status timeline */}
        <ol className="mt-5 flex items-center gap-1.5" aria-label="Verification progress">
          {["Submitted", "In review", "Verified"].map((label, i) => (
            <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-medium ${
                i < 2 ? "bg-state-released/15 text-state-released ring-1 ring-state-released/30" : "bg-white/[0.04] text-faint ring-1 ring-line"
              }`}>
                {i < 2 ? "✓" : i + 1}
              </span>
              <span className={`text-[12px] ${i === 1 ? "text-foreground" : "text-faint"}`}>{label}</span>
              {i < 2 && <span className="mx-1 h-px flex-1 bg-line" aria-hidden />}
            </li>
          ))}
        </ol>
        {submitted && (
          <dl className="num mt-4 space-y-1.5 rounded-2xl border border-line bg-white/[0.02] px-4 py-3 text-[12.5px]">
            <div className="flex justify-between gap-4"><dt className="text-faint">Name</dt><dd className="text-dim">{submitted.fullName}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-faint">Country</dt><dd className="text-dim">{submitted.country}</dd></div>
            {submitted.idType && <div className="flex justify-between gap-4"><dt className="text-faint">Document</dt><dd className="text-dim">{ID_TYPES.find((t) => t.id === submitted.idType)?.label} {submitted.idNumber && maskId(submitted.idNumber)}</dd></div>}
          </dl>
        )}
        <p className="mt-4 text-[12.5px] leading-relaxed text-dim">
          A demo reviewer approves {user.role} KYC — nothing leaves your browser in this mock.
        </p>
        <button
          type="button" disabled={busy} onClick={() => void approve()}
          className={`mt-3 inline-flex items-center gap-2 rounded-full bg-rose-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-rose-bright disabled:opacity-60 ${press}`}
        >
          {busy ? <Spinner className="h-4 w-4 animate-spin" /> : <SealCheck weight="bold" className="h-4 w-4" />}
          Simulate reviewer approval
        </button>
      </div>
    );
  }
  // The proxy one-way-redirects /onboarding for an onboarded visitor, so this
  // branch is normally unreachable — but when a stale gate cookie let it render,
  // it produced an empty bordered card with no message at all.
  if (user.kycStatus === "verified") {
    return (
      <div className="glass rounded-3xl px-6 py-10 text-center">
        <p className="text-[15px] font-medium">You are verified.</p>
        <p className="mx-auto mt-2 max-w-[52ch] text-sm leading-relaxed text-faint">
          Your seat is locked and identity is on file. Use the app to work — or disconnect from the header wallet menu
          to start again with a different wallet.
        </p>
      </div>
    );
  }

  const nameOk = fullName.trim().length >= 2;
  const countryOk = country.trim().length >= 2;
  const idOk = user.role === "client" || idNumber.trim().length >= 4;
  const liveOk = user.role !== "arbiter" || livePhase === "done";
  const parts = [nameOk, countryOk, ...(user.role === "client" ? [] : [idOk]), ...(user.role === "arbiter" ? [liveOk] : [])];
  const complete = parts.filter(Boolean).length;
  const canSubmit = complete === parts.length && !busy;

  return (
    <div>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-faint transition-colors hover:text-dim"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Previous
        </button>
      )}
      <KycHeader level={level} role={user.role} />

      {/* what this level inspects */}
      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={`Checks for ${level.name} verification`}>
        {level.checks.map((c) => (
          <li key={c} className="num inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-dim">
            <CheckCircle weight="fill" className="h-3 w-3 text-state-released" />{c}
          </li>
        ))}
      </ul>

      <div className="mt-5 grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-dim"><UserIcon className="h-3.5 w-3.5 text-faint" />Full name</span>
            <input
              value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Ada Okafor" autoComplete="name"
              className="h-11 w-full rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors placeholder:text-faint/60 focus:border-rose-accent/50"
            />
            {fullName && !nameOk && <span className="mt-1 block text-[11.5px] text-amber-300">Use at least 2 characters.</span>}
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-dim"><Globe className="h-3.5 w-3.5 text-faint" />Country of residence</span>
            <CountryPicker value={country} onChange={setCountry} disabled={busy} />
          </label>
        </div>

        {user.role !== "client" && (
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-dim">Identity document</legend>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Document type">
              {ID_TYPES.map(({ id, label, Icon }) => {
                const active = idType === id;
                return (
                  <button
                    key={id} type="button" role="radio" aria-checked={active} disabled={busy}
                    onClick={() => setIdType(id)}
                    className={`flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3.5 text-center transition-colors ${press} ${
                      active ? "border-rose-accent/50 bg-rose-soft" : "border-line bg-white/[0.02] hover:border-line-strong"
                    } disabled:opacity-60`}
                  >
                    <Icon weight={active ? "fill" : "regular"} className={`h-5 w-5 ${active ? "text-rose-bright" : "text-faint"}`} />
                    <span className={`text-[11.5px] leading-tight ${active ? "text-foreground" : "text-dim"}`}>{label}</span>
                  </button>
                );
              })}
            </div>
            <input
              value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="e.g. A1234567" inputMode="text" autoComplete="off"
              className="mt-2 h-11 w-full rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors placeholder:text-faint/60 focus:border-rose-accent/50"
            />
            {idNumber && !idOk && <span className="mt-1 block text-[11.5px] text-amber-300">Document number needs 4+ characters.</span>}
          </fieldset>
        )}

        {user.role === "arbiter" && (
          <div className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 ${
            livePhase === "done" ? "border-state-released/30 bg-state-released/[0.05]" : "border-line bg-white/[0.02]"
          }`}>
            <span className="flex items-center gap-2.5 text-[13px]">
              <Scan className={`h-5 w-5 ${livePhase === "done" ? "text-state-released" : "text-faint"}`} />
              <span>
                <span className="block font-medium">{livePhase === "done" ? "Liveness confirmed" : livePhase === "scanning" ? "Scanning…" : "Liveness check"}</span>
                <span className="block text-[11.5px] text-faint">{livePhase === "idle" ? "Mock camera scan, ~2 seconds" : livePhase === "scanning" ? "Hold still (simulated)" : "Required for the arbiter seat"}</span>
              </span>
            </span>
            {livePhase === "idle" ? (
              <button type="button" disabled={busy} onClick={startLiveness} className={`shrink-0 rounded-full border border-line px-4 py-2 text-[12.5px] text-dim hover:text-foreground ${press}`}>
                Start scan
              </button>
            ) : livePhase === "scanning" ? (
              <Spinner className="h-5 w-5 animate-spin text-dim" />
            ) : (
              <CheckCircle weight="fill" className="h-5 w-5 shrink-0 text-state-released" />
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          {/* role="status": a screen reader needs to hear the count change as
              fields are filled. A `title` on a DISABLED button is never
              focusable and never announced, so the reason went unstated. */}
          <span role="status" className="num text-[11.5px] text-faint">
            {complete} of {parts.length} details ready
            {!canSubmit && !busy && " — fill the rest to continue"}
          </span>
          <button
            type="button" disabled={!canSubmit} onClick={() => void submit()}
            title={canSubmit ? undefined : "Fill every detail above to continue"}
            className={`inline-flex items-center gap-2 rounded-full bg-rose-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-bright disabled:opacity-50 ${press}`}
          >
            {busy ? <Spinner className="h-4 w-4 animate-spin" /> : <ShieldCheck weight="bold" className="h-4 w-4" />}
            {busy ? "Submitting…" : user.role === "client" ? "Verify instantly" : "Submit for review"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Searchable country dropdown — a native select over ~190 options is
 * thumb-through purgatory, so this filters as you type. Closes on
 * outside-click / Escape; listbox semantics for assistive tech. */
function CountryPicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Selecting an option (or Escape) unmounted the focused control and left
  // focus on <body>, so the next Tab restarted from the top of a long KYC form.
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open ]);
  const q = query.trim().toLowerCase();
  const matches = q ? COUNTRIES.filter((c) => c.toLowerCase().includes(q)) : COUNTRIES;
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setQuery(""); setOpen((o) => !o); }}
        className="flex h-11 w-full items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 text-sm outline-none transition-colors focus:border-rose-accent/50 disabled:opacity-60"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-faint" />
        <span className={`flex-1 truncate text-left ${value ? "" : "text-faint/60"}`}>{value || "Select country"}</span>
        <CaretDown className={`h-3.5 w-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-2xl border border-line bg-ink shadow-xl">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search countries…" autoFocus
            aria-label="Search countries"
            className="w-full border-b border-line bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-faint/60"
          />
          {/* `role="option"` sat on the inner <button> while the <li> carried no
              role, so the listbox reported ZERO options and this step was
              unusable without a mouse. The role belongs on the <li>. */}
          <ul id="country-listbox" role="listbox" aria-label="Country" className="max-h-56 overflow-y-auto p-1.5">
            {matches.length === 0 && <li className="px-3 py-2.5 text-[12.5px] text-faint">No matches — try another spelling.</li>}
            {matches.map((c) => (
              <li
                key={c}
                role="option"
                aria-selected={c === value}
                onClick={() => { onChange(c); close(); }}
                className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
                  c === value ? "bg-rose-soft text-foreground" : "text-dim hover:bg-white/[0.04] hover:text-foreground"
                }`}
              >
                {c}
                {c === value && <Check weight="bold" className="h-3.5 w-3.5 shrink-0 text-rose-bright" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KycHeader({ level, role }: { level: { name: string; eta: string }; role: UserRole }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-[15px] font-medium">
        <ShieldCheck weight="fill" className="h-4.5 w-4.5 text-rose-bright" />
        Verify identity
      </h3>
      <span className="flex items-center gap-1.5">
        <span className="num rounded-full border border-line bg-white/[0.03] px-2.5 py-0.5 text-[11px] text-dim">{role} · {level.name}</span>
        <span className="num rounded-full bg-amber-400/10 px-2.5 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-400/20">SIMULATED</span>
      </span>
      <p className="mt-0.5 w-full text-[12px] text-faint">{level.eta} — no documents leave your browser in this mock.</p>
    </div>
  );
}
