import { Audio, Sequence, staticFile } from "remotion";
import { FPS, SFX } from "../timeline";

/** One sound effect at a scene-relative frame. Renders nothing until scripts/audio.mjs has made it. */
export function Sfx({ name, at, volume = 0.6 }: { name: string; at: number; volume?: number }) {
  const s = SFX[name];
  if (!s?.file) return null;
  return (
    <Sequence from={at} durationInFrames={Math.ceil(s.duration * FPS) + 2} layout="none">
      <Audio src={staticFile(s.file)} volume={volume} />
    </Sequence>
  );
}
