#!/usr/bin/env node
/**
 * Contact sheet for review: bundles once, renders the given frames of both
 * compositions, and tiles them into out/stills/sheet-<comp>.png (needs ffmpeg).
 *   node scripts/stills.mjs 200 300 420
 */
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out", "stills");
mkdirSync(OUT, { recursive: true });
const frames = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const only = process.argv.find((a) => a.startsWith("--comp="))?.slice(7);
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE ?? null;

const serveUrl = await bundle({ entryPoint: join(ROOT, "src", "index.ts") });
for (const id of ["Promo", "PromoVertical"].filter((c) => !only || c === only)) {
  const composition = await selectComposition({ serveUrl, id, browserExecutable });
  const files = [];
  for (const frame of frames.filter((f) => f < composition.durationInFrames)) {
    const output = join(OUT, `${id}-${String(frame).padStart(4, "0")}.png`);
    await renderStill({ serveUrl, composition, frame, output, browserExecutable, scale: 0.5 });
    files.push(output);
  }
  const cols = id === "Promo" ? 3 : 5;
  const rows = Math.ceil(files.length / cols);
  execFileSync("ffmpeg", ["-y", "-v", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
    `${files.map((_, i) => `[${i}]pad=iw+8:ih+8:4:4:color=0x43434f[p${i}]`).join(";")};${files.map((_, i) => `[p${i}]`).join("")}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => "w0").join("+") : 0}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => "h0").join("+") : 0}`).join("|")}:fill=black`,
    join(OUT, `sheet-${id}.png`)]);
  console.log(`${id}: ${files.length} frames → out/stills/sheet-${id}.png (${cols}x${rows})`);
}
