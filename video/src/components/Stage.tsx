import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { useLayout } from "../layout";
import { pop, popScale, stepIn } from "../motion";
import { Chip, Display } from "../pixel";
import { C } from "../theme";

export const INSTRUMENT_W = 820;

/** Title column + instrument column (wide), or title over instrument (tall). */
export function StageLayout({ title, children }: { title: ReactNode; children: ReactNode }) {
  const L = useLayout();
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          top: L.title.top,
          height: L.title.h,
          ...(L.tall ? { left: 48, right: 48, alignItems: "center", textAlign: "center" } : { left: 120, width: 780, alignItems: "flex-start" }),
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: L.tall ? 28 : 40,
        }}
      >
        {title}
      </div>
      <div
        style={{
          position: "absolute",
          top: L.instrument.top,
          height: L.instrument.h,
          width: INSTRUMENT_W,
          left: L.tall ? (L.W - INSTRUMENT_W) / 2 : 1000,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** "STAGE 1 / FUND / fund(…)": the standard title block. */
export function StageTitle({ stage, verb, chip, chipAt }: { stage: string; verb: string; chip: ReactNode; chipAt: number }) {
  const f = useCurrentFrame();
  const L = useLayout();
  return (
    <>
      <Display size={32} color={C.roseLight} style={pop(f, 0)}>
        {stage}
      </Display>
      <Display size={L.tall ? 96 : 112} style={{ ...popScale(f, 3), transformOrigin: L.tall ? "center" : "left center" }}>
        {verb}
      </Display>
      <div style={pop(f, chipAt)}>
        <Chip size={L.tall ? 26 : 28}>{chip}</Chip>
      </div>
    </>
  );
}

/**
 * CRT power: "on" opens a white scanline into the picture, "off" collapses
 * the picture back to a line and then a dot. Drawn as black bars over
 * everything, each phase in whole steps.
 */
export function Crt({ mode, at }: { mode: "on" | "off"; at: number }) {
  const frame = useCurrentFrame();
  const { W, H } = useLayout();
  const f = frame - at;
  if (f < 0 && mode === "off") return null;
  // open: 0 → picture fully hidden, 1 → fully shown
  let open: number;
  let line = 0; // white scanline width, 0..1
  if (mode === "on") {
    open = f < 4 ? 0 : stepIn(f, 4, 6, 3);
    line = f < 4 ? stepIn(f, 0, 4, 2) : 0;
  } else {
    open = 1 - stepIn(f, 0, 6, 3);
    line = f < 6 ? 0 : f < 10 ? 1 - stepIn(f, 6, 4, 2) * 0.96 : 0;
  }
  if (open >= 1) return null;
  const bar = Math.round(((1 - open) * H) / 2 / 8) * 8;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bar, background: "#000" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: bar, background: "#000" }} />
      {open <= 0 && <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, background: "#000" }} />}
      {line > 0 && <div style={{ position: "absolute", top: H / 2 - 4, height: 8, left: (W * (1 - line)) / 2, width: W * line, background: C.fg }} />}
    </AbsoluteFill>
  );
}
