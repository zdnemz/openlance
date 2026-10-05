import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sfx } from "../components/Sfx";
import { INSTRUMENT_W, StageLayout, StageTitle } from "../components/Stage";
import { blink, countTo, pop, shake, snap, stepIn, twos } from "../motion";
import { Badge, Panel, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F, FRAME } from "../theme";

/** Stage 1: insert coin. The coin drops into the lock and the value is escrowed. */
export function Fund() {
  const f = useCurrentFrame();
  const insertAt = cue("fund", "insert");
  const dropAt = cue("fund", "coin");
  const landAt = dropAt + 8;
  const lockAt = cue("fund", "locks");
  const locked = f >= lockAt;

  // the coin pops in above the lock spinning (a stepped flip), then drops into the slot on "coin"
  const fall = stepIn(twos(f), dropAt, landAt - dropAt, 4);
  const coinY = snap(-48 + fall * fall * 144);
  const spin = f >= dropAt ? 1 : [1, 0.5, 0.125, 0.5][Math.floor(f / 3) % 4]!;
  const value = countTo(f, landAt, 0, 0.24);
  const state = locked ? { label: "funded", color: C.funded } : { label: "pending", color: C.pending };
  const lockSize = 144;

  return (
    <AbsoluteFill>
      <StageLayout title={<StageTitle stage="Stage 1" verb="Fund" chip="fund(milestone 1) · 0.240 ETH" chipAt={landAt} />}>
        {/* drawn under the lock, so the lock's body swallows the coin as it lands */}
        {f >= insertAt && f < landAt && (
          <div style={{ position: "absolute", left: (INSTRUMENT_W - 96) / 2, top: coinY, opacity: pop(f, insertAt).opacity, transform: `scaleX(${spin})` }}>
            <Sprite name="coin" size={96} />
          </div>
        )}
        <div style={{ position: "absolute", left: (INSTRUMENT_W - lockSize) / 2, top: 64, transform: `translateY(${locked ? 0 : -8}px)` }}>
          <Sprite name={locked ? "lock" : "lockOpen"} size={lockSize} />
        </div>
        <div style={{ position: "absolute", left: 40, right: 40, top: 240, transform: `translateX(${shake(f, lockAt)}px)` }}>
          <Panel accent style={{ padding: 40 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
              <span style={{ fontFamily: F.body, fontSize: 28, color: C.faint, textTransform: "uppercase" }}>milestone 1 · threat model</span>
              <Badge label={state.label} color={state.color} size={20} dot={locked ? blink(f, 20) : 1} />
            </div>
            <div style={{ fontFamily: F.body, fontSize: 32, color: C.dim, marginTop: 36 }}>value under escrow</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 20 }}>
              <span style={{ fontFamily: F.display, fontSize: 80, lineHeight: 1, color: C.funded }}>{value.toFixed(3)}</span>
              <span style={{ fontFamily: F.display, fontSize: 24, color: C.faint }}>ETH</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 32 }}>
              {[C.funded, C.submitted, C.released].map((c, i) => (
                <span key={c} style={{ height: 24, border: `${FRAME}px solid ${i === 0 && locked ? c : C.lineStrong}`, background: i === 0 && locked ? c : "transparent" }} />
              ))}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 24, color: C.faint, marginTop: 28 }}>
              {f >= landAt ? "tx 0x7f3a…c21e · fund()" : "awaiting fund()"}
            </div>
          </Panel>
        </div>
      </StageLayout>
      <Sfx name="pop" at={0} volume={0.4} />
      <Sfx name="coin" at={landAt - 3} volume={0.3} />
      <Sfx name="lock" at={lockAt} volume={0.3} />
    </AbsoluteFill>
  );
}
