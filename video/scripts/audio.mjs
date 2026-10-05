#!/usr/bin/env node
/**
 * ElevenLabs audio pipeline for the promo: voiceover (TTS with timestamps),
 * sound effects and the chiptune bed (both from sound generation), then
 * src/audio-manifest.json, which is what times the video.
 *
 *   node scripts/audio.mjs status              subscription + credits left
 *   node scripts/audio.mjs voices [query]      your voices + library matches
 *   node scripts/audio.mjs samples <id,id,...> one test read per voice → out/samples
 *   node scripts/audio.mjs tts | sfx | beds    generate one group (skips existing files)
 *   node scripts/audio.mjs align               forced-align the raw reads (word timings)
 *   node scripts/audio.mjs all                 tts + sfx + beds + manifest
 *   node scripts/audio.mjs manifest            re-shape the reads + rebuild the manifest (no API calls)
 *
 * --force regenerates files that already exist. A failed sound is reported at
 * the end with a non-zero exit, and the manifest marks it file:null. Requests run one at a time:
 * lower plans reject concurrent generations. The key comes from
 * ELEVENLABS_API_KEY or video/.env and never leaves this process.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const MANIFEST = join(ROOT, "src", "audio-manifest.json");
const API = "https://api.elevenlabs.io";
const FORMAT = "mp3_44100_128";

const script = JSON.parse(readFileSync(join(ROOT, "script.json"), "utf8"));
const [cmd = "manifest", ...rest] = process.argv.slice(2);
const force = rest.includes("--force");
const args = rest.filter((a) => !a.startsWith("--"));

/* ── plumbing ────────────────────────────────────────────────────────── */

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const env = join(ROOT, ".env");
  if (existsSync(env)) {
    const m = readFileSync(env, "utf8").match(/^ELEVENLABS_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("Set ELEVENLABS_API_KEY (or put it in video/.env)");
}

async function call(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": apiKey(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const d = parseFloat(String(out));
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/** Loudness-normalise in place so the mix in Promo.tsx works in predictable levels. */
function normalise(file, lufs) {
  if (!hasFfmpeg) return;
  const tmp = file.replace(/\.mp3$/, ".norm.mp3");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, "-ar", "44100", "-b:a", "160k", tmp]);
  execFileSync("mv", [tmp, file]);
}

function save(rel, buf) {
  const abs = join(PUBLIC, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return abs;
}

const isV3 = () => script.voice.modelId === "eleven_v3";
const spoken = (text) => (isV3() ? text : text.replace(/\[[^\]]*\]\s*/g, "")).trim();

/* ── generation ─────────────────────────────────────────────────────── */

/** Sounds that failed this run; reported at the end with a non-zero exit. */
const failures = [];

async function tts(text, voiceId) {
  const settings = { ...script.voice.settings };
  // eleven_v3 takes stability as one of three presets: 0 creative, 0.5 natural, 1 robust.
  if (isV3()) settings.stability = [0, 0.5, 1].reduce((a, b) => (Math.abs(b - settings.stability) < Math.abs(a - settings.stability) ? b : a));
  return call(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=${FORMAT}`, {
    method: "POST",
    body: { text: spoken(text), model_id: script.voice.modelId, voice_settings: settings },
  });
}

async function genVoiceover() {
  if (!script.voice.voiceId || script.voice.voiceId === "TBD") throw new Error("Pick a voice first: set voice.voiceId in script.json");
  for (const line of script.lines) {
    const rel = `audio/vo/${line.id}.raw.mp3`;
    if (!force && existsSync(join(PUBLIC, rel))) continue;
    process.stdout.write(`tts  ${line.id} … `);
    const r = await tts(line.text, script.voice.voiceId);
    save(rel, Buffer.from(r.audio_base64, "base64"));
    save(`audio/vo/${line.id}.raw.json`, JSON.stringify(r.alignment ?? r.normalized_alignment));
    console.log("ok");
  }
}

/** Silent stretches in a file, from ffmpeg silencedetect: [[start, end], …] in seconds. */
function silences(file, { noise = -40, min = 0.05 } = {}) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `silencedetect=noise=${noise}dB:d=${min}`, "-f", "null", "-"], { encoding: "utf8" });
  const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  return starts.map((a, i) => [a, ends[i] ?? Infinity]);
}

/** Merge silences closer than 20ms (a stop closure splitting one pause in two). */
function merged(sil) {
  const out = [];
  for (const [a, b] of sil) {
    const last = out.at(-1);
    if (last && a - last[1] < 0.02) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/**
 * Pin word timings to the audio. Alignments (eleven_v3's own, or forced
 * alignment) are good on word order and timing inside a phrase but drift at
 * pauses and [audio tags]. Every measured pause of 0.1s or more anchors the
 * word boundary it belongs to (the nearest one within 0.45s): the word before
 * ends where the pause starts, the word after starts where it ends. The first
 * word starts at the speech onset. Times between anchors are warped
 * piecewise-linearly, which keeps word order.
 */
function warpToPauses(words, sil, duration) {
  const pauses = merged(sil);
  const lead = pauses.find(([a]) => a <= 0.01);
  const anchors = [[words[0].start, lead && lead[1] !== Infinity ? lead[1] : 0]];
  const used = new Set();
  for (const [a, b] of pauses) {
    if (a <= 0.01 || b === Infinity || b - a < 0.1) continue;
    let best = -1;
    let bestD = 0.45;
    for (let k = 0; k < words.length - 1; k++) {
      const d = Math.abs((words[k].end + words[k + 1].start) / 2 - (a + b) / 2);
      if (!used.has(k) && d < bestD) [best, bestD] = [k, d];
    }
    if (best < 0) continue;
    used.add(best);
    anchors.push([words[best].end, a], [words[best + 1].start, b]);
  }
  const tail = pauses.find(([a, b]) => a > 0.01 && (b === Infinity || b >= duration - 0.01));
  anchors.push([words.at(-1).end, tail ? tail[0] : duration]);
  anchors.sort((p, q) => p[0] - q[0]);
  const mono = [];
  for (const p of anchors) {
    const l = mono.at(-1);
    if (!l || (p[0] > l[0] && p[1] > l[1])) mono.push(p);
  }
  const warp = (x) => {
    if (x <= mono[0][0]) return Math.max(0, mono[0][1] - (mono[0][0] - x));
    for (let i = 1; i < mono.length; i++) {
      const [x0, y0] = mono[i - 1];
      const [x1, y1] = mono[i];
      if (x <= x1) return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    }
    const [xl, yl] = mono.at(-1);
    return Math.min(duration, yl + (x - xl));
  };
  return words.map((w) => ({ text: w.text, start: warp(w.start), end: warp(w.end) }));
}

/**
 * Word timings for each raw read from ElevenLabs forced alignment (the known
 * text aligned to the audio), cached as vo/<id>.fa.json. One call per line;
 * skipped when cached unless --force.
 */
async function alignVoiceover() {
  for (const line of script.lines) {
    const raw = join(PUBLIC, `audio/vo/${line.id}.raw.mp3`);
    const out = join(PUBLIC, `audio/vo/${line.id}.fa.json`);
    if (!existsSync(raw) || (!force && existsSync(out))) continue;
    process.stdout.write(`align ${line.id} … `);
    try {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(raw)], { type: "audio/mpeg" }), `${line.id}.mp3`);
      form.append("text", line.text.replace(/\[[^\]]*\]\s*/g, "").trim());
      const res = await fetch(`${API}/v1/forced-alignment`, { method: "POST", headers: { "xi-api-key": apiKey() }, body: form });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { words } = await res.json();
      writeFileSync(out, JSON.stringify(words.filter((w) => w.text.trim()).map(({ text, start, end }) => ({ text, start, end }))));
      console.log("ok");
    } catch (e) {
      failures.push(`audio/vo/${line.id}.fa.json`);
      console.log(`failed: ${e.message.slice(0, 200)}`);
    }
  }
}

/**
 * Tighten each raw read without another API call. Cuts are made only inside
 * measured silence: the silent lead-in is clipped to voice.shape.lead and any
 * pause longer than maxPause is capped at maxPause. Then the read is sped up
 * by tempo (pitch kept), given 5ms/40ms edge fades and 100ms of tail so no line
 * ends on a click. Word timings (forced alignment pinned to the measured
 * pauses) go through the same cuts and tempo into vo/<id>.words.json, so
 * captions and cues stay on the word.
 */
function shapeVoiceover() {
  const { tempo = 1, maxPause = Infinity, lead = 0.15 } = script.voice.shape ?? {};
  for (const line of script.lines) {
    const raw = join(PUBLIC, `audio/vo/${line.id}.raw.mp3`);
    const rawAl = join(PUBLIC, `audio/vo/${line.id}.raw.json`);
    if (!existsSync(raw) || !existsSync(rawAl)) continue;
    const out = join(PUBLIC, `audio/vo/${line.id}.mp3`);
    const wordsOut = join(PUBLIC, `audio/vo/${line.id}.words.json`);
    const fa = join(PUBLIC, `audio/vo/${line.id}.fa.json`);
    let words = existsSync(fa) ? JSON.parse(readFileSync(fa, "utf8")) : alignedWords(JSON.parse(readFileSync(rawAl, "utf8")));
    if (!hasFfmpeg) {
      writeFileSync(out, readFileSync(raw));
      writeFileSync(wordsOut, JSON.stringify(words));
      continue;
    }
    const duration = probeDuration(raw);
    const sil = silences(raw);
    words = warpToPauses(words, sil, duration);
    const cuts = [];
    for (const [a, b] of merged(sil)) {
      if (a <= 0.01) {
        if (b > lead && b !== Infinity) cuts.push([0, b - lead]);
      } else if (b !== Infinity && b - a > maxPause) {
        cuts.push([a + maxPause / 2, b - maxPause / 2]);
      }
    }
    const keep = [];
    let t = 0;
    for (const [a, b] of cuts) {
      if (a > t) keep.push([t, a]);
      t = b;
    }
    keep.push([t, duration]);
    const map = (x) => round((x - cuts.reduce((acc, [a, b]) => acc + Math.min(Math.max(x - a, 0), b - a), 0)) / tempo);
    const graph =
      keep.map(([a, b], i) => `[0:a]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS[k${i}]`).join(";") +
      `;${keep.map((_, i) => `[k${i}]`).join("")}concat=n=${keep.length}:v=0:a=1,atempo=${tempo},` +
      `afade=t=in:d=0.005,areverse,afade=t=in:d=0.04,areverse,apad=pad_dur=0.1,loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-filter_complex", graph, "-map", "[out]", "-ar", "44100", "-b:a", "160k", out]);
    writeFileSync(wordsOut, JSON.stringify(words.map((w) => ({ text: w.text, start: map(w.start), end: map(w.end) }))));
    console.log(`shape ${line.id.padEnd(8)} ${duration?.toFixed(2)}s → ${probeDuration(out)?.toFixed(2)}s (${cuts.length} silence cuts, ×${tempo})`);
  }
}

async function genSound(rel, { prompt, duration, loop }, lufs) {
  if (!force && existsSync(join(PUBLIC, rel))) return;
  process.stdout.write(`sfx  ${rel} … `);
  try {
    const buf = await call(`/v1/sound-generation?output_format=${FORMAT}`, {
      method: "POST",
      raw: true,
      // the API takes 0.5–30s
      body: { text: prompt, duration_seconds: Math.min(30, Math.max(0.5, duration)), prompt_influence: 0.6, model_id: "eleven_text_to_sound_v2", ...(loop ? { loop: true } : {}) },
    });
    // land the file only once it is normalised, so a failed run is retried next time
    const tmp = save(rel.replace(/\.mp3$/, ".tmp.mp3"), buf);
    normalise(tmp, lufs);
    renameSync(tmp, join(PUBLIC, rel));
    console.log("ok");
  } catch (e) {
    // one bad prompt shouldn't cost the rest of the batch; re-run to retry the gaps
    rmSync(join(PUBLIC, rel.replace(/\.mp3$/, ".tmp.mp3")), { force: true });
    failures.push(rel);
    console.log(`failed: ${e.message.slice(0, 200)}`);
  }
}

async function genSfx() {
  for (const [name, spec] of Object.entries(script.sfx)) await genSound(`audio/sfx/${name}.mp3`, spec, -18);
}

async function genBeds() {
  for (const [name, spec] of Object.entries(script.beds)) await genSound(`audio/bed/${name}.mp3`, spec, -20);
}

/* ── manifest ───────────────────────────────────────────────────────── */

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Caption words with their *emphasis* flags (a *span* may cover several words). */
function captionWords(caption) {
  let on = false;
  return caption.split(/\s+/).filter(Boolean).map((tok) => {
    const opens = tok.startsWith("*");
    const closes = tok.replace(/[.,!?:;]+$/, "").endsWith("*");
    if (opens) on = true;
    const word = { text: tok.replace(/\*/g, ""), emphasis: on };
    if (closes) on = false;
    return word;
  });
}

/** Spoken words with times from ElevenLabs' character alignment (audio tags skipped). */
function alignedWords(al) {
  const words = [];
  let cur = null;
  let inTag = false;
  al.characters.forEach((ch, i) => {
    if (ch === "[") inTag = true;
    if (inTag) {
      if (ch === "]") inTag = false;
      return;
    }
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    const s = al.character_start_times_seconds[i];
    const e = al.character_end_times_seconds[i];
    if (!cur) cur = { text: "", start: s, end: e };
    cur.text += ch;
    cur.end = e;
  });
  if (cur) words.push(cur);
  return words.filter((w) => norm(w.text));
}

/** Place caption words on the spoken timeline: 1:1 when the words match, else by length. */
function timeCaption(caption, spokenWords, duration) {
  const cap = captionWords(caption);
  if (spokenWords && spokenWords.length === cap.length && cap.every((w, i) => norm(w.text) === norm(spokenWords[i].text))) {
    return cap.map((w, i) => ({ ...w, start: round(spokenWords[i].start), end: round(spokenWords[i].end) }));
  }
  // Estimate (no audio yet, or the texts diverge): weight by letters plus a beat per punctuation mark.
  const t0 = spokenWords?.[0]?.start ?? 0.1;
  const t1 = spokenWords?.at(-1)?.end ?? duration - 0.1;
  const weight = (w) => norm(w.text).length + 2 + (/[.!?…]$/.test(w.text) ? 5 : /[,:;]$/.test(w.text) ? 2 : 0);
  const total = cap.reduce((a, w) => a + weight(w), 0);
  let acc = 0;
  return cap.map((w) => {
    const start = t0 + ((t1 - t0) * acc) / total;
    acc += weight(w);
    const end = t0 + ((t1 - t0) * (acc - (weight(w) - norm(w.text).length - 2))) / total;
    return { ...w, start: round(start), end: round(end) };
  });
}

const round = (n) => Math.round(n * 1000) / 1000;

function writeManifest() {
  const lines = {};
  for (const line of script.lines) {
    const rel = `audio/vo/${line.id}.mp3`;
    const abs = join(PUBLIC, rel);
    const wordsPath = join(PUBLIC, `audio/vo/${line.id}.words.json`);
    const have = existsSync(abs);
    const spokenWords = existsSync(wordsPath) ? JSON.parse(readFileSync(wordsPath, "utf8")) : null;
    // No audio yet: ~0.36s a word for a fast announcer read.
    const estimate = captionWords(line.caption).length * 0.36 + 0.6;
    const duration = round((have && probeDuration(abs)) || spokenWords?.at(-1)?.end + 0.15 || estimate);
    lines[line.id] = { file: have ? rel : null, duration, caption: line.caption, words: timeCaption(line.caption, spokenWords, duration) };
  }
  const sounds = (group, specs) =>
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => {
        const rel = `audio/${group}/${name}.mp3`;
        const abs = join(PUBLIC, rel);
        const have = existsSync(abs);
        return [name, { file: have ? rel : null, duration: round((have && probeDuration(abs)) || spec.duration) }];
      }),
    );
  const manifest = {
    $comment: "Generated by scripts/audio.mjs — do not edit by hand. file:null means not generated yet (timings are estimates).",
    voice: { name: script.voice.name, voiceId: script.voice.voiceId, modelId: script.voice.modelId },
    lines,
    sfx: sounds("sfx", script.sfx),
    beds: sounds("bed", script.beds),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  const missing = Object.values(lines).filter((l) => !l.file).length;
  console.log(`manifest → src/audio-manifest.json${missing ? ` (${missing} voice lines estimated)` : ""}`);
}

/* ── voices ─────────────────────────────────────────────────────────── */

async function status() {
  try {
    const s = await call("/v1/user/subscription");
    console.log(`tier ${s.tier} · ${s.character_count}/${s.character_limit} credits used · resets ${new Date(s.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)}`);
  } catch (e) {
    // scoped keys can generate audio without being allowed to read the account
    console.log(String(e.message).includes("missing_permissions") ? "this key can't read the subscription (user_read scope); generation may still work" : e.message);
  }
}

async function voices(query = "announcer") {
  const mine = await call("/v2/voices?page_size=100");
  console.log("── your voices");
  for (const v of mine.voices) console.log(`${v.voice_id}  ${v.name}  [${v.category}]  ${Object.values(v.labels ?? {}).join(", ")}`);
  const lib = await call(`/v1/shared-voices?page_size=25&search=${encodeURIComponent(query)}`);
  console.log(`── library: "${query}"`);
  for (const v of lib.voices) console.log(`${v.voice_id}  ${v.name}  owner=${v.public_owner_id}  ${[v.gender, v.age, v.accent, v.use_case, v.descriptive].filter(Boolean).join(", ")}`);
}

async function samples(ids) {
  const text = `${script.lines[0].text} ${script.lines.at(-1).text}`;
  mkdirSync(join(ROOT, "out", "samples"), { recursive: true });
  for (const id of ids) {
    process.stdout.write(`sample ${id} … `);
    try {
      const r = await tts(text, id);
      writeFileSync(join(ROOT, "out", "samples", `${id}.mp3`), Buffer.from(r.audio_base64, "base64"));
      console.log("ok");
    } catch (e) {
      // e.g. library voices are paid-plan only over the API; keep auditioning the rest
      console.log(`failed: ${e.message.slice(0, 160)}`);
    }
  }
}

/* ── main ───────────────────────────────────────────────────────────── */

const run = {
  status,
  voices: () => voices(args[0]),
  samples: () => samples((args[0] ?? "").split(",").filter(Boolean)),
  tts: async () => (await genVoiceover(), await alignVoiceover(), shapeVoiceover(), writeManifest()),
  align: async () => (await alignVoiceover(), shapeVoiceover(), writeManifest()),
  sfx: async () => (await genSfx(), writeManifest()),
  beds: async () => (await genBeds(), writeManifest()),
  all: async () => (await genVoiceover(), await alignVoiceover(), await genSfx(), await genBeds(), shapeVoiceover(), writeManifest()),
  // local only: re-shape the raw reads (tempo, pauses) and rebuild the manifest
  manifest: () => (shapeVoiceover(), writeManifest()),
}[cmd];

if (!run) {
  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}
await run();
if (failures.length) {
  console.error(`\n${failures.length} failed (re-run to retry): ${failures.join(", ")}`);
  process.exitCode = 1;
}
