#!/usr/bin/env node
/**
 * Master the rendered films for web and social: one static gain to -14 LUFS
 * integrated plus a brick-wall limiter at -2.5 dBFS so the AAC encode stays
 * under -1.5 dBTP, video stream copied untouched. A static gain keeps the
 * mix's balance (bed and SFX under the voice) exactly as built; loudnorm's
 * dynamic mode would ride it. Remotion caps a track's volume at 1, so the mix
 * is built about 3 dB under target and lifted here. Needs ffmpeg on the PATH.
 *   node scripts/master.mjs [out/a.mp4 …]   (default: both cuts)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_I = -14;
const MAX_TP = -1.5;
const LIMIT = 10 ** (-2.5 / 20);

const args = process.argv.slice(2);
const files = args.length ? args : ["out/openlance-promo.mp4", "out/openlance-promo-vertical.mp4"].map((f) => join(ROOT, f));

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.error("master: ffmpeg not found on PATH; the renders are left unmastered (about -17 LUFS)");
  process.exit(0);
}

/** Integrated loudness and true peak of a file's audio (after an optional filter chain). */
function measure(file, pre = "") {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `${pre ? pre + "," : ""}ebur128=peak=true`, "-f", "null", "-"], { encoding: "utf8" });
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const I = summary.match(/I:\s+(-?[\d.]+) LUFS/);
  const TP = summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/);
  if (r.status !== 0 || !I) throw new Error(`can't measure ${file}: ${r.stderr.split("\n").filter(Boolean).at(-1)}`);
  return { I: +I[1], TP: TP ? +TP[1] : -Infinity };
}

const chain = (gain) => `volume=${gain.toFixed(2)}dB,alimiter=limit=${LIMIT.toFixed(4)}:attack=2:release=60:level=false`;

let failed = 0;
for (const file of files) {
  const name = file.replace(ROOT + "/", "");
  try {
    if (!existsSync(file)) throw new Error("not found");
    const audio = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { encoding: "utf8" });
    if (!audio.stdout.trim()) {
      console.log(`master ${name}: no audio track, skipped`);
      continue;
    }
    const before = measure(file);
    // the limiter shaves a little loudness off; measure through it and correct once
    let gain = TARGET_I - before.I;
    gain += TARGET_I - measure(file, chain(gain)).I;
    const tmp = file.replace(/\.mp4$/, ".mastering.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-c:v", "copy", "-af", `${chain(gain)},aresample=48000`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
    const after = measure(tmp);
    renameSync(tmp, file);
    const ok = Math.abs(after.I - TARGET_I) <= 0.5 && after.TP <= MAX_TP;
    console.log(`master ${name}: ${before.I} LUFS → ${after.I} LUFS, true peak ${after.TP} dBTP (gain ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB)${ok ? "" : "  ⚠ outside target"}`);
    if (!ok) failed++;
  } catch (e) {
    console.error(`master ${name}: ${e.message}`);
    failed++;
  }
}
if (failed) process.exitCode = 1;
