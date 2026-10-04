/**
 * The edit, derived from the audio: each scene is sized around its voiceover
 * line (src/audio-manifest.json, written by scripts/audio.mjs), so re-running
 * the TTS re-times the film. Before audio exists the manifest holds estimates.
 */
import manifest from "./audio-manifest.json";

export const FPS = 30;

export type SceneId = "attract" | "fund" | "submit" | "release" | "boss" | "power" | "finale";

export type Word = { text: string; start: number; end: number; emphasis: boolean };
export type Line = { file: string | null; duration: number; caption: string; words: Word[] };
export type Sound = { file: string | null; duration: number };

/** pre: beat before the voice starts · post: hold after it ends · min: floor for the animation (seconds). */
const SPECS: { id: SceneId; pre: number; post: number; min: number }[] = [
  { id: "attract", pre: 1.4, post: 0.6, min: 7 },
  { id: "fund", pre: 0.5, post: 0.6, min: 6.5 },
  { id: "submit", pre: 0.5, post: 0.8, min: 5.5 },
  { id: "release", pre: 0.4, post: 1.0, min: 5 },
  { id: "boss", pre: 1.0, post: 0.8, min: 7.5 },
  { id: "power", pre: 0.6, post: 0.8, min: 5 },
  { id: "finale", pre: 0.5, post: 3.2, min: 7 },
];

export type Scene = {
  id: SceneId;
  /** first frame of the scene in the film */
  from: number;
  durationInFrames: number;
  /** frame, relative to the scene, where the voice line starts */
  voFrom: number;
  line: Line;
};

const lines = manifest.lines as Record<SceneId, Line>;
export const SFX = manifest.sfx as Record<string, Sound>;
export const BEDS = manifest.beds as Record<string, Sound>;

const sec = (s: number) => Math.round(s * FPS);

export const SCENES: Scene[] = (() => {
  let from = 0;
  return SPECS.map(({ id, pre, post, min }) => {
    const line = lines[id];
    const durationInFrames = sec(Math.max(min, pre + line.duration + post));
    const scene = { id, from, durationInFrames, voFrom: sec(pre), line };
    from += durationInFrames;
    return scene;
  });
})();

export const TOTAL_FRAMES = SCENES.reduce((a, s) => a + s.durationInFrames, 0);

export const scene = (id: SceneId) => SCENES.find((s) => s.id === id)!;

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Scene-relative frame where `word` is spoken (the nth time). Animation hangs
 * off these cues, so visuals land on the voice whatever the read's pacing.
 */
export function cue(id: SceneId, word: string, nth = 0): number {
  const s = scene(id);
  const hits = s.line.words.filter((w) => norm(w.text) === norm(word));
  const w = hits[nth];
  if (!w) throw new Error(`cue: "${word}" (#${nth}) is not in the ${id} line`);
  return s.voFrom + sec(w.start);
}

/** Scene-relative frame where the voice line ends. */
export const voEnd = (id: SceneId) => scene(id).voFrom + sec(scene(id).line.duration);

/** Film-absolute frame for a scene-relative one. */
export const abs = (id: SceneId, f: number) => scene(id).from + f;
