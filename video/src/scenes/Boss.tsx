import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Sfx } from "../components/Sfx";
import { useLayout } from "../layout";
import { flash, pop, popScale, shake, snap, stepIn, twos } from "../motion";
import { Avatar, Badge, Display, Panel, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F } from "../theme";

const ARBITERS = [
  { address: "0x1cac1b6a7fb39bd8594fda1c5723589544081821", vote: "split" },
  { address: "0x1cf43d292d9edbae1e3c3e9dbf6b929f8070dc2f", vote: "split" },
  { address: "0x1c38c0ba8ccab1af9b53bf09d83f073a691daaa8", vote: "release" },
] as const;

const OUTCOMES = [
  { label: "release", color: C.released },
  { label: "refund", color: C.refund },
  { label: "split", color: C.split },
] as const;

// diagonal hazard stripes drawn in whole 8px cells, so the edge is a pixel staircase
const HAZARD = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' shape-rendering='crispEdges'>${Array.from({ length: 64 }, (_, i) => {
    const x = i % 8;
    const y = Math.floor(i / 8);
    return (x + y) % 8 < 4 ? `<rect x='${x * 8}' y='${y * 8}' width='8' height='8' fill='${C.disputed}'/>` : "";
  }).join("")}</svg>`,
)}")`;

/** The boss fight: a dispute. Staked arbiters vote; the majority rules inside the 72h SLA. */
export function Boss() {
  const f = useCurrentFrame();
  const L = useLayout();
  const bossAt = cue("boss", "boss");
  const threeAt = cue("boss", "three");
  const votesAt = cue("boss", "inside");
  const sevAt = cue("boss", "seventy-two");
  const ruleAt = cue("boss", "hours");
  const outcomeAt = [cue("boss", "release"), cue("boss", "refund"), cue("boss", "split")];

  if (f < bossAt) return <Warning />;

  const swordIn = stepIn(twos(f), bossAt, 6, 3);
  const swordX = snap((1 - swordIn) * 480);
  const swordY = snap(-(1 - swordIn) * 480);
  const hit = shake(f, bossAt + 6, 8);

  // the SLA clock runs fast once it is named
  const left = 72 * 3600 - Math.max(0, f - sevAt) * 97;
  const clock = [Math.floor(left / 3600), Math.floor((left % 3600) / 60), left % 60].map((n) => String(n).padStart(2, "0")).join(":");

  return (
    <AbsoluteFill style={{ transform: `translateX(${hit}px)` }}>
      <div
        style={{
          position: "absolute",
          top: L.stage.top + (L.tall ? 24 : 8),
          bottom: L.H - L.stage.bottom,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: L.tall ? 48 : 40,
        }}
      >
        <div style={{ display: "flex", flexDirection: L.tall ? "column" : "row", alignItems: "center", gap: L.tall ? 28 : 40 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ transform: `translate(${swordX}px, ${swordY}px)` }}>
              <Sprite name="sword" size={L.tall ? 112 : 96} />
            </div>
            <Display size={L.tall ? 64 : 72} style={popScale(f, bossAt)}>
              Boss fight
            </Display>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 32, ...pop(f, bossAt + 4) }}>
            <Badge label="dispute" color={C.disputed} size={24} />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Sprite name="hourglass" size={64} />
              <span style={{ fontFamily: F.display, fontSize: 32, color: f >= sevAt ? C.disputed : C.fg }}>{clock}</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: L.tall ? 24 : 48 }}>
          {ARBITERS.map((a, i) => {
            const vote = OUTCOMES.find((o) => o.label === a.vote)!;
            return (
              <div key={a.address} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, ...pop(f, threeAt + i * 4) }}>
                <div style={{ height: 52, ...pop(f, votesAt + i * 5) }}>
                  <Badge label={vote.label} color={vote.color} size={18} />
                </div>
                <Panel style={{ width: L.tall ? 300 : 300, padding: "28px 20px", position: "relative" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
                    <Avatar address={a.address} size={L.tall ? 120 : 120} />
                    <Display size={20}>Arbiter {i + 1}</Display>
                    <div style={{ fontFamily: F.mono, fontSize: 22, color: C.faint }}>staked · SBT</div>
                  </div>
                  <div style={{ position: "absolute", top: -24, right: -24 }}>
                    <Sprite name="shield" size={64} />
                  </div>
                </Panel>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: L.tall ? 20 : 40 }}>
          {OUTCOMES.map((o, i) => {
            const lit = f >= outcomeAt[i]!;
            const ruled = f >= ruleAt;
            const won = ruled && o.label === "split";
            const color = !lit || (ruled && !won) ? C.lineStrong : o.color;
            return (
              <div
                key={o.label}
                style={{
                  ...popScale(f, outcomeAt[i]!),
                  fontFamily: F.display,
                  fontSize: L.tall ? 26 : 28,
                  textTransform: "uppercase",
                  padding: "20px 28px",
                  border: `4px solid ${color}`,
                  background: won ? o.color : C.ink,
                  color: won ? C.ink : lit && !ruled ? o.color : C.faint,
                  boxShadow: won ? `8px 8px 0 0 #000` : undefined,
                }}
              >
                {o.label}
              </div>
            );
          })}
        </div>
      </div>
      <Sfx name="clang" at={bossAt + 6} volume={0.7} />
      {ARBITERS.map((_, i) => (
        <Sfx key={i} name="select" at={threeAt + i * 4} volume={0.35} />
      ))}
      {outcomeAt.map((at, i) => (
        <Sfx key={i} name="pop" at={at} volume={0.4} />
      ))}
      <Sfx name="tick" at={sevAt} volume={0.4} />
      <Sfx name="confirm" at={ruleAt} volume={0.6} />
    </AbsoluteFill>
  );
}

/** WARNING: the arcade's boss-incoming banner, flashing on hazard stripes. */
function Warning() {
  const f = useCurrentFrame();
  const L = useLayout();
  const on = flash(f, 12);
  const band = L.tall ? 360 : 320;
  return (
    <AbsoluteFill style={{ justifyContent: "center" }}>
      <div style={{ height: band, display: "flex", flexDirection: "column", opacity: on ? 1 : 0.35 }}>
        <div style={{ height: 48, backgroundImage: HAZARD }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28, background: C.ink }}>
          <Display size={L.tall ? 88 : 104} color={C.disputed}>
            Warning
          </Display>
          <Display size={L.tall ? 24 : 28} color={C.fg}>
            Dispute approaching
          </Display>
        </div>
        <div style={{ height: 48, backgroundImage: HAZARD }} />
      </div>
      <Sfx name="alarm" at={0} volume={0.55} />
    </AbsoluteFill>
  );
}
