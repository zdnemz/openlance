import type { FC } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Backdrop } from "./components/Backdrop";
import { DialogBox } from "./components/DialogBox";
import { Hud } from "./components/Hud";
import { PixelWipe } from "./components/PixelWipe";
import { Sfx } from "./components/Sfx";
import { Attract } from "./scenes/Attract";
import { Boss } from "./scenes/Boss";
import { Finale } from "./scenes/Finale";
import { Fund } from "./scenes/Fund";
import { Power } from "./scenes/Power";
import { Release } from "./scenes/Release";
import { Submit } from "./scenes/Submit";
import { BEDS, FPS, SCENES, TOTAL_FRAMES, scene, type SceneId } from "./timeline";

const SCENE_COMPONENTS: Record<SceneId, FC> = {
  attract: Attract,
  fund: Fund,
  submit: Submit,
  release: Release,
  boss: Boss,
  power: Power,
  finale: Finale,
};

/** Voice windows in film frames, for ducking the bed under the announcer. */
const VO = SCENES.filter((s) => s.line.file).map((s) => [s.from + s.voFrom, s.from + s.voFrom + Math.round(s.line.duration * FPS)] as const);
const RAMP = 6;

function duck(frame: number) {
  let d = 0;
  for (const [a, b] of VO) d = Math.max(d, Math.min(1, (frame - (a - RAMP)) / RAMP, (b + RAMP - frame) / RAMP));
  return Math.max(0, d);
}

/** Bed gain at a film frame: ducked to half under the voice, faded out over the last 1.5s. */
const bedGain = (frame: number, base: number) => {
  const tail = Math.min(1, (TOTAL_FRAMES - frame) / 45);
  return base * (1 - 0.5 * duck(frame)) * Math.max(0, tail);
};

function Bed({ name, from, to, base = 0.55 }: { name: string; from: number; to: number; base?: number }) {
  const bed = BEDS[name];
  if (!bed?.file) return null;
  return (
    <Sequence from={from} durationInFrames={to - from} layout="none">
      <Audio src={staticFile(bed.file)} loop volume={(f) => bedGain(from + f, base)} />
    </Sequence>
  );
}

/** The film. Same edit for 16:9 and 9:16; every component lays itself out for the frame it is in. */
export function Promo() {
  const boss = scene("boss");
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Backdrop />
      {SCENES.map((s) => {
        const Scene = SCENE_COMPONENTS[s.id];
        return (
          <Sequence key={s.id} name={s.id} from={s.from} durationInFrames={s.durationInFrames}>
            <Scene />
            {s.line.file && (
              <Sequence from={s.voFrom} layout="none" name={`vo:${s.id}`}>
                <Audio src={staticFile(s.line.file)} />
              </Sequence>
            )}
          </Sequence>
        );
      })}
      <Hud />
      <DialogBox />
      <PixelWipe />
      {SCENES.slice(1).map((s) => (
        <Sfx key={s.id} name="whoosh" at={s.from - 6} volume={0.3} />
      ))}
      {/* stage theme until the boss arrives, the boss loop for the fight, then the stage theme again */}
      <Bed name="main" from={6} to={boss.from} />
      <Bed name="boss" from={boss.from} to={boss.from + boss.durationInFrames} />
      <Bed name="main" from={boss.from + boss.durationInFrames} to={TOTAL_FRAMES} />
    </AbsoluteFill>
  );
}
