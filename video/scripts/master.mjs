#!/usr/bin/env node
/**
 * Master the rendered films for web and social: two-pass EBU R128 loudnorm to
 * -14 LUFS integrated, -1.5 dBTP, video stream copied untouched. Remotion
 * caps a track's volume at 1, so the mix is built ~3 dB under target with
 * headroom and lifted here. Needs ffmpeg on the PATH.
 *   node scripts/master.mjs [out/a.mp4 …]   (default: both cuts)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = { I: -14, TP: -1.5, LRA: 11 };
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["out/openlance-promo.mp4", "out/openlance-promo-vertical.mp4"].map((f) => join(ROOT, f)).filter(existsSync);

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.error("master: ffmpeg not found on PATH; the renders are left unmastered (about -17 LUFS)");
  process.exit(0);
}

for (const file of files) {
  const filter = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}`;
  const probe = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `${filter}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
  const m = JSON.parse(probe.stderr.slice(probe.stderr.lastIndexOf("{")));
  const measured = `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const tmp = file.replace(/\.mp4$/, ".mastering.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-c:v", "copy", "-af", `${filter}:${measured},aresample=48000`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
  renameSync(tmp, file);
  console.log(`master ${file.replace(ROOT + "/", "")}: ${m.input_i} LUFS → ${TARGET.I} LUFS`);
}
