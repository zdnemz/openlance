"use client";

/**
 * Landing — the pixel arcade front door: asymmetric split hero, a stepped
 * escrow-state card, a ledger ticker, a sticky-stack of the five moves and the
 * arbiter registry. Motion budget is spent here and only here, and it is all
 * stepped (a few whole-pixel frames, never a spring): the entrance, the ticker
 * drift (snapped to 8px) and the escrow card's state advance. The app interior
 * stays calm.
 */
import Link from "next/link";
import { motion, useScroll, useTransform, useReducedMotion, MotionConfig, type Variants } from "framer-motion";
import { useRef, memo, useEffect, useState } from "react";
import { Logo } from "@/components/app-shell";
import { WalletButton } from "@/components/wallet/wallet-button";
import { StatusDot, AddressAvatar } from "@/components/design";
import { LiftCard, PixelLink, stepTransition } from "@/components/motion";
import { Sprite } from "@/components/pixel-art";
import type { SpriteName } from "@/components/pixel-sprites";
import { buttonVariants } from "@/components/ui/button";
import { ArrowRight, FilePlus } from "@/components/icons";
import { cn } from "@/lib/utils";

/* ── motion vocabulary ──────────────────────────────────────────────────── */

const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number = 0) => ({ opacity: 1, y: 0, transition: stepTransition(0.4, 4, i * 0.1) }),
};

/* ── hero visual: the living escrow card ───────────────────────────────── */

const FLOW = [
  { state: "Funded", color: "#fbbf24", sprite: "coin", line: "Mara locks 0.24 ETH", sub: "escrow contract holds it; nobody can move it" },
  { state: "Submitted", color: "#60a5fa", sprite: "scroll", line: "Dario submits on-chain", sub: "delivery proof lands with the milestone" },
  { state: "Released", color: "#34d399", sprite: "chest", line: "0.234 ETH paid out", sub: "approved, instant release, 2.5% fee accounted" },
] as const satisfies readonly { state: string; color: string; sprite: SpriteName; line: string; sub: string }[];

const EscrowCard = memo(function EscrowCard() {
  const [step, setStep] = useState(0);
  // Auto-advancing content needs a way to stop (WCAG 2.2.2): reduced motion
  // holds the card on its first state.
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setStep((s) => (s + 1) % FLOW.length), 2600);
    return () => clearInterval(t);
  }, [reduce]);
  const current = FLOW[step]!;

  return (
    <LiftCard className="glass-accent relative w-full max-w-md p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] font-semibold uppercase tracking-wide text-faint">milestone 1 · threat model</span>
        <span
          key={current.state}
          className="pixel-pop flex items-center gap-2 border-2 px-2 py-0.5 text-[13px] font-semibold uppercase leading-5"
          style={{ color: current.color, borderColor: current.color, background: `color-mix(in oklab, ${current.color} 12%, transparent)` }}
        >
          <StatusDot color={current.color} pulse />
          {current.state}
        </span>
      </div>

      <div className="mt-6">
        <div className="text-[15px] text-dim">value under escrow</div>
        <div className="mt-3 flex items-baseline gap-3">
          <span className="display text-[30px] leading-none text-state-funded">{step === 2 ? "0.234" : "0.240"}</span>
          <span className="display text-[12px] text-faint">ETH</span>
        </div>
        <div className="num mt-3 text-[13px] leading-relaxed text-faint">fee 2.5% · on release · Base-native settlement</div>
      </div>

      {/* progress: three blocks that fill in whole steps */}
      <div className="mt-5 grid grid-cols-3 gap-1.5" role="img" aria-label={`escrow step ${step + 1} of ${FLOW.length}: ${current.state}`}>
        {FLOW.map((f, i) => (
          <span key={f.state} className="h-3 border-2" style={{ borderColor: i <= step ? f.color : "var(--color-line-strong)", background: i <= step ? f.color : "transparent" }} />
        ))}
      </div>

      {/* ledger rows — dashed rules, no nested boxes */}
      <div className="mt-5 divide-y-2 divide-dashed divide-line border-y-2 border-dashed border-line">
        {FLOW.map((f, i) => (
          <div key={f.state} className={cn("flex items-center gap-3 py-3", i > step && "opacity-45")}>
            <Sprite name={f.sprite} size={32} className={i === step ? "" : "grayscale"} />
            <span className="min-w-0">
              <span className={cn("block text-[15px] leading-snug", i === step ? "text-foreground" : "text-dim")}>{f.line}</span>
              <span className="block truncate text-[13px] text-faint">{f.sub}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="num mt-4 flex items-center justify-between text-[13px] text-faint">
        <span>tx 0x7f3a…c21e · 12 conf</span>
        <span>openlance · anvil</span>
      </div>
    </LiftCard>
  );
});

/* ── page ──────────────────────────────────────────────────────────────── */

/** Quantise a scroll-linked value to whole 8px steps so motion reads as pixels, not a glide. */
const snap = (v: number) => Math.round(v / 8) * 8;

export default function LandingPage() {
  const heroRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const gridY = useTransform(scrollYProgress, [0, 1], [0, 64], { clamp: true });
  const gridYSnap = useTransform(gridY, snap);
  /* ledger strip drifts with the reader's scroll, never on its own clock */
  const { scrollYProgress: stripProgress } = useScroll({ target: stripRef, offset: ["start end", "end start"] });
  const stripX = useTransform(stripProgress, [0, 1], [32, -240]);
  const stripXSnap = useTransform(stripX, snap);

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-[100dvh] w-full">
        {/* nav */}
        <header className="fixed inset-x-0 top-0 z-50 border-b-2 border-line-strong bg-ink">
          <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-5 md:px-8">
            <Link href="/" aria-label="OpenLance home">
              <Logo />
            </Link>
            <nav className="hidden items-center gap-8 font-display text-[11px] uppercase text-dim md:flex" aria-label="Sections">
              <a href="#how" className="py-3 transition-colors hover:text-white">How it works</a>
              <a href="#trust" className="py-3 transition-colors hover:text-white">Arbiters</a>
              <Link href="/arbiters" className="py-3 transition-colors hover:text-white">Registry</Link>
            </nav>
            <div className="flex items-center gap-4">
              <Link
                href="/jobs"
                className="hidden min-h-11 items-center gap-2 font-display text-[11px] uppercase text-dim transition-colors hover:text-white sm:flex"
              >
                Explore jobs <ArrowRight className="h-5 w-5" />
              </Link>
              <WalletButton />
            </div>
          </div>
        </header>

        {/* ── hero: asymmetric split over a pixel-dot grid ────────── */}
        <section ref={heroRef} className="relative mx-auto min-h-[100dvh] max-w-[1400px] px-5 pb-24 pt-32 md:px-8 md:pt-40">
          {/* structural backdrop: a coarse dot grid, drifts in 8px steps — no glow blobs */}
          <motion.div
            style={{ y: gridYSnap }}
            aria-hidden
            className="hairline-grid pointer-events-none absolute inset-x-0 -top-24 h-[720px]"
          />
          <div className="grid items-center gap-16 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="max-w-2xl">
              <motion.div variants={rise} initial="hidden" animate="show" custom={0} className="flex items-center gap-2.5">
                <span className="flex items-center gap-2.5 border-2 border-line-strong bg-ink-raised px-3 py-1.5 text-[14px] text-dim">
                  <StatusDot color="#34d399" pulse /> anvil devnet · Base-native by design
                </span>
              </motion.div>

              <motion.h1
                variants={rise}
                initial="hidden"
                animate="show"
                custom={1}
                className="display mt-9 text-[22px] leading-[1.45] sm:text-[30px] md:text-[36px]"
              >
                Freelance work,
                <br />
                paid the way
                <br />
                code pays:
                <br />
                <span className="text-rose-light">by proof.</span>
                <span className="cursor-blink text-rose-light" aria-hidden>_</span>
              </motion.h1>

              <motion.p variants={rise} initial="hidden" animate="show" custom={2} className="mt-8 max-w-[60ch] text-[17px] leading-relaxed text-dim">
                Every milestone locks its value in a smart-contract escrow before the work starts. The freelancer
                submits on-chain. The client approves. The contract pays: no invoicing, no chasing, no
                &ldquo;the check is in the mail.&rdquo; Disagreements go to staked arbiters, not silence.
              </motion.p>

              <motion.div variants={rise} initial="hidden" animate="show" custom={3} className="mt-10 flex flex-wrap items-center gap-5">
                <PixelLink href="/jobs">
                  Explore the marketplace
                  <ArrowRight className="h-5 w-5" weight="bold" />
                </PixelLink>
                <Link href="/jobs/new" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                  <FilePlus className="h-5 w-5" /> Post a job
                </Link>
              </motion.div>

              {/* stat rail — dashed rules, no boxes; the fee leads */}
              <motion.dl
                variants={rise}
                initial="hidden"
                animate="show"
                custom={4}
                className="mt-16 grid max-w-xl grid-cols-[1.35fr_1fr_1fr] divide-x-2 divide-dashed divide-line border-t-2 border-dashed border-line pt-6"
              >
                {[
                  ["2.5%", "fee on released value, nothing else", true],
                  ["72h", "arbiter SLA, enforced by slashing", false],
                  ["48h", "window to agree on an arbiter", false],
                ].map(([num, label, lead]) => (
                  <div key={label as string} className={lead ? "pr-5" : "px-5"}>
                    <dt className={cn("display text-[20px] leading-none md:text-[24px]", lead ? "text-rose-light" : "text-foreground")}>{num}</dt>
                    <dd className="mt-3 text-[14px] leading-snug text-faint">{label}</dd>
                  </div>
                ))}
              </motion.dl>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={stepTransition(0.5, 5, 0.25)}
              className="flex justify-center lg:justify-end"
            >
              <div className="relative">
                <EscrowCard />
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={stepTransition(0.3, 3, 1.1)}
                  className="glass absolute -bottom-9 -left-8 hidden items-center gap-3 px-4 py-3 md:flex"
                >
                  <Sprite name="lock" size={32} />
                  <span className="text-[14px] text-dim">nonReentrant · CEI · balance ≥ Σ unsettled</span>
                </motion.div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* ── ledger strip: recent on-chain activity, drifts on scroll ─── */}
        <section ref={stripRef} aria-label="on-chain activity" className="border-y-2 border-line-strong bg-ink-raised py-5">
          <div className="relative flex overflow-hidden">
            <motion.div style={{ x: stripXSnap }} className="flex shrink-0 items-center gap-12 pr-12">
              {ledgerItems.map((item) => (
                <span key={item.label} className="flex shrink-0 items-center gap-3 text-[14px] text-faint">
                  <span className="h-2.5 w-2.5" style={{ background: item.color }} />
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
                title="Five moves. All on-chain."
                body="The marketplace lives off-chain where content belongs. Money never does; every state change below is a contract call you can verify, not a database row you have to trust."
              />
              <Link href="/jobs" className="group mt-10 inline-flex min-h-11 items-center gap-3 font-display text-[11px] uppercase text-rose-light hover:text-white">
                Watch it live on real jobs <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" weight="bold" />
              </Link>
            </div>
            <div className="space-y-6">
              {steps.map((step, i) => (
                <div key={step.title} className="lg:sticky" style={{ top: `${112 + i * 20}px` }}>
                  <LiftCard className="glass-raised relative flex gap-6 overflow-hidden p-7 md:p-8">
                    {/* ghost index — oversized, hollow, structural */}
                    <span aria-hidden className="ghost-num display pointer-events-none absolute -right-2 -top-3 select-none text-[88px] leading-none">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <Sprite name={step.sprite} size={48} className="mt-1" />
                    <div className="relative min-w-0">
                      <span className="display text-[12px] text-rose-light">STEP {String(i + 1).padStart(2, "0")}</span>
                      <h3 className="mt-3 text-[21px] font-semibold leading-snug">{step.title}</h3>
                      <p className="mt-3 max-w-[62ch] text-[16px] leading-relaxed text-dim">{step.body}</p>
                      <div className="num mt-5 text-[13px] text-faint">
                        <span className="text-rose-light">&gt; </span>
                        {step.chip}
                      </div>
                    </div>
                  </LiftCard>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── trust: arbiters ───────────────────────────────────────────── */}
        <section id="trust" className="relative border-t-2 border-line-strong py-28">
          <div className="mx-auto grid max-w-[1400px] items-center gap-16 px-5 md:px-8 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="order-2 lg:order-1">
              <SectionHead
                title="Disputes end in hours, with people who stake their name."
                body="Both parties nominate an arbiter; a match starts the 72-hour SLA clock. Resolutions inside the SLA raise the arbiter's on-chain trust score, overdue ones slash it. The badge is soulbound (ERC-5194), so the score can't be bought, sold, or reset."
              />
              {/* stat ledger — rows, not boxes; numeral left, meaning right */}
              <dl className="mt-10 max-w-md">
                {[
                  ["+1", "trust per resolution inside the 72h SLA", true],
                  ["−2", "slashed when the clock runs out; anyone can call it", false],
                  ["SBT", "soulbound badge (ERC-5194), non-transferable by design", false],
                ].map(([n, l, lead]) => (
                  <div key={l as string} className="flex items-baseline justify-between gap-6 border-t-2 border-dashed border-line py-5 last:border-b-2">
                    <dt className={cn("display shrink-0 text-[20px] leading-none", lead ? "text-rose-light" : "text-foreground")}>{n}</dt>
                    <dd className="text-right text-[15px] leading-snug text-dim">{l}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <ArbiterCardVisual className="order-1 lg:order-2" />
          </div>
        </section>

        {/* ── closing CTA ───────────────────────────────────────────────── */}
        <section className="border-t-2 border-line-strong py-28">
          <div className="mx-auto max-w-[1400px] px-5 md:px-8">
            <div className="grid gap-12 lg:grid-cols-[1.4fr_0.6fr] lg:items-end">
              <h2 className="display text-[22px] leading-[1.5] sm:text-[30px] md:text-[36px]">
                Stop invoicing.
                <br />
                <span className="text-rose-light">Start escrowing.</span>
              </h2>
              <div className="flex flex-col gap-4 lg:items-end">
                <PixelLink href="/jobs/new">
                  Post your first job
                  <ArrowRight className="h-5 w-5" weight="bold" />
                </PixelLink>
                <span className="text-[14px] text-faint">anvil devnet · no real funds, real contracts</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── footer ────────────────────────────────────────────────────── */}
        <footer className="border-t-2 border-line-strong bg-ink-raised py-10">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-5 md:flex-row md:items-center md:justify-between md:px-8">
            <div className="flex flex-wrap items-center gap-4">
              <Logo size="sm" />
              <span className="text-[14px] text-faint">milestone escrow for freelance work</span>
            </div>
            <div className="num flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-faint">
              <Link href="/jobs" className="py-1 hover:text-foreground">jobs</Link>
              <Link href="/arbiters" className="py-1 hover:text-foreground">arbiters</Link>
              <Link href="/console" className="py-1 hover:text-foreground">backend console</Link>
              <span className="py-1">Escrow.sol · ArbiterRegistry.sol · 97%+ branch coverage</span>
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
      <h2 className="display max-w-[22ch] text-[18px] leading-[1.6] md:text-[24px]">{title}</h2>
      <p className="mt-6 max-w-[62ch] text-[16px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}

/* ── arbiter card visual ──────────────────────────────────────────────── */

function ArbiterCardVisual({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={stepTransition(0.4, 4)}
      className={className}
    >
      <LiftCard className="glass-raised p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[13px] font-semibold uppercase tracking-wide text-faint">arbiter registry · erc-5194</span>
          <span className="flex items-center gap-2 border-2 border-state-disputed bg-state-disputed/10 px-2 py-0.5 text-[13px] font-semibold uppercase leading-5 text-state-disputed">
            <StatusDot color="#fb923c" pulse /> 72h SLA live
          </span>
        </div>
        <div className="mt-6 flex items-center gap-4">
          <AddressAvatar address="0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" size={64} />
          <div>
            <div className="text-[19px] font-semibold leading-tight">Ingrid Salm</div>
            <div className="num mt-1 text-[13px] text-faint">security researcher · 40+ peer reviews</div>
          </div>
          <div className="ml-auto text-right">
            <div className="display text-[24px] leading-none text-state-released">12</div>
            <div className="mt-2 text-[13px] font-semibold uppercase tracking-wide text-faint">trust</div>
          </div>
        </div>
        <div className="mt-6 divide-y-2 divide-dashed divide-line border-y-2 border-dashed border-line">
          {[
            ["resolved · split", "#a7f3d0", "1h 48m inside SLA", "+1"],
            ["resolved · release", "#34d399", "3h 02m inside SLA", "+1"],
            ["resolved · refund", "#d4d4d8", "61h 20m inside SLA", "+1"],
          ].map(([label, color, time, delta]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-3.5">
              <span className="flex items-center gap-3 text-[14px] text-dim">
                <span className="h-2.5 w-2.5" style={{ background: color }} />
                {label}
              </span>
              <span className="flex items-center gap-3">
                <span className="num text-[13px] text-faint">{time}</span>
                <span className="num text-[13px] text-state-released">{delta}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="num mt-5 text-[13px] text-faint">badge #7 · soulbound · transfer() reverts by design</div>
      </LiftCard>
    </motion.div>
  );
}

/* ── data ─────────────────────────────────────────────────────────────── */

const ledgerItems = [
  { label: "0xf39F…2266", text: "funded milestone 1 · 0.240 ETH", color: "#fbbf24" },
  { label: "0x7099…79C8", text: "submitted threat model for review", color: "#60a5fa" },
  { label: "escrow", text: "released 0.234 ETH to freelancer · fee 0.006", color: "#34d399" },
  { label: "0x9965…0a4D", text: "resolved dispute · split 50/50", color: "#a7f3d0" },
  { label: "registry", text: "arbiter trust +1 · inside SLA", color: "#fb7185" },
  { label: "0x3C44…93BC", text: "accepted proposal · 3 milestones", color: "#a1a1aa" },
];

const steps = [
  {
    title: "Post the work, broken into milestones",
    body: "A job carries its own milestone template: titles, scope, amounts. The API validates the sum against the budget range server-side; the template becomes the contract's blueprint when the work is awarded.",
    sprite: "scroll",
    chip: "POST /jobs · milestone sum validated",
  },
  {
    title: "Award it — the bridge event",
    body: "Accepting a proposal creates the project and its milestones in one transaction, locks the job, and auto-rejects the losing bids. Half-awarded jobs are structurally impossible.",
    sprite: "shield",
    chip: "project + milestones born atomically",
  },
  {
    title: "Fund the milestone — value locks",
    body: "The client's wallet calls fund() with the amount and a reference. From this second the money belongs to the contract: it can only move by approve, cancel, or arbitration. Both parties can see it, neither can touch it.",
    sprite: "lock",
    chip: "fund(bytes32 ref, address freelancer)",
  },
  {
    title: "Ship, then submit on-chain",
    body: "Delivery notes and files land off-chain; the state flip that matters is the freelancer's submit() transaction. The indexer mirrors it within seconds and the client's review window opens.",
    sprite: "chest",
    chip: "submit(uint256 milestoneId)",
  },
  {
    title: "Approve — or open the arbiter path",
    body: "approve() releases the escrowed value instantly, minus the 2.5% fee. Can't agree? Either side locks the milestone into dispute and pays the fee; the contract draws up to 3 random, staked arbiters who vote commit-reveal to a 2-of-3 majority.",
    sprite: "sword",
    chip: "approve · openDispute · commitReveal",
  },
] as const satisfies readonly { title: string; body: string; sprite: SpriteName; chip: string }[];
