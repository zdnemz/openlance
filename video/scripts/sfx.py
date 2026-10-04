#!/usr/bin/env python3
"""ElevenLabs sound effects for the promo: generate each sound once (sequential,
the key rejects parallel requests), then write frame-relative cues into
audio_meta.json for assemble-index.mjs. Re-running skips sounds already on disk.

  python3 scripts/sfx.py
"""
import json, os, urllib.request

KEY = open("secrets/ELEVENLABS_API_KEY").read().strip()

SOUNDS = {  # name: (prompt, seconds)
    "type": ("crisp mechanical typewriter typing a short word, close mic, dry", 1.0),
    "impact": ("soft deep cinematic impact, low thud with a subtle paper texture, short tail", 1.0),
    "stamp": ("rubber stamp pressed firmly onto paper on a wooden desk, single thump", 0.6),
    "page": ("single crisp paper page turn, quick", 0.7),
    "cards": ("three playing cards dealt quickly onto a felt table, three flicks", 1.0),
    "whoosh": ("fast airy cinematic whoosh rising into a soft hit", 1.0),
    "pen": ("fountain pen signing a quick signature on paper, scribble", 1.3),
    "tick": ("tiny soft ui tick, clean click", 0.5),
}

# (frame, sound, offset_s within the frame, volume) — offsets follow the frame timelines
CUES = [
    (1, "type", 0.3, 0.30), (1, "impact", 3.5, 0.45), (1, "impact", 4.52, 0.40),
    (2, "stamp", 0.3, 0.45), (2, "tick", 4.6, 0.30),
    (3, "page", 0.0, 0.40), (3, "tick", 2.75, 0.30),
    (4, "page", 0.0, 0.40), (4, "cards", 2.2, 0.45),
    (5, "page", 0.0, 0.40), (5, "tick", 1.18, 0.25), (5, "tick", 1.75, 0.25), (5, "tick", 2.5, 0.25),
    (5, "stamp", 3.85, 0.40),
    (6, "whoosh", 0.0, 0.40), (6, "type", 0.65, 0.25), (6, "impact", 2.1, 0.40),
    (7, "pen", 2.5, 0.45),
]


def gen(name, prompt, secs):
    path = f"assets/sfx/{name}.mp3"
    if os.path.exists(path):
        return path
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
        data=json.dumps({"text": prompt, "duration_seconds": secs, "prompt_influence": 0.6}).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        open(path, "wb").write(r.read())
    print(f"  sfx {name}: {secs}s")
    return path


def main():
    os.makedirs("assets/sfx", exist_ok=True)
    files = {n: gen(n, p, s) for n, (p, s) in SOUNDS.items()}
    meta = json.load(open("audio_meta.json"))
    meta["sfx"] = [{"frame": f, "name": n, "file": files[n], "offset_s": o,
                    "duration_s": SOUNDS[n][1], "volume": v} for f, n, o, v in CUES]
    json.dump(meta, open("audio_meta.json", "w"), indent=2)
    print(f"✓ {len(meta['sfx'])} sfx cues → audio_meta.json")


if __name__ == "__main__":
    main()
