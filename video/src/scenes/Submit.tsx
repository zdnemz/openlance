import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sfx } from "../components/Sfx";
import { StageLayout, StageTitle } from "../components/Stage";
import { snap, stepIn, twos } from "../motion";
import { Badge, Panel, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F, FRAME } from "../theme";

// the submit's own tx (the fund tx is 0x7f3a…c21e), truncated the way the app's HashText shows it
const HASH = "0x9b2e…41d7";

/** Stage 2: the delivery goes on-chain through the app's three honest phases. */
export function Submit() {
  const f = useCurrentFrame();
  const shipAt = cue("submit", "ship");
  const workAt = cue("submit", "work");
  const submitAt = cue("submit", "submit");
  const proofAt = cue("submit", "proof");
  const chainAt = cue("submit", "on-chain");

  const phases = [
    { label: "Signing", from: shipAt, done: workAt + 6 },
    { label: "Mining", from: workAt + 6, done: proofAt + 4 },
    { label: "Mirroring", from: proofAt + 4, done: chainAt },
  ];
  const submitted = f >= chainAt;
  const flyIn = snap((1 - stepIn(twos(f), shipAt, 8, 4)) * 1000);
  const typed = Math.round(stepIn(f, submitAt, 14, 7) * HASH.length);

  return (
    <AbsoluteFill>
      <StageLayout title={<StageTitle stage="Stage 2" verb="Submit" chip="submit(milestone 1) · proof" chipAt={submitAt} />}>
        <div style={{ position: "absolute", left: 40, right: 40, top: 48 }}>
          <Panel style={{ padding: 40 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <div style={{ transform: `translateX(${flyIn}px)`, opacity: f < shipAt ? 0 : 1 }}>
                <Sprite name="scroll" size={96} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: F.display, fontSize: 28, color: C.fg }}>DELIVERY</div>
                <div style={{ fontFamily: F.body, fontSize: 28, color: C.faint, marginTop: 10 }}>milestone 1</div>
              </div>
              <Badge label={submitted ? "submitted" : "funded"} color={submitted ? C.submitted : C.funded} size={20} />
            </div>
            <div style={{ marginTop: 32, borderTop: `${FRAME}px dashed ${C.line}` }}>
              {phases.map((p) => {
                const state = f >= p.done ? "done" : f >= p.from ? "active" : "idle";
                return (
                  <div
                    key={p.label}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 68, borderBottom: `${FRAME}px dashed ${C.line}` }}
                  >
                    <span style={{ fontFamily: F.display, fontSize: 24, color: state === "idle" ? C.faint : C.fg, textTransform: "uppercase" }}>{p.label}</span>
                    {state === "done" ? (
                      <span style={{ fontFamily: F.display, fontSize: 24, color: C.fg }}>OK</span>
                    ) : state === "active" ? (
                      <Spinner frame={f} />
                    ) : (
                      <span style={{ fontFamily: F.display, fontSize: 24, color: C.faint }}>--</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: F.mono, fontSize: 26, color: C.faint, marginTop: 28, whiteSpace: "pre" }}>
              tx <span style={{ color: C.dim }}>{HASH.slice(0, typed)}</span>
              {submitted ? " · mirrored" : ""}
            </div>
          </Panel>
        </div>
      </StageLayout>
      <Sfx name="pop" at={0} volume={0.4} />
      <Sfx name="whoosh" at={shipAt} volume={0.5} />
      {/* the clatter stops with the type-on (14 frames), not 30 frames later under "the proof" */}
      <Sfx name="type" at={submitAt} volume={0.2} cut={16} fade={4} />
      <Sfx name="select" at={phases[0]!.done} volume={0.35} />
      <Sfx name="select" at={phases[1]!.done} volume={0.35} />
      <Sfx name="confirm" at={chainAt} volume={0.35} />
    </AbsoluteFill>
  );
}

/** The app's 8-step spinner: one lit cell walks the ring of a 3x3 grid. */
function Spinner({ frame }: { frame: number }) {
  const ring = [0, 1, 2, 5, 8, 7, 6, 3];
  const lit = ring[Math.floor(frame / 3) % 8];
  return (
    <span style={{ display: "grid", gridTemplateColumns: "repeat(3, 12px)", gap: 4 }}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} style={{ width: 12, height: 12, background: i === lit ? C.roseLight : i === 4 ? "transparent" : C.lineStrong }} />
      ))}
    </span>
  );
}
