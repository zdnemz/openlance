/**
 * Pixel primitives for the film, mirroring the app's components at 2x:
 * Sprite (merged-run crisp SVG, as apps/web/components/pixel-art.tsx),
 * Panel (.glass / .glass-accent slabs), Badge (StatusBadge), Chip, PixelButton
 * (.pixel-btn) and Avatar (the address sprite).
 */
import type { CSSProperties, ReactNode } from "react";
import { PALETTE, SPRITES, addressSprite } from "../../apps/web/components/pixel-sprites";
import { EXTRA_SPRITES } from "./sprites-extra";
import { C, F, FRAME, SLAB } from "./theme";

const ALL = { ...SPRITES, ...EXTRA_SPRITES } as Record<string, readonly string[]>;
export type SpriteKey = keyof typeof SPRITES | keyof typeof EXTRA_SPRITES;

type Run = { x: number; y: number; w: number; c: string };

function runs(rows: readonly string[], colorOf: (ch: string) => string | undefined): Run[] {
  const out: Run[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = colorOf(row[x]!);
      if (!c) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && colorOf(row[x + w]!) === c) w++;
      out.push({ x, y, w, c });
      x += w;
    }
  });
  return out;
}

export function Sprite({ name, size = 128, style, mono }: { name: SpriteKey; size?: number; style?: CSSProperties; mono?: string }) {
  const rows = ALL[name]!;
  const w = rows[0]!.length;
  return (
    <svg width={size} height={(size * rows.length) / w} viewBox={`0 0 ${w} ${rows.length}`} shapeRendering="crispEdges" style={{ display: "block", flexShrink: 0, ...style }}>
      {runs(rows, (ch) => (ch === "." ? undefined : (mono ?? PALETTE[ch]))).map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
}

/** The 8x8 symmetric "space invader" every wallet grows from its address bits. */
export function Avatar({ address, size = 96, frame = C.lineStrong }: { address: string; size?: number; frame?: string }) {
  const { rows, hue } = addressSprite(address);
  const body = `hsl(${hue} 72% 60%)`;
  const shade = `hsl(${hue} 62% 38%)`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="-1 -1 10 10"
      shapeRendering="crispEdges"
      style={{ display: "block", flexShrink: 0, background: C.sunk, outline: `${FRAME}px solid ${frame}` }}
    >
      {runs(rows, (ch) => (ch === "f" ? body : ch === "d" ? shade : undefined)).map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
}

/** A solid slab with a hard frame and an offset block shadow. accent = the money moment. */
export function Panel({
  children,
  accent,
  frame,
  slab,
  style,
}: {
  children: ReactNode;
  accent?: boolean;
  frame?: string;
  slab?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: C.raised,
        border: `${FRAME}px solid ${frame ?? (accent ? C.rose : C.lineStrong)}`,
        boxShadow: `${SLAB}px ${SLAB}px 0 0 ${slab ?? (accent ? C.roseDeep : "#000")}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** StatusBadge: a frame in the state hue, a square dot, Press Start caps. */
export function Badge({ label, color, dot = 1, size = 24 }: { label: string; color: string; dot?: number; size?: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.6,
        padding: `${size * 0.45}px ${size * 0.6}px`,
        border: `${FRAME}px solid ${color}`,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        color,
        fontFamily: F.display,
        fontSize: size,
        lineHeight: 1,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: size * 0.66, height: size * 0.66, background: color, opacity: dot }} />
      {label}
    </span>
  );
}

/** A framed mono chip: the real contract call behind the scene. */
export function Chip({ children, color = C.faint, size = 28 }: { children: ReactNode; color?: string; size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: `${size * 0.4}px ${size * 0.6}px`,
        border: `${FRAME}px dashed ${C.lineStrong}`,
        background: C.sunk,
        color,
        fontFamily: F.mono,
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/**
 * .pixel-btn: face, frame and slab as three colours. `pressed` drops the face
 * onto its slab, the app's press.
 */
export function PixelButton({
  children,
  pressed = false,
  face = C.rose,
  frame = C.roseLight,
  slab = C.roseDeep,
  ink = C.fg,
  size = 28,
}: {
  children: ReactNode;
  pressed?: boolean;
  face?: string;
  frame?: string;
  slab?: string;
  ink?: string;
  size?: number;
}) {
  const depth = 8;
  return (
    <span style={{ display: "inline-block", position: "relative", paddingBottom: depth }}>
      <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: depth, background: slab }} />
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 16,
          padding: `${size * 0.75}px ${size}px`,
          background: face,
          outline: `${FRAME}px solid ${frame}`,
          outlineOffset: -FRAME,
          boxShadow: `inset 0 ${FRAME}px 0 0 rgba(255,255,255,0.18), inset 0 -${FRAME}px 0 0 rgba(0,0,0,0.25)`,
          color: ink,
          fontFamily: F.display,
          fontSize: size,
          lineHeight: 1,
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          transform: pressed ? `translateY(${depth}px)` : "none",
        }}
      >
        {children}
      </span>
    </span>
  );
}

/** Press Start text. Sizes stay on multiples of 8 so every glyph pixel is whole. */
export function Display({ children, size, color = C.fg, style }: { children: ReactNode; size: number; color?: string; style?: CSSProperties }) {
  return (
    <div style={{ fontFamily: F.display, fontSize: size, lineHeight: 1.3, color, textTransform: "uppercase", whiteSpace: "pre", ...style }}>
      {children}
    </div>
  );
}
