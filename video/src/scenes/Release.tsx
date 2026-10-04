import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sfx } from "../components/Sfx";
import { INSTRUMENT_W, StageLayout, StageTitle } from "../components/Stage";
import { hash, pop, popScale, snap, stepIn, twos } from "../motion";
import { Badge, Display, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F } from "../theme";

/** Stage 3: approved, the chest opens and the payout bursts out. No invoices, no chasing. */
export function Release() {
  const f = useCurrentFrame();
  const approvedAt = cue("release", "approved");
  const payAt = cue("release", "payout");
  const invAt = cue("release", "invoices");
  const chaseAt = cue("release", "chasing");
  const open = f >= payAt;
  const chest = 256;
  const cx = INSTRUMENT_W / 2;

  return (
    <AbsoluteFill>
      <StageLayout title={<StageTitle stage="Stage 3" verb="Release" chip="approve(milestone 1) · fee 2.5%" chipAt={approvedAt} />}>
        <div style={{ position: "absolute", left: cx - chest / 2, top: 24 }}>
          <Sprite name={open ? "chestOpen" : "chest"} size={chest} />
        </div>
        {/* coins burst on stepped arcs, drawn on twos and snapped to the 8px grid */}
        {open &&
          Array.from({ length: 12 }, (_, i) => {
            const t = twos(f - payAt);
            if (t > 30) return null;
            const vx = (hash(i) * 2 - 1) * 20;
            const vy = -(24 + hash(i + 40) * 16);
            const x = snap(vx * t);
            const y = snap(vy * t + 1.1 * t * t);
            return (
              <div key={i} style={{ position: "absolute", left: cx - 32 + x, top: 96 + y }}>
                <Sprite name="coin" size={64} />
              </div>
            );
          })}
        {f >= approvedAt && (
          <div style={{ position: "absolute", left: cx + 72, top: 8, ...popScale(f, approvedAt) }}>
            <Display size={28} color={C.roseLight} style={{ padding: "14px 18px", border: `4px solid ${C.roseLight}`, background: C.ink }}>
              Approved
            </Display>
          </div>
        )}
        <div style={{ position: "absolute", left: 0, right: 0, top: 316, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, ...pop(f, payAt + 4) }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
            <span style={{ fontFamily: F.display, fontSize: 56, color: C.released }}>+0.234</span>
            <span style={{ fontFamily: F.display, fontSize: 24, color: C.faint }}>ETH</span>
            <span style={{ fontFamily: F.body, fontSize: 36, color: C.dim }}>→ Dario</span>
          </div>
          <Badge label="released" color={C.released} size={20} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 540, display: "flex", justifyContent: "center", gap: 56 }}>
          <Struck word="Invoices" at={invAt} />
          <Struck word="Chasing" at={chaseAt} />
        </div>
      </StageLayout>
      <Sfx name="pop" at={0} volume={0.4} />
      <Sfx name="stamp" at={approvedAt} volume={0.7} />
      <Sfx name="payout" at={payAt} volume={0.6} />
      <Sfx name="buzz" at={invAt + 4} volume={0.45} />
      <Sfx name="buzz" at={chaseAt + 4} volume={0.45} />
    </AbsoluteFill>
  );
}

/** A word that appears and is struck through by a rose bar, in three steps. */
function Struck({ word, at }: { word: string; at: number }) {
  const f = useCurrentFrame();
  const strike = stepIn(f, at + 4, 6, 3);
  return (
    <div style={{ position: "relative", ...pop(f, at) }}>
      <Display size={32} color={strike >= 1 ? C.faint : C.dim} style={{ padding: "8px 4px" }}>
        {word}
      </Display>
      <div style={{ position: "absolute", left: -8, top: "50%", height: 8, marginTop: -4, width: strike ? `calc(${strike * 100}% + 16px)` : 0, background: C.rose }} />
    </div>
  );
}
