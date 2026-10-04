/**
 * Brand tokens, lifted from apps/web/app/globals.css and DESIGN.md (the pixel
 * ledger). One accent (rose); the state hues only ever mean a milestone state.
 */
export const C = {
  ink: "#09090b",
  raised: "#101015",
  hover: "#17171e",
  sunk: "#060608",
  fg: "#f4f4f5",
  dim: "#b9b9c2",
  faint: "#9b9ba5",
  rose: "#e11d48",
  roseLight: "#fb7185",
  roseDeep: "#7f1028",
  line: "#2a2a34",
  lineStrong: "#43434f",
  // milestone states
  pending: "#a1a1aa",
  funded: "#fbbf24",
  submitted: "#60a5fa",
  released: "#34d399",
  disputed: "#fb923c",
  split: "#a7f3d0",
  refund: "#d4d4d8",
} as const;

export const F = {
  /** Press Start 2P: short strings only. Sizes in multiples of 8 stay crisp. */
  display: "'Press Start 2P', monospace",
  body: "'Pixelify Sans', sans-serif",
  /** On-chain data stays non-pixel so exact values read. */
  mono: "'IBM Plex Mono', monospace",
} as const;

/** The app draws 2px frames at 1x; the film draws at 2x so they survive a phone screen. */
export const FRAME = 4;
export const SLAB = 12;
