import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Crt } from "../components/Stage";
import { DARIO, MARA } from "../components/Hud";
import { Sfx } from "../components/Sfx";
import { useLayout } from "../layout";
import { flash, pop, popScale, shake, snap, stepIn, twos } from "../motion";
import { Avatar, Display, Panel, Sprite } from "../pixel";
import { cue } from "../timeline";
import { C, F, FRAME } from "../theme";

/** Attract mode, then SELECT PLAYER: two players, one question. */
export function Attract() {
  const f = useCurrentFrame();
  const oneAt = cue("attract", "one");
  const clientAt = cue("attract", "client");
  const twoAt = cue("attract", "two");
  const freeAt = cue("attract", "freelancer");
  const qAt = cue("attract", "question");
  const trustAt = cue("attract", "trust");

  return (
    <AbsoluteFill>
      {f < oneAt ? <Boot /> : <Select {...{ oneAt, clientAt, twoAt, freeAt, qAt, trustAt }} />}
      <Crt mode="on" at={0} />
      <Sfx name="boot" at={2} volume={0.55} />
      <Sfx name="whoosh" at={oneAt} volume={0.4} />
      <Sfx name="whoosh" at={twoAt} volume={0.4} />
      <Sfx name="select" at={clientAt} volume={0.35} />
      <Sfx name="select" at={freeAt} volume={0.35} />
      <Sfx name="pop" at={qAt} />
      <Sfx name="buzz" at={trustAt} volume={0.4} />
    </AbsoluteFill>
  );
}

function Boot() {
  const f = useCurrentFrame();
  const L = useLayout();
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 48 }}>
      <Sprite name="mark" size={L.tall ? 256 : 192} />
      <Display size={L.tall ? 80 : 72}>OpenLance</Display>
      <Display size={32} color={C.roseLight} style={{ opacity: f < 12 ? 0 : flash(f, 16) }}>
        Press start
      </Display>
      <Display size={20} color={C.faint} style={{ position: "absolute", bottom: L.tall ? 640 : 232, right: L.tall ? undefined : 64 }}>
        Credit 00
      </Display>
    </AbsoluteFill>
  );
}

type Cues = { oneAt: number; clientAt: number; twoAt: number; freeAt: number; qAt: number; trustAt: number };

function Select({ oneAt, clientAt, twoAt, freeAt, qAt, trustAt }: Cues) {
  const f = useCurrentFrame();
  const L = useLayout();
  const t = twos(f);
  const cardW = L.tall ? 440 : 520;
  const in1 = snap(-(1 - stepIn(t, oneAt, 8, 4)) * 1200);
  const in2 = snap((1 - stepIn(t, twoAt, 8, 4)) * 1200);
  const qShake = shake(f, trustAt, 8);

  const cards = (
    <>
      <div style={{ transform: `translateX(${in1}px)` }}>
        <PlayerCard tag="P1" role="Client" name="Mara" address={MARA} color={C.roseLight} selected={f >= clientAt} width={cardW} />
      </div>
      {!L.tall && <Question at={qAt} dx={qShake} />}
      <div style={{ transform: `translateX(${in2}px)`, opacity: f < twoAt ? 0 : 1 }}>
        <PlayerCard tag="P2" role="Freelancer" name="Dario" address={DARIO} color={C.fg} selected={f >= freeAt} width={cardW} />
      </div>
    </>
  );

  return (
    <AbsoluteFill style={{ alignItems: "center" }}>
      <Display size={L.tall ? 40 : 40} color={C.faint} style={{ marginTop: L.tall ? 200 : 96 }}>
        Select player
      </Display>
      {/* the dashed tether between the two players, drawn in four steps */}
      {!L.tall && f >= qAt && (
        <div
          style={{
            position: "absolute",
            top: 480,
            left: 960 - 460 * stepIn(f, qAt, 8, 4),
            width: 920 * stepIn(f, qAt, 8, 4),
            borderTop: `${FRAME}px dashed ${C.lineStrong}`,
          }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: L.tall ? 40 : 96, marginTop: L.tall ? 64 : 72 }}>{cards}</div>
      {L.tall && <Question at={qAt} dx={qShake} />}
    </AbsoluteFill>
  );
}

function Question({ at, dx }: { at: number; dx: number }) {
  const f = useCurrentFrame();
  const L = useLayout();
  return (
    <div style={{ ...popScale(f, at), display: "flex", flexDirection: "column", alignItems: "center", gap: 24, marginTop: L.tall ? 72 : 0, translate: `${dx}px 0` }}>
      <Display size={L.tall ? 200 : 176} color={C.rose} style={{ lineHeight: 1, background: C.ink, padding: "8px 16px" }}>
        ?
      </Display>
      <Display size={24} color={C.roseLight} style={{ background: C.ink, padding: "4px 8px" }}>
        Trust?
      </Display>
    </div>
  );
}

function PlayerCard({
  tag,
  role,
  name,
  address,
  color,
  selected,
  width,
}: {
  tag: string;
  role: string;
  name: string;
  address: string;
  color: string;
  selected: boolean;
  width: number;
}) {
  const f = useCurrentFrame();
  return (
    <Panel frame={selected ? color : C.lineStrong} slab={selected ? (color === C.roseLight ? C.roseDeep : C.lineStrong) : "#000"} style={{ width, padding: "40px 32px" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
        <Display size={40} color={color}>
          {tag}
        </Display>
        <Avatar address={address} size={200} frame={selected ? color : C.lineStrong} />
        <Display size={width < 500 ? 32 : 40} style={pop(f, 0)}>
          {role}
        </Display>
        <div style={{ fontFamily: F.body, fontSize: 36, color: C.dim, marginTop: -8 }}>{name}</div>
        <div style={{ fontFamily: F.mono, fontSize: 24, color: C.faint }}>
          {address.slice(0, 6)}…{address.slice(-4)}
        </div>
      </div>
    </Panel>
  );
}
