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
 *   node scripts/audio.mjs all                 tts + sfx + beds + manifest
 *   node scripts/audio.mjs manifest            re-shape the reads + rebuild the manifest (no API calls)
 *
 * --force regenerates files that already exist. Requests run one at a time:
 * lower plans reject concurrent generations. The key comes from
 * ELEVENLABS_API_KEY or video/.env and never leaves this process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Tighten each raw read without another API call: clip the lead-in, cap the
 * pauses between words at voice.maxPause, then speed up by voice.tempo (pitch
 * kept). The character alignment goes through the same cuts and tempo, so
 * captions and cues stay on the word. Writes vo/<id>.mp3 + <id>.alignment.json.
 */
function shapeVoiceover() {
  const { tempo = 1, maxPause = Infinity, lead = 0.15 } = script.voice.shape ?? {};
  for (const line of script.lines) {
    const raw = join(PUBLIC, `audio/vo/${line.id}.raw.mp3`);
    const rawAl = join(PUBLIC, `audio/vo/${line.id}.raw.json`);
    if (!existsSync(raw) || !existsSync(rawAl)) continue;
    const al = JSON.parse(readFileSync(rawAl, "utf8"));
    const out = join(PUBLIC, `audio/vo/${line.id}.mp3`);
    if (!hasFfmpeg) {
      writeFileSync(out, readFileSync(raw));
      writeFileSync(join(PUBLIC, `audio/vo/${line.id}.alignment.json`), JSON.stringify(al));
      continue;
    }
    const words = alignedWords(al);
    const end = Math.min(probeDuration(raw) ?? Infinity, words.at(-1).end + lead);
    const cuts = [];
    if (words[0].start > lead) cuts.push([0, words[0].start - lead]);
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap > maxPause) cuts.push([words[i - 1].end + maxPause / 2, words[i].start - maxPause / 2]);
    }
    // keep = [0, end] minus the cuts
    const keep = [];
    let t = 0;
    for (const [a, b] of cuts) {
      if (a > t) keep.push([t, a]);
      t = b;
    }
    if (end > t) keep.push([t, end]);
    const map = (x) => {
      const removed = cuts.reduce((acc, [a, b]) => acc + Math.min(Math.max(x - a, 0), b - a), 0);
      return round((Math.min(x, end) - removed) / tempo);
    };
    const graph =
      keep.map(([a, b], i) => `[0:a]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS[k${i}]`).join(";") +
      `;${keep.map((_, i) => `[k${i}]`).join("")}concat=n=${keep.length}:v=0:a=1,atempo=${tempo},loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-filter_complex", graph, "-map", "[out]", "-ar", "44100", "-b:a", "160k", out]);
    writeFileSync(
      join(PUBLIC, `audio/vo/${line.id}.alignment.json`),
      JSON.stringify({
        characters: al.characters,
        character_start_times_seconds: al.character_start_times_seconds.map(map),
        character_end_times_seconds: al.character_end_times_seconds.map(map),
      }),
    );
    const before = probeDuration(raw);
    console.log(`shape ${line.id.padEnd(8)} ${before?.toFixed(2)}s → ${probeDuration(out)?.toFixed(2)}s (${cuts.length} cuts, ×${tempo})`);
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
    normalise(save(rel, buf), lufs);
    console.log("ok");
  } catch (e) {
    // one bad prompt shouldn't cost the rest of the batch; re-run to retry the gaps
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
    const alPath = join(PUBLIC, `audio/vo/${line.id}.alignment.json`);
    const have = existsSync(abs);
    const spokenWords = existsSync(alPath) ? alignedWords(JSON.parse(readFileSync(alPath, "utf8"))) : null;
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
  tts: async () => (await genVoiceover(), shapeVoiceover(), writeManifest()),
  sfx: async () => (await genSfx(), writeManifest()),
  beds: async () => (await genBeds(), writeManifest()),
  all: async () => (await genVoiceover(), await genSfx(), await genBeds(), shapeVoiceover(), writeManifest()),
  // local only: re-shape the raw reads (tempo, pauses) and rebuild the manifest
  manifest: () => (shapeVoiceover(), writeManifest()),
}[cmd];

if (!run) {
  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}
await run();
