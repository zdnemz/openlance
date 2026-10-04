#!/usr/bin/env python3
"""ElevenLabs TTS for SCRIPT.md: one line at a time (the key rejects parallel
requests), word timings from the /with-timestamps character alignment.
Writes assets/voice/NN.wav and audio_meta.json (product-launch shape), and keeps
any bgm/sfx already in audio_meta.json.

  python3 scripts/tts.py            # all lines
  python3 scripts/tts.py 2 5        # only frames 2 and 5
"""
import base64, json, os, re, subprocess, sys, urllib.request

VOICE = "Xb7hH8MSUJpSbSDYk0k2"  # Alice
MODEL = "eleven_multilingual_v2"
SETTINGS = {"stability": 0.55, "similarity_boost": 0.75, "style": 0.15}
KEY = open("secrets/ELEVENLABS_API_KEY").read().strip()
# (head, tail) silence per frame, seconds: breathing room baked into the wav so
# sync-durations stays mechanical. F1 head = "AGREEMENT" typing, F6 tail = hold on "Code.", F7 tail = CTA hold.
PAD = {1: (0.8, 0.7), 2: (0.3, 1.0), 3: (0.3, 1.0), 4: (0.3, 1.0), 5: (0.3, 0.8), 6: (0.5, 1.4), 7: (0.4, 2.2)}


def script_lines():
    out, frame, buf = [], None, []
    for line in open("SCRIPT.md"):
        m = re.match(r"^##\s+.*\(Frame\s+(\d+)\)", line)
        if m:
            if frame: out.append((frame, " ".join(buf)))
            frame, buf = int(m.group(1)), []
        elif frame and line.startswith("    ") and line.strip():
            buf.append(line.strip())
    if frame: out.append((frame, " ".join(buf)))
    return out


def words_from_alignment(a):
    words, cur, start, end = [], "", None, None
    for ch, s, e in zip(a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"]):
        if ch.isspace():
            if cur: words.append((cur, start, end))
            cur, start = "", None
            continue
        if start is None: start = s
        cur, end = cur + ch, e
    if cur: words.append((cur, start, end))
    return [{"id": f"w{i}", "text": t, "start": round(s, 3), "end": round(e, 3)} for i, (t, s, e) in enumerate(words)]


def synth(text, prev, nxt):
    body = {"text": text, "model_id": MODEL, "voice_settings": SETTINGS,
            "previous_text": prev, "next_text": nxt}
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
        data=json.dumps(body).encode(), headers={"xi-api-key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main():
    only = {int(x) for x in sys.argv[1:]}
    lines = script_lines()
    meta = json.load(open("audio_meta.json")) if os.path.exists("audio_meta.json") else {}
    voices = {v["frame"]: v for v in meta.get("voices", [])}
    os.makedirs("assets/voice", exist_ok=True)
    for i, (frame, text) in enumerate(lines):
        if only and frame not in only: continue
        prev = lines[i - 1][1] if i else None
        nxt = lines[i + 1][1] if i + 1 < len(lines) else None
        res = synth(text, prev, nxt)
        mp3, wav = f".scratch/{frame:02d}.mp3", f"assets/voice/{frame:02d}.wav"
        open(mp3, "wb").write(base64.b64decode(res["audio_base64"]))
        json.dump(res["alignment"], open(f".scratch/{frame:02d}.align.json", "w"))
        head, tail = PAD.get(frame, (0, 0))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3, "-af",
                        f"adelay={int(head*1000)}:all=1,apad=pad_dur={tail}", "-ar", "44100", wav], check=True)
        dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]))
        voices[frame] = {"frame": frame, "path": wav, "duration_s": round(dur, 3), "words": [dict(w, start=round(w["start"] + head, 3), end=round(w["end"] + head, 3))
                                                                                 for w in words_from_alignment(res["alignment"])]}
        print(f"  voice {frame:02d}: {dur:.2f}s  {len(voices[frame]['words'])} words")
    meta["voices"] = [voices[k] for k in sorted(voices)]
    meta.setdefault("bgm", None); meta.setdefault("bgm_pending", False); meta.setdefault("sfx", [])
    json.dump(meta, open("audio_meta.json", "w"), indent=2)
    print(f"✓ {len(meta['voices'])} voices, {sum(v['duration_s'] for v in meta['voices']):.2f}s total → audio_meta.json")


if __name__ == "__main__":
    main()
