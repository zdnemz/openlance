import { AbsoluteFill, useCurrentFrame } from "remotion";
import { useLayout } from "../layout";
import { hash } from "../motion";
import { SCENES } from "../timeline";
import { C } from "../theme";

const HALF = 6;

/**
 * The cut between scenes: a block dissolve. Cells fill in a fixed scrambled
 * order over six frames, the scene changes under full cover, then they clear.
 */
export function PixelWipe() {
  const frame = useCurrentFrame();
  const { W, H, cell } = useLayout();
  const cut = SCENES.slice(1).find((s) => Math.abs(frame - s.from + 0.5) <= HALF);
  if (!cut) return null;
  const f = frame - cut.from;
  const p = f < 0 ? (f + HALF + 1) / HALF : (f + 1) / HALF;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const blocks = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const t = hash(i + cut.from);
      const on = f < 0 ? t < p : t >= p;
      if (!on) continue;
      blocks.push(<div key={i} style={{ position: "absolute", left: x * cell, top: y * cell, width: cell, height: cell, background: t > 0.9 ? C.rose : C.hover }} />);
    }
  }
  return <AbsoluteFill>{blocks}</AbsoluteFill>;
}
