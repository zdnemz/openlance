/**
 * The app's motion vocabulary, frame-accurate: everything moves in whole-pixel
 * steps (DESIGN.md: steps() easing, pixel-pop, blink; no springs, no eased
 * tweens). Positions snap to the 8px grid and animation runs on twos.
 */
export const PX = 8;

export const snap = (v: number, unit = PX) => Math.round(v / unit) * unit;

/** Animate on twos: hold every drawing for two frames, like hand-timed sprite work. */
export const twos = (frame: number) => frame - (((frame % 2) + 2) % 2);

/** 0 → 1 in `steps` whole jumps over [start, start + dur). */
export function stepIn(frame: number, start: number, dur: number, steps = 4) {
  const p = (frame - start) / dur;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return Math.ceil(p * steps) / steps;
}

/** The app's 4-frame pixel-pop, at 2x: hidden, 16px low, 8px low, home. */
export function pop(frame: number, at: number) {
  const f = frame - at;
  if (f < 0) return { opacity: 0, transform: "translateY(16px)" };
  if (f < 2) return { opacity: 1, transform: "translateY(16px)" };
  if (f < 4) return { opacity: 1, transform: "translateY(8px)" };
  return { opacity: 1, transform: "none" };
}

/** A bigger entrance for hero sprites and titles: undershoot, overshoot, settle, in whole frames. */
export function popScale(frame: number, at: number) {
  const f = frame - at;
  const s = f < 0 ? 0 : f < 2 ? 0.5 : f < 4 ? 1.125 : 1;
  return { opacity: f < 0 ? 0 : 1, transform: `scale(${s})` };
}

/** The app's blink: full, then a quarter, in two steps. */
export const blink = (frame: number, period = 30) => (((frame % period) + period) % period < period / 2 ? 1 : 0.25);

/** Hard on/off blink for PRESS START style prompts. */
export const flash = (frame: number, period = 24) => ((((frame % period) + period) % period) < period / 2 ? 1 : 0);

/** A short hit-shake: ±8px for `frames` frames after `at`. */
export function shake(frame: number, at: number, frames = 6) {
  const f = frame - at;
  if (f < 0 || f >= frames) return 0;
  return f % 2 === 0 ? PX : -PX;
}

/** Count a number up or down in `steps` jumps (money moves in steps, not tweens). */
export function countTo(frame: number, at: number, from: number, to: number, dur = 12, steps = 6) {
  return from + (to - from) * stepIn(frame, at, dur, steps);
}

/** Deterministic 0..1 hash, for block-wipe orders and burst angles. */
export function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
