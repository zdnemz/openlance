---
name: OpenLance Pixel
kind: dark-pixel-art-fintech
updated: 2026-10-04
fonts:
  display: Press Start 2P (400) — page headlines, nav, buttons, list heads, big money numerals. One em per glyph: short strings only, 11–36px
  body: Pixelify Sans (variable 400–700) — UI and body copy, 13px floor, 16px body
  data: IBM Plex Mono (400/500/600) — amounts, hashes, refs, all on-chain data (tabular); stays non-pixel so exact values are legible
  hosting: all three self-hosted via next/font/local (apps/web/app/fonts, OFL) — no build-time network
palette:
  background: "#09090b" ("ink")
  raised: "#101015" ink-raised panel fill · "#17171e" ink-hover · "#060608" ink-sunk (recessed wells)
  foreground: "#f4f4f5"
  dim: "#b9b9c2" (secondary text, WCAG AA on all ink surfaces)
  faint: "#9b9ba5" (meta text, WCAG AA on all ink surfaces) — never used with an opacity modifier
  accent: "#e11d48" Deep Rose (ONE accent) · light "#fb7185" (frames, focus, text on ink) · deep "#7f1028" (button slab, accent shadow)
  state-semantics: funded #fbbf24 · submitted #60a5fa · released #34d399 · disputed #fb923c · split #a7f3d0 · refund #d4d4d8 (never decoration; source: --color-state-* in apps/web/app/globals.css)
  lines: "#2a2a34" line · "#43434f" line-strong (solid, not alpha)
shape:
  radius: 0 everywhere (theme radius tokens are zeroed; no rounded-* classes in the tree)
  frames: 2px solid; dividers 2px solid or 2px dashed
  depth: offset hard slabs (4px/6px #000, rose-deep for the accent panel) — never blur, never gradient
motion:
  philosophy: everything moves in whole-pixel frames. landing may move, only in response to the reader's scroll (snapped to 8px); the app interior stays calm
  vocabulary: steps() easing (--default-transition-timing-function: steps(3)); blink for live status squares; marching-dither skeletons; 8-step spinner; pixel-pop (4 frames) for dialogs and menus; button press drops the face onto its slab. NO springs, NO eased tweens, NO infinite decorative loops
  reduced-motion: MotionConfig reducedMotion="user" on the landing + CSS kill for every keyframe animation and the button/lift transitions
---

# OpenLance design system — "pixel ledger"

## World

A dark arcade cabinet for escrow. The metaphor is a ledger drawn in pixels:
square slabs with hard frames, mono numerals, hand-drawn sprites for the things
that matter (the lock, the chest, the coin, the sword), and an identity sprite
for every wallet. One rose accent; the milestone-state hues are the only other
color and they only ever mean a state.

## Layout grammar

- Landing: asymmetric splits (1.08fr/0.92fr), a sticky stack of sprite-led step panels, dashed stat rails (divide-x, no boxes), a stepped escrow-state card as the hero instrument.
- App: left rail 240px desktop / top+bottom bars mobile; max-w-1200px interior; page headers = Press Start h1 + right-aligned mono meta (no kickers — banned).
- Lists read as ledger tables (divide-y 2px rows in one framed container), never card grids.
- Admin: asymmetric bento (3/2/1), deployment manifest as definition rows.
- Grid items are `min-width: 0` globally (`.grid > *`): a nowrap line must never stretch a track.

## Components

- `Button` / `.pixel-btn` — notched 2px frame drawn outside the box (so corners are cut one pixel step), bevel, 4px slab. Three custom properties (`--pb` face, `--pf` frame, `--ps` slab) make every variant a palette. Press drops the face 4px onto the slab; hover lifts 1px. Labels wrap (never overflow) and are Press Start caps — a few words. Variants: default (rose), outline, secondary, destructive, ghost, link. Gold "fund" actions override the three properties.
- `.glass` / `.glass-raised` / `.glass-accent` — solid slab with 2px frame and offset shadow block (names kept for call sites; there is no glass). `glass-accent` is reserved for the money moment (the escrow card).
- `.pixel-well` — recessed field (inputs, textareas) with an inset shadow.
- `LiftCard` / `.pixel-lift` — a panel that links somewhere: face steps up-left, slab grows. Replaces the cursor spotlight.
- `PixelLink` — the landing CTA as a pixel button. Replaces the magnetic link.
- `Sprite` + `pixel-sprites.ts` — hand-drawn 16x16 grids (mark, coin, lock, chest, sword, scroll, hourglass, shield) rendered as merged-run SVG with `crispEdges`. Colors come from PALETTE only.
- `AddressAvatar` / `SpriteAvatar` — 8x8 left-right symmetric sprite grown from the address bits; deterministic, identical on server and client.
- `PixelMark` / `Logo` — the shield-and-lance mark is code (the same art as app/icon.svg and public/logo.svg) plus a Press Start wordmark.
- `ListHead` — functional list-section heading (Press Start 12px caps). Replaces the banned kicker.
- `StatusBadge` / `StatusDot` — milestone state semantics: 2px frame in the state hue, square dot, blink on live states.
- `EthAmount` (`pixel` prop for headline money), `HashText`, `AddressText` — data atoms; hashes copyable and dotted-underlined.
- `EmptyState` — dashed 2px container, optional sprite (chest for "nothing yet"), honest copy, one action.
- `icons.tsx` — concept → pixelarticons glyph. Glyphs are drawn on 24px; they stay sharpest at 24 (and 12 on 2x displays), crisp-edged at 16/20.
- `MessageBubble` (project room chat) — the one place a box inside a box is allowed, because a conversation is not a list.

## Rules

- ONE accent (rose). State hues are semantics only.
- No radius, no blur, no gradient, no glow, no drop-shadow with a soft edge. The only "effects" are slabs, dither and the hero dot grid.
- Dither paper (a fixed 2px checker at ~2.5%) is the only page texture; the landing hero adds a masked dot grid.
- No nested cards: flatten with dashed rules, spacing, typography.
- No kicker-above-heading, no gradient text, no marquee loops, no em-dash saturation in body copy.
- Press Start only for short strings (headlines, nav, buttons, list heads, big numerals). Long titles and prose are Pixelify Sans; exact data is Plex Mono.
- Type floor: 13px (the pixel faces read small); body 16px; Tailwind `text-xs`/`text-sm` are remapped to 13/15px in the theme.
- Controls are at least 44px tall; focus is a 2px rose-light frame with offset, always visible.
- Contrast: `text-faint` and `text-dim` clear AA on every ink surface; never apply opacity to text. Dimming an inactive thing dims its sprite or border, not its words.
- Line length: body measure <= 75ch (58–62ch containers).
- Browser surfaces themed: selection (rose), caret (rose-light), square scrollbar.
- Icons: pixelarticons only; no emoji as UI.

## Known exceptions

- `hairline-grid` hero backdrop is now a coarse dot grid under the escrow instrument, masked to the hero only.
- `layout-transition` rule ignored project-wide (documented in `.impeccable/config.json`): the only height-transition CSS in the app is sonner's runtime-injected `[data-sonner-toast]` stack-expansion mechanic, not our stylesheet.
- Project room chat: message bubbles are square framed slabs inside the framed pane, so the `nested-cards` detector can still fire on the chat thread. That is deliberate — a conversation rendered as a flat ledger table is the thing the bubbles replaced. Own messages sit right on `rose-soft` at low alpha, the counterparty left on a plain frame, so a thread of own-messages never floods the page.
- Sonner toasts are styled inline in `app/layout.tsx` (frame, slab, Pixelify) because the library renders them outside our stylesheet.
