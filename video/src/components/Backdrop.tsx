import { AbsoluteFill, useCurrentFrame } from "remotion";
import { SCENES } from "../timeline";
import { C } from "../theme";

// Square 4px dots every 32px (the hero's dot grid, at 2x), and the 2px dither paper.
const DOTS = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' shape-rendering='crispEdges'><rect width='4' height='4' fill='#ffffff' fill-opacity='0.07'/></svg>`,
)}")`;
const DITHER = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'><rect width='2' height='2' fill='#ffffff' fill-opacity='0.025'/><rect x='2' y='2' width='2' height='2' fill='#ffffff' fill-opacity='0.025'/></svg>`,
)}")`;

/** Ink, dither and a dot grid that steps 8px at each scene change, never on its own clock. */
export function Backdrop() {
  const frame = useCurrentFrame();
  const index = SCENES.filter((s) => s.from <= frame).length - 1;
  const shift = index * 8;
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <AbsoluteFill style={{ backgroundImage: DOTS, backgroundPosition: `${shift}px ${shift}px` }} />
      <AbsoluteFill style={{ backgroundImage: DITHER }} />
    </AbsoluteFill>
  );
}
