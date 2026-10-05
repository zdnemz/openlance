import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sfx } from "../components/Sfx";
import { StageLayout } from "../components/Stage";
import { useLayout } from "../layout";
import { pop, popScale } from "../motion";
import { Display, PixelButton, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F } from "../theme";

/**
 * Power-up: gasless actions. Honest about the line the product draws: the
 * relayer sponsors state changes, never value (funding stays user-paid).
 */
export function Power() {
  const f = useCurrentFrame();
  const L = useLayout();
  const powerAt = cue("power", "power-up");
  const gasAt = cue("power", "gas");
  const actions = [
    { label: "Submit", at: cue("power", "submit") },
    { label: "Approve", at: cue("power", "approve") },
    { label: "Vote", at: cue("power", "vote") },
  ];
  // the star is on stage as the wipe clears; its sting stays on the voice
  const starAt = 2;

  return (
    <AbsoluteFill>
      <StageLayout
        title={
          <>
            <div style={popScale(f, starAt)}>
              <Sprite name="star" size={L.tall ? 128 : 192} />
            </div>
            <Display size={L.tall ? 64 : 80} color={C.roseLight} style={popScale(f, powerAt)}>
              Power-up!
            </Display>
            <Display size={28} color={C.faint} style={pop(f, powerAt + 4)}>
              Gasless moves
            </Display>
          </>
        }
      >
        <div style={{ position: "absolute", left: 40, right: 40, top: L.tall ? 16 : 96, display: "flex", flexDirection: "column", gap: 28 }}>
          {actions.map((a, i) => {
            const pressed = f >= a.at && f < a.at + 6;
            const used = f >= a.at;
            return (
              <div key={a.label} style={{ display: "flex", alignItems: "center", gap: 36, ...pop(f, powerAt + 2 + i * 3) }}>
                <div style={{ width: 340 }}>
                  <PixelButton pressed={pressed} size={28}>
                    {a.label}
                  </PixelButton>
                </div>
                <div>
                  <div style={{ fontFamily: F.mono, fontSize: 28, color: used ? C.fg : C.faint }}>gas 0.000 ETH</div>
                  <div style={{ fontFamily: F.display, fontSize: 16, color: C.roseLight, marginTop: 12, opacity: used ? 1 : 0 }}>SPONSORED</div>
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 20, ...pop(f, gasAt) }}>
            <Sprite name="gas" size={96} />
            <div>
              <Display size={40}>
                Gas is <span style={{ color: C.roseLight }}>on us</span>
              </Display>
              <div style={{ fontFamily: F.mono, fontSize: 22, color: C.faint, marginTop: 14 }}>state is sponsored · funding pays its own gas</div>
            </div>
          </div>
        </div>
      </StageLayout>
      <Sfx name="powerup" at={Math.max(0, powerAt - 4)} volume={0.5} />
      {actions.map((a) => (
        <Sfx key={a.label} name="click" at={a.at} volume={0.4} />
      ))}
      <Sfx name="coin" at={gasAt} volume={0.25} />
    </AbsoluteFill>
  );
}
