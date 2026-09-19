"use client";

/**
 * Landing — cinematic scrolltelling (MOTION budget spent here), asymmetric
 * split hero, sticky-stack how-it-works, trust section, ledger strip.
 * The app interior stays calm; this page is allowed to move — but only
 * in response to the reader's scroll, never on its own clock.
 */
import Link from "next/link";
import { motion, useScroll, useTransform, MotionConfig, type Variants } from "framer-motion";
import { useRef, memo, useEffect, useState } from "react";
import { Logo } from "@/components/app-shell";
import { WalletButton } from "@/components/wallet/wallet-button";
import { StatusDot, AddressAvatar } from "@/components/design";
import { MagneticLink, SpotCard } from "@/components/motion";
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { LockKeyOpen } from "@phosphor-icons/react/dist/csr/LockKeyOpen";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { HandCoins } from "@phosphor-icons/react/dist/csr/HandCoins";
import { Gavel } from "@phosphor-icons/react/dist/csr/Gavel";
import { FilePlus } from "@phosphor-icons/react/dist/csr/FilePlus";

/* ── motion vocabulary ──────────────────────────────────────────────────── */

const spring = { type: "spring", stiffness: 100, damping: 20 } as const;

const rise: Variants = {
  hidden: { opacity: 0, y: 26 },
  show: (i: number = 0) => ({ opacity: 1, y: 0, transition: { ...spring, delay: i * 0.08 } }),
};

/* ── hero visual: the living escrow card ───────────────────────────────── */

const FLOW = [
  { state: "Funded", color: "#fbbf24", line: "Mara locks 0.24 ETH", sub: "escrow contract holds it; nobody can move it" },
  { state: "Submitted", color: "#60a5fa", line: "Dario submits on-chain", sub: "delivery proof lands with the milestone" },
  { state: "Released", color: "#34d399", line: "0.234 ETH paid out", sub: "approved, instant release, 2.5% fee accounted" },
] as const;

const EscrowCard = memo(function EscrowCard() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % FLOW.length), 2600);
    return () => clearInterval(t);
  }, []);
  const current = FLOW[step]!;

  return (
    <SpotCard className="glass-raised relative w-full max-w-md rounded-[26px] p-6">
      <div className="flex items-center justify-between">
        <span className="num text-[12px] uppercase tracking-[0.16em] text-faint">milestone 1 · threat model</span>
        <motion.span
          key={current.state}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={spring}
          className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12px] font-medium"
          style={{ color: current.color, borderColor: `color-mix(in oklab, ${current.color} 34%, transparent)`, background: `color-mix(in oklab, ${current.color} 9%, transparent)` }}
        >
          <StatusDot color={current.color} pulse />
          {current.state}
        </motion.span>
      </div>

      <div className="mt-5 flex items-baseline justify-between">
        <div>
          <div className="text-sm text-dim">value under escrow</div>
          <div className="num mt-1 text-4xl font-medium tracking-tight">
            {step === 2 ? "0.234" : "0.240"}
            <span className="ml-1.5 text-base text-faint">ETH</span>
          </div>
        </div>
        <div className="num text-right text-[12px] leading-relaxed text-faint">
          fee 2.5% · on release
          <br />
          Base-native settlement
        </div>
      </div>

      {/* ledger rows — hairlines, no nested boxes */}
      <div className="mt-6 divide-y divide-white/[0.06] border-y border-line">
        {FLOW.map((f, i) => (
          <motion.div
            key={f.state}
            className="flex items-center gap-3 py-3"
            animate={{ opacity: i <= step ? 1 : 0.42 }}
            transition={spring}
          >
            <span
              className="h-4 w-[3px] shrink-0 rounded-full"
              style={{ background: i === step ? f.color : "rgba(255,255,255,0.14)" }}
            />
            {i < step ? (
              <CheckCircle weight="fill" className="h-4 w-4 shrink-0" style={{ color: f.color }} />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: i === step ? f.color : "rgba(255,255,255,0.2)" }} />
            )}
            <span className="min-w-0">
              <span className={`block text-[13px] ${i === step ? "text-foreground" : "text-dim"}`}>{f.line}</span>
              <span className="block truncate text-[12px] text-faint">{f.sub}</span>
            </span>
          </motion.div>
        ))}
      </div>

      <div className="num mt-4 flex items-center justify-between text-[12px] text-faint">
        <span>tx 0x7f3a…c21e · 12 conf</span>
        <span>escrowlance · anvil</span>
      </div>
    </SpotCard>
  );
});

/* ── page ──────────────────────────────────────────────────────────────── */

export default function LandingPage() {
  const heroRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const cardY = useTransform(scrollYProgress, [0, 1], [0, 120]);
  const cardOpacity = useTransform(scrollYProgress, [0, 0.85], [1, 0]);
  const gridY = useTransform(scrollYProgress, [0, 1], [0, 60]);
  /* ledger strip drifts with the reader's scroll, never on its own clock */
  const { scrollYProgress: stripProgress } = useScroll({ target: stripRef, offset: ["start end", "end start"] });
  const stripX = useTransform(stripProgress, [0, 1], ["4%", "-24%"]);

  return (
    <MotionConfig reducedMotion="user">
    <div className="relative min-h-[100dvh] w-full">
      {/* nav */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-line/60 bg-ink/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-5 md:px-8">
          <Link href="/" aria-label="EscrowLance home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-8 text-[13.5px] text-dim md:flex">
            <a href="#how" className="transition-colors hover:text-foreground">How escrow works</a>
            <a href="#trust" className="transition-colors hover:text-foreground">Arbiters</a>
            <Link href="/arbiters" className="transition-colors hover:text-foreground">Trust registry</Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href="/jobs"
              className="hidden items-center gap-1.5 text-[13.5px] text-dim transition-colors hover:text-foreground sm:flex"
            >
              Explore jobs <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <WalletButton />
          </div>
        </div>
      </header>

      {/* ── hero: asymmetric split over drafting-grid paper ────────── */}
      <section ref={heroRef} className="relative mx-auto min-h-[100dvh] max-w-[1400px] px-5 pb-24 pt-32 md:px-8 md:pt-36">
        {/* structural backdrop: 1px ledger grid, drifts on scroll — no glow blobs */}
        <motion.div
          style={{ y: gridY }}
          aria-hidden
          className="hairline-grid pointer-events-none absolute inset-x-0 -top-24 h-[720px]"
        />
        <div className="grid items-center gap-14 lg:grid-cols-[1.08fr_0.92fr]">
          <div className="max-w-2xl">
            <motion.div variants={rise} initial="hidden" animate="show" custom={0} className="flex items-center gap-2.5">
              <span className="flex items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1.5 text-[12px] text-dim">
                <StatusDot color="#34d399" pulse /> anvil devnet · Base-native by design
              </span>
            </motion.div>

            <motion.h1
              variants={rise}
              initial="hidden"
              animate="show"
              custom={1}
              className="display mt-8 text-[42px] leading-[1.02] text-balance md:text-[58px]"
            >
              Freelance work,
              <br />
              paid the way code pays:
              <br />
              <span className="italic text-dim">by proof.</span>
            </motion.h1>

            <motion.p variants={rise} initial="hidden" animate="show" custom={2} className="mt-7 max-w-[60ch] text-[15.5px] leading-relaxed text-dim">
              Every milestone locks its value in a smart-contract escrow before the work starts. The freelancer
              submits on-chain. The client approves. The contract pays: no invoicing, no chasing, no
              &ldquo;the check is in the mail.&rdquo; Disagreements go to staked arbiters, not silence.
            </motion.p>

            <motion.div variants={rise} initial="hidden" animate="show" custom={3} className="mt-9 flex flex-wrap items-center gap-3.5">
              <MagneticLink
                href="/jobs"
                className="group inline-flex items-center gap-2 rounded-full bg-rose-accent px-6 py-3.5 text-sm font-medium text-white transition-colors hover:bg-rose-bright active:translate-y-px active:scale-[0.985]"
              >
                Explore the marketplace
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" weight="bold" />
              </MagneticLink>
              <Link
                href="/jobs/new"
                className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-6 py-3.5 text-sm font-medium text-foreground transition-all hover:bg-white/[0.06] active:translate-y-px active:scale-[0.985]"
              >
                <FilePlus className="h-4 w-4" /> Post a job
              </Link>
            </motion.div>

            {/* asymmetric stat rail — hairlines, no boxes; the fee leads */}
            <motion.dl
              variants={rise}
              initial="hidden"
              animate="show"
              custom={4}
              className="mt-14 grid max-w-xl grid-cols-[1.35fr_1fr_1fr] divide-x divide-white/[0.07] border-t border-line pt-6"
            >
              {[
                ["2.5%", "fee on released value, nothing else", true],
                ["72h", "arbiter SLA, enforced by slashing", false],
                ["48h", "window to agree on an arbiter", false],
              ].map(([num, label, lead]) => (
                <div key={label as string} className={lead ? "pr-5" : "px-5"}>
                  <dt className={`num text-[26px] font-medium tracking-tight ${lead ? "text-rose-bright" : ""}`}>{num}</dt>
                  <dd className="mt-1.5 text-[12px] leading-snug text-faint">{label}</dd>
                </div>
              ))}
            </motion.dl>
          </div>

          <motion.div style={{ y: cardY, opacity: cardOpacity }} className="flex justify-center lg:justify-end">
            <div className="relative">
              <motion.div initial={{ opacity: 0, y: 40, rotate: 2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ ...spring, delay: 0.25 }}>
                <EscrowCard />
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.1 }}
                className="glass absolute -bottom-7 -left-7 hidden items-center gap-2.5 rounded-2xl px-4 py-3 md:flex"
              >
                <LockKeyOpen className="h-4 w-4 text-state-funded" weight="bold" />
                <span className="text-xs text-dim">nonReentrant · CEI · balance ≥ Σ unsettled</span>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── ledger strip: recent on-chain activity, drifts on scroll ─── */}
      <section ref={stripRef} aria-label="on-chain activity" className="hairline-t border-b border-line py-5">
        <div className="relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
          <motion.div style={{ x: stripX }} className="flex shrink-0 items-center gap-10 pr-10">
            {ledgerItems.map((item) => (
              <span key={item.label} className="flex shrink-0 items-center gap-3 text-[12.5px] text-faint">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                <span className="num">{item.label}</span>
                <span className="text-dim">{item.text}</span>
              </span>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── how it works: sticky scroll stack ──────────────────────────── */}
      <section id="how" className="mx-auto max-w-[1400px] px-5 py-28 md:px-8">
        <div className="grid gap-16 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <SectionHead
              title="Five moves. All of them on-chain."
              body="The marketplace lives off-chain where content belongs. Money never does; every state change below is a contract call you can verify, not a database row you have to trust."
            />
            <Link href="/jobs" className="group mt-8 inline-flex items-center gap-2 text-sm text-rose-bright">
              Watch it live on real jobs <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" weight="bold" />
            </Link>
          </div>
          <div className="space-y-5">
            {steps.map((step, i) => (
              <div key={step.title} className="lg:sticky" style={{ top: `${112 + i * 18}px` }}>
                <SpotCard className="glass-raised relative flex gap-6 overflow-hidden rounded-[26px] p-7 md:p-8">
                  {/* ghost index — oversized, hollow, structural */}
                  <span aria-hidden className="ghost-num num pointer-events-none absolute -right-3 -top-7 select-none text-[110px] font-semibold leading-none tracking-tighter">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="num mt-1 text-[13px] text-rose-bright">{String(i + 1).padStart(2, "0")}</span>
                  <div className="relative min-w-0">
                    <div className="flex items-center gap-3">
                      <step.icon weight="bold" className="h-5 w-5 text-rose-bright" />
                      <h3 className="text-[19px] font-medium tracking-tight">{step.title}</h3>
                    </div>
                    <p className="mt-2.5 max-w-[62ch] text-sm leading-relaxed text-dim">{step.body}</p>
                    <div className="num mt-4 text-[12px] text-faint">
                      <span className="text-rose-bright">→ </span>
                      {step.chip}
                    </div>
                  </div>
                </SpotCard>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── trust: arbiters ───────────────────────────────────────────── */}
      <section id="trust" className="relative border-t border-line py-28">
        <div className="mx-auto grid max-w-[1400px] items-center gap-16 px-5 md:px-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="order-2 lg:order-1">
            <SectionHead
              title="Disputes end in hours, with people who stake their name."
              body="Both parties nominate an arbiter; a match starts the 72-hour SLA clock. Resolutions inside the SLA raise the arbiter's on-chain trust score, overdue ones slash it. The badge is soulbound (ERC-5194), so the score can't be bought, sold, or reset."
            />
            {/* hairline stat ledger — rows, not boxes; numeral left, meaning right */}
            <dl className="mt-10 max-w-md">
              {[
                ["+1", "trust per resolution inside the 72h SLA", true],
                ["−2", "slashed when the clock runs out; anyone can call it", false],
                ["SBT", "soulbound badge (ERC-5194), non-transferable by design", false],
              ].map(([n, l, lead]) => (
                <div key={l as string} className="flex items-baseline justify-between gap-6 border-t border-line py-4 last:border-b">
                  <dt className={`num shrink-0 text-[26px] font-medium tracking-tight ${lead ? "text-rose-bright" : ""}`}>{n}</dt>
                  <dd className="text-right text-[12.5px] leading-snug text-dim">{l}</dd>
                </div>
              ))}
            </dl>
          </div>
          <ArbiterCardVisual className="order-1 lg:order-2" />
        </div>
      </section>

      {/* ── closing CTA ───────────────────────────────────────────────── */}
      <section className="border-t border-line py-28">
        <div className="mx-auto max-w-[1400px] px-5 md:px-8">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_0.6fr] lg:items-end">
            <h2 className="display max-w-[20ch] text-[38px] leading-[1.04] text-balance md:text-[54px]">
              Stop invoicing.
              <br />
              <span className="italic text-dim">Start escrowing.</span>
            </h2>
            <div className="flex flex-col gap-3.5 lg:items-end">
              <MagneticLink
                href="/jobs/new"
                className="group inline-flex items-center justify-center gap-2 rounded-full bg-rose-accent px-7 py-4 text-sm font-medium text-white transition-colors hover:bg-rose-bright active:translate-y-px active:scale-[0.985]"
              >
                Post your first job
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" weight="bold" />
              </MagneticLink>
              <span className="text-xs text-faint">anvil devnet · no real funds, real contracts</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── footer ────────────────────────────────────────────────────── */}
      <footer className="border-t border-line py-10">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-5 md:flex-row md:items-center md:justify-between md:px-8">
          <div className="flex items-center gap-4">
            <Logo size="sm" />
            <span className="text-xs text-faint">milestone escrow for freelance work</span>
          </div>
          <div className="num flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-faint">
            <Link href="/jobs" className="hover:text-dim">jobs</Link>
            <Link href="/arbiters" className="hover:text-dim">arbiters</Link>
            <Link href="/console" className="hover:text-dim">backend console</Link>
            <span>Escrow.sol · ArbiterRegistry.sol · 97%+ branch coverage</span>
          </div>
        </div>
      </footer>
    </div>
    </MotionConfig>
  );
}

/* ── section head ─────────────────────────────────────────────────────── */

function SectionHead({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="display max-w-[26ch] text-[32px] leading-[1.06] text-balance md:text-[42px]">{title}</h2>
      <p className="mt-5 max-w-[62ch] text-[14.5px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}

/* ── arbiter card visual ──────────────────────────────────────────────── */

function ArbiterCardVisual({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={spring}
      className={className}
    >
      <div className="glass-raised rounded-3xl p-7">
        <div className="flex items-center justify-between">
          <span className="num text-[12px] uppercase tracking-[0.16em] text-faint">arbiter registry · erc-5194</span>
          <span className="flex items-center gap-2 rounded-full border border-state-disputed/30 bg-state-disputed/10 px-2.5 py-1 text-[12px] text-state-disputed">
            <StatusDot color="#fb923c" pulse /> 72h SLA live
          </span>
        </div>
        <div className="mt-6 flex items-center gap-4">
          <AddressAvatar address="0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" size={56} className="rounded-2xl" />
          <div>
            <div className="text-lg font-medium tracking-tight">Ingrid Salm</div>
            <div className="num text-[12px] text-faint">security researcher · 40+ peer reviews</div>
          </div>
          <div className="ml-auto text-right">
            <div className="num text-3xl font-medium tracking-tight text-state-released">12</div>
            <div className="text-[12px] uppercase tracking-wider text-faint">trust</div>
          </div>
        </div>
        <div className="mt-6 divide-y divide-white/[0.06] border-y border-line">
          {[
            ["resolved · split", "#a7f3d0", "1h 48m inside SLA", "+1"],
            ["resolved · release", "#34d399", "3h 02m inside SLA", "+1"],
            ["resolved · refund", "#d4d4d8", "61h 20m inside SLA", "+1"],
          ].map(([label, color, time, delta]) => (
            <div key={label} className="flex items-center justify-between py-3.5">
              <span className="flex items-center gap-2.5 text-[12.5px] text-dim">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                {label}
              </span>
              <span className="flex items-center gap-3">
                <span className="num text-[12px] text-faint">{time}</span>
                <span className="num text-[12px] text-state-released">{delta}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="num mt-5 text-[12px] text-faint">badge #7 · soulbound · transfer() reverts by design</div>
      </div>
    </motion.div>
  );
}

/* ── data ─────────────────────────────────────────────────────────────── */

const ledgerItems = [
  { label: "0xf39F…2266", text: "funded milestone 1 · 0.240 ETH", color: "#fbbf24" },
  { label: "0x7099…79C8", text: "submitted threat model for review", color: "#60a5fa" },
  { label: "escrow", text: "released 0.234 ETH to freelancer · fee 0.006", color: "#34d399" },
  { label: "0x9965…0a4D", text: "resolved dispute · split 50/50", color: "#a7f3d0" },
  { label: "registry", text: "arbiter trust +1 · inside SLA", color: "#f43f5e" },
  { label: "0x3C44…93BC", text: "accepted proposal · 3 milestones", color: "#a1a1aa" },
];

const steps = [
  {
    title: "Post the work, broken into milestones",
    body: "A job carries its own milestone template: titles, scope, amounts. The API validates the sum against the budget range server-side; the template becomes the contract's blueprint when the work is awarded.",
    icon: FilePlus,
    chip: "POST /jobs · milestone sum validated",
  },
  {
    title: "Award it — the bridge event",
    body: "Accepting a proposal creates the project and its milestones in one transaction, locks the job, and auto-rejects the losing bids. Half-awarded jobs are structurally impossible.",
    icon: HandCoins,
    chip: "project + milestones born atomically",
  },
  {
    title: "Fund the milestone — value locks",
    body: "The client's wallet calls fund() with the amount and a reference. From this second the money belongs to the contract: it can only move by approve, cancel, or arbitration. Both parties can see it, neither can touch it.",
    icon: LockKeyOpen,
    chip: "fund(bytes32 ref, address freelancer)",
  },
  {
    title: "Ship, then submit on-chain",
    body: "Delivery notes and files land off-chain; the state flip that matters is the freelancer's submit() transaction. The indexer mirrors it within seconds and the client's review window opens.",
    icon: CheckCircle,
    chip: "submit(uint256 milestoneId)",
  },
  {
    title: "Approve — or open the arbiter path",
    body: "approve() releases the escrowed value instantly, minus the 2.5% fee. Can't agree? Either side locks the milestone into dispute and both nominate an arbiter; the contract enforces the rest.",
    icon: Gavel,
    chip: "approve · openDispute · nominateArbiter",
  },
] as const;
