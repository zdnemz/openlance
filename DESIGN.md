---
name: EscrowLance Ledger
kind: dark-premium-fintech
updated: 2026-09-19
fonts:
  display: Instrument Serif (400 + italic) — page-level headlines, editorial trust voice
  body: Schibsted Grotesk (variable) — UI, body copy, controls
  data: IBM Plex Mono (400/500/600) — amounts, hashes, refs, all on-chain data (tabular)
palette:
  background: "#09090b" (zinc-950, "ink")
  raised: "#0e0e12" ink-raised / glass tint rgba(13,13,17,0.62..0.82)
  foreground: "#f4f4f5"
  dim: "#b9b9c2" (secondary text, WCAG AA on all ink surfaces)
  faint: "#9b9ba5" (meta text, WCAG AA on all ink surfaces)
  accent: "#e11d48" Deep Rose (ONE accent; hover #f43f5e)
  state-semantics: funded #fbbf24 · submitted #38bdf8 · released #34d399 · disputed #fb923c · split #5eead4 · refund #d4d4d8 (never decoration)
  lines: rgba(255,255,255,0.07) line / 0.13 line-strong
motion:
  philosophy: landing may move, but only in response to the reader's scroll; the app interior stays calm
  vocabulary: spring(stiffness 100, damping 20) entrances; magnetic CTAs (MagneticLink); cursor-tracked spotlight borders (SpotCard); breathing status dots; NO infinite auto-loops, NO marquee (scroll-linked drift instead)
  reduced-motion: MotionConfig reducedMotion="user" on landing + CSS kill for breathe/shimmer
---

# EscrowLance design system — "the ledger"

## World

Dark premium fintech, one rose accent, structure instead of glow. The metaphor
is a ledger: hairline rules, mono numerals, ghost index numerals, drafting-grid
paper under the hero instrument. Serif display headlines give the product an
editorial, own-world voice against the technical mono data.

## Layout grammar

- Landing: asymmetric splits (1.08fr/0.92fr), sticky-stack how-it-works, hairline stat rails (divide-x, no boxes).
- App: left rail 240px desktop / top+bottom bars mobile; max-w-1200px interior; page headers = serif h1 + right-aligned mono meta (no kickers — banned).
- Lists read as ledger tables (divide-y hairline rows in one bordered container), never card grids.
- Admin: asymmetric bento (3/2/1), deployment manifest as definition rows.

## Components

- `SpotCard` — glass card + cursor-tracked rose border light (CSS vars, zero re-render).
- `MagneticLink` — primary CTA pulls toward cursor (motion values + spring, never useState).
- `ListHead` — functional list-section heading (13px semibold, normal case). Replaces the banned kicker/SectionLabel.
- `StatusBadge` / `StatusDot` — milestone state semantics with pulse on live states.
- `EthAmount`, `HashText`, `AddressText` — mono data atoms; hashes copyable.
- `AddressAvatar` — deterministic geometry from address bits.
- `EmptyState` — dashed hairline container, honest copy, one action.
- `press` — standardized tactile press (translate-y + scale).

## Rules (detector + craft-floor enforced)

- ONE accent (rose). State hues are semantics only.
- Glass = dark-tinted pane (rgba(13,13,17,.62)+blur) — guarantees AA contrast; never a light wash.
- No nested cards: flatten with hairlines, spacing, typography.
- No kicker-above-heading, no gradient text, no glow blobs, no infinite marquees, no em-dash saturation in body copy.
- Functional text floor 11px; body copy 12px+; display tracking ≥ -0.04em.
- Browser surfaces themed: selection (rose), caret (rose), focus-visible ring, custom scrollbar.
- Line length: body measure ≤ 75ch (58–62ch containers).

## Known exceptions

- `hairline-grid` hero backdrop: detector advisory (generated-UI signature risk) — kept deliberately; ledger-paper grid is the product's own metaphor under the escrow instrument, masked to the hero only.
- `layout-transition` rule ignored project-wide (documented in `.impeccable/config.json`): the only height-transition CSS in the app is sonner's runtime-injected `[data-sonner-toast]` stack-expansion mechanic, not our stylesheet.
- Project room `/projects/[id]`: the live URL detector reports 2 residual `nested-cards` findings that do not exist in the rendered DOM — computed-style probes of the authenticated page find zero boxed-in-boxed elements, the frozen authenticated DOM snapshot scans clean, and every suspect pattern (pills, buttons, inputs, avatars, bubbles in cards) tests clean in isolation. Treated as a measurement artifact of the detector's own browsing session.
