# OpenLance promo — "Press Start"

A ~45s pixel-arcade promo built with [Remotion](https://remotion.dev), in two
cuts from one edit: **16:9** (`Promo`, 1920x1080) and **9:16**
(`PromoVertical`, 1080x1920). Voiceover, sound effects and the chiptune bed
all come from ElevenLabs.

The story is a two-player co-op game: P1 the client, P2 the freelancer.

| # | Scene | Beat |
|---|---|---|
| 1 | Attract + select player | Two players, one question: who do you trust? |
| 2 | Stage 1 · Fund | Insert coin: the value locks in escrow before work starts |
| 3 | Stage 2 · Submit | Proof goes on-chain: signing → mining → mirroring |
| 4 | Stage 3 · Release | Approved, payout. No invoices, no chasing |
| 5 | Boss fight · Dispute | Staked arbiters vote release / refund / split, on the 72h clock |
| 6 | Power-up · Gasless | Submit, approve, vote: gas is on us (state only, never value) |
| 7 | Press start | Mark, wordmark, "paid by proof", repo link |

It uses the app's visual system verbatim: the sprites come from
`apps/web/components/pixel-sprites.ts` (imported, not copied), the fonts are
the app's self-hosted faces, and the motion follows DESIGN.md (stepped
frames, 8px snapping, pixel-pop, no springs or eased tweens).

## Run it

This folder is its own pnpm root, outside the app workspace, so Remotion
never lands in the web/api installs or the Vercel builds.

```bash
cd video
pnpm install
pnpm studio            # live preview
pnpm render            # both cuts, mastered → out/openlance-promo.mp4, out/openlance-promo-vertical.mp4
```

Where Remotion can't download its own Chrome Headless Shell, point it at one:
`REMOTION_BROWSER_EXECUTABLE=/path/to/headless_shell pnpm render`.

## Audio

`script.json` is the spine: the voice lines (with `eleven_v3` audio tags),
the captions, the SFX prompts and the music-bed prompts. `scripts/audio.mjs`
turns it into sound and writes `src/audio-manifest.json`, which **times the
film**: each scene is sized around its line, animation hangs off word cues,
and the caption box types each word as it is spoken.

```bash
echo 'ELEVENLABS_API_KEY=sk_…' > .env      # gitignored
node scripts/audio.mjs voices announcer    # find voices
node scripts/audio.mjs samples id1,id2     # audition → out/samples/
# set voice.voiceId in script.json, then:
node scripts/audio.mjs all                 # VO + alignment + SFX + beds + manifest
```

The voice goes through three steps:

1. **TTS**: each line's raw read, `public/audio/vo/<id>.raw.mp3`.
2. **Forced alignment**: ElevenLabs aligns the known text to the raw read,
   giving `vo/<id>.fa.json`. `eleven_v3`'s own timestamps drift by up to 0.4s
   around audio tags and pauses, so they are only the fallback.
3. **Shape** (local, no API calls): clips the silent lead-in, caps pauses at
   `voice.shape.maxPause`, speeds up by `voice.shape.tempo` (pitch kept) and
   adds edge fades. It **cuts only inside measured silence**. Every measured
   pause anchors its word boundary, and the word timings go through the same
   cuts into `vo/<id>.words.json`. Tune `voice.shape` and run
   `node scripts/audio.mjs manifest` to re-time the film for free.

Generated files are skipped on re-runs (`--force` regenerates). A failed
generation is reported with a non-zero exit. Each file is loudness-normalised
(VO −16, SFX −18, beds −20 LUFS) so the mix in `src/Promo.tsx` works in
predictable levels. The bed is ducked under the voice and crossfades at the
boss-fight handovers. Generated sounds that swell or end at full level are
trimmed in place with `<Sfx cut fade>`.

`pnpm render` finishes with `scripts/master.mjs`, a two-pass EBU R128
loudnorm of both films to −14 LUFS / −1.5 dBTP with the video copied
untouched. Every step that touches audio needs `ffmpeg` on the PATH.

## Layout

```
script.json            voice lines, captions, SFX and bed prompts
scripts/audio.mjs      ElevenLabs pipeline → public/audio + src/audio-manifest.json
scripts/master.mjs     loudness master for the rendered films (−14 LUFS)
scripts/stills.mjs     review contact sheets of chosen frames, both cuts
src/timeline.ts        scene lengths and word cues, derived from the manifest
src/Promo.tsx          the film: scenes, HUD, captions, wipes, VO, beds, ducking
src/scenes/*.tsx       one file per scene
src/components/        HUD, dialog-box captions, block-dissolve wipe, CRT, stage layout
src/pixel.tsx          Sprite, Avatar, Panel, Badge, Chip, PixelButton at 2x
```
