/**
 * Pixel art renderers — turn the character grids in pixel-sprites.ts into
 * crisp SVG. Horizontal runs of one color are merged into a single <rect>, so a
 * 16x16 sprite is a few dozen nodes, and `shape-rendering: crispEdges` keeps
 * every cell a hard-edged square at any size. Server-safe (no hooks).
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { PALETTE, SPRITES, addressSprite, type SpriteName } from "@/components/pixel-sprites";

type Run = { x: number; y: number; w: number; c: string };

/** Merge horizontal runs of the same color; `.` is transparent. */
function runs(rows: string[], colorOf: (ch: string) => string | undefined): Run[] {
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

export function Sprite({
  name,
  size = 32,
  className,
  style,
  title,
}: {
  name: SpriteName;
  /** Rendered size in px. Multiples of 16 keep every cell a whole number of pixels. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const rows = SPRITES[name];
  const w = rows[0]!.length;
  return (
    <svg
      width={size}
      height={(size * rows.length) / w}
      viewBox={`0 0 ${w} ${rows.length}`}
      shapeRendering="crispEdges"
      className={cn("shrink-0", className)}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {runs(rows, (ch) => PALETTE[ch]).map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
}

/** The OpenLance mark: a shield with a rose lance through it. */
export function PixelMark({ size = 32, className }: { size?: number; className?: string }) {
  return <Sprite name="mark" size={size} className={className} />;
}

/**
 * Deterministic address sprite — an 8x8, left-right symmetric "space invader"
 * grown from the address bits, so every wallet gets a stable face. Pure
 * function of the address: identical on the server and the client, so there is
 * nothing to hydrate-mismatch.
 */
export function SpriteAvatar({
  address,
  size = 36,
  className,
}: {
  address: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const { rows, hue } = addressSprite(address);
  const body = `hsl(${hue} 72% 60%)`;
  const shade = `hsl(${hue} 62% 38%)`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className={cn("shrink-0 border-2 border-line-strong bg-ink-sunk", className)}
      aria-hidden
    >
      {runs(rows, (ch) => (ch === "f" ? body : ch === "d" ? shade : undefined)).map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.c} />
      ))}
    </svg>
  );
}
