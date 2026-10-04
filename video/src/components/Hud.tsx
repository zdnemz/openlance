import { useCurrentFrame } from "remotion";
import { useLayout } from "../layout";
import { countTo, stepIn } from "../motion";
import { Avatar, Badge } from "../pixel";
import { abs, cue, scene } from "../timeline";
import { C, F, FRAME } from "../theme";

export const MARA = "0x1d3405fddba96d3e0b1747a6794f36f1b625910b";
export const DARIO = "0x1cda3a78294a4bee2e172ded83611158d43608f6";

/**
 * The arcade HUD: 1UP the client, 2UP the freelancer, and the milestone's
 * value under escrow between them. It reads the same cues the scenes animate
 * on, so the numbers move exactly when the story says they do.
 */
export function Hud() {
  const f = useCurrentFrame();
  const L = useLayout();
  const enter = scene("fund").from;
  const exit = scene("finale").from;
  if (f < enter || f >= exit) return null;

  const coinAt = abs("fund", cue("fund", "coin")) + 10;
  const lockAt = abs("fund", cue("fund", "locks"));
  const chainAt = abs("submit", cue("submit", "on-chain"));
  const payAt = abs("release", cue("release", "payout"));
  const bossAt = scene("boss").from;
  const ruleAt = abs("boss", cue("boss", "hours"));

  const m2 = f >= bossAt;
  const value = m2 ? (f >= ruleAt ? countTo(f, ruleAt, 0.18, 0) : 0.18) : f >= payAt ? countTo(f, payAt, 0.24, 0) : countTo(f, coinAt, 0, 0.24);
  const state = m2
    ? f >= ruleAt
      ? { label: "split", color: C.split }
      : { label: "disputed", color: C.disputed }
    : f >= payAt
      ? { label: "released", color: C.released }
      : f >= chainAt
        ? { label: "submitted", color: C.submitted }
        : f >= lockAt
          ? { label: "funded", color: C.funded }
          : { label: "pending", color: C.pending };
  const earned = countTo(f, payAt, 0, 0.234) + (f >= ruleAt ? countTo(f, ruleAt, 0, 0.088) : 0);

  // drops in from above in three whole steps
  const drop = (1 - stepIn(f, enter, 6, 3)) * -(L.hud.h + L.hud.top);
  const s = L.tall ? 0.8 : 1;
  const av = L.tall ? 70 : 80;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: L.hud.top,
        height: L.hud.h,
        transform: `translateY(${drop}px)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${L.hud.pad}px`,
        background: C.ink,
        borderTop: L.tall ? `${FRAME}px solid ${C.lineStrong}` : undefined,
        borderBottom: `${FRAME}px solid ${C.lineStrong}`,
      }}
    >
      <Player tag="1UP" name="MARA" role="client" address={MARA} color={C.roseLight} size={av} scale={s} />
      <div style={{ display: "flex", alignItems: "center", gap: 24 * s }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.display, fontSize: 16 * s, color: C.faint }}>{m2 ? "MILESTONE 2" : "MILESTONE 1"}</div>
          <div style={{ fontFamily: F.display, fontSize: 40 * s, color: state.color, marginTop: 10 * s }}>
            {value.toFixed(3)}
            <span style={{ fontSize: 16 * s, color: C.faint }}> ETH</span>
          </div>
        </div>
        {!L.tall && <Badge label={state.label} color={state.color} size={16} />}
      </div>
      <Player tag="2UP" name="DARIO" role={`+${earned.toFixed(3)}`} address={DARIO} color={C.fg} size={av} scale={s} flip />
    </div>
  );
}

function Player({
  tag,
  name,
  role,
  address,
  color,
  size,
  scale,
  flip,
}: {
  tag: string;
  name: string;
  role: string;
  address: string;
  color: string;
  size: number;
  scale: number;
  flip?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 * scale, flexDirection: flip ? "row-reverse" : "row" }}>
      <Avatar address={address} size={size} />
      <div style={{ textAlign: flip ? "right" : "left" }}>
        <div style={{ fontFamily: F.display, fontSize: 24 * scale, color }}>{tag}</div>
        <div style={{ fontFamily: F.body, fontSize: 28 * scale, color: C.dim, marginTop: 8 * scale, whiteSpace: "nowrap" }}>
          {name} <span style={{ fontFamily: flip ? F.mono : F.body, fontSize: 24 * scale, color: C.faint }}>· {role}</span>
        </div>
      </div>
    </div>
  );
}
