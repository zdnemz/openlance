import { Audio, Sequence, staticFile } from "remotion";
import { FPS, SFX } from "../timeline";

/**
 * One sound effect at a scene-relative frame. Renders nothing until
 * scripts/audio.mjs has made it. `cut` stops the sound after that many frames
 * with a `fade`-frame ramp, for generated files that swell or end at full level.
 */
export function Sfx({ name, at, volume = 0.6, cut, fade = 6 }: { name: string; at: number; volume?: number; cut?: number; fade?: number }) {
  const s = SFX[name];
  if (!s?.file) return null;
  const length = Math.ceil(s.duration * FPS) + 2;
  const end = cut === undefined ? length : Math.min(length, cut + fade);
  return (
    <Sequence from={at} durationInFrames={end} layout="none">
      <Audio src={staticFile(s.file)} volume={(f) => (cut === undefined || f < cut ? volume : volume * Math.max(0, (cut + fade - f) / fade))} />
    </Sequence>
  );
}
