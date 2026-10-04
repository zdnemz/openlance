import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Crt } from "../components/Stage";
import { Sfx } from "../components/Sfx";
import { useLayout } from "../layout";
import { blink, flash, pop, popScale } from "../motion";
import { Display, PixelButton, Sprite } from "../pixel";
import { cue, scene } from "../timeline";
import { C, F } from "../theme";

/** The lockup: mark, wordmark, the landing's headline, and PRESS START. Then the CRT switches off. */
export function Finale() {
  const f = useCurrentFrame();
  const L = useLayout();
  const { durationInFrames } = scene("finale");
  const olAt = cue("finale", "openlance");
  const flAt = cue("finale", "freelance");
  const proofAt = cue("finale", "proof");
  const pressAt = cue("finale", "press");
  const pressed = f >= pressAt + 2 && f < pressAt + 8;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: L.tall ? 56 : 40, paddingBottom: L.tall ? 160 : 0 }}>
        <div style={popScale(f, 2)}>
          <Sprite name="mark" size={L.tall ? 288 : 224} />
        </div>
        <Display size={96} style={popScale(f, olAt)}>
          OpenLance
        </Display>
        <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: L.tall ? 56 : 60, color: C.fg, textAlign: "center", lineHeight: 1.2, ...pop(f, flAt) }}>
          Freelance work, {L.tall && <br />}paid <span style={{ color: f >= proofAt ? C.roseLight : C.fg }}>by proof.</span>
          <span style={{ fontFamily: F.display, color: C.roseLight, opacity: blink(f, 30) }}>_</span>
        </div>
        <div style={{ marginTop: 16, ...pop(f, pressAt), opacity: f < pressAt ? 0 : f < pressAt + 30 ? 1 : 0.4 + 0.6 * flash(f, 24) }}>
          <PixelButton pressed={pressed} size={32}>
            Press start
          </PixelButton>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, ...pop(f, pressAt + 8) }}>
          <div style={{ fontFamily: F.mono, fontWeight: 500, fontSize: 32, color: C.dim }}>github.com/zdnemz/openlance</div>
          <div style={{ fontFamily: F.body, fontSize: 26, color: C.faint }}>testnet · real contracts · no real funds</div>
        </div>
      </AbsoluteFill>
      <Crt mode="off" at={durationInFrames - 12} />
      <Sfx name="pop" at={2} volume={0.4} />
      <Sfx name="select" at={olAt} volume={0.4} />
      <Sfx name="click" at={pressAt + 2} volume={0.6} />
      <Sfx name="fanfare" at={pressAt + 6} volume={0.6} />
    </AbsoluteFill>
  );
}
