---
format: 1920x1080
duration: 45s
message: "The money exists before the work does."
arc: PAS-lite → clause cascade (feature→benefit) → reveal → CTA
audience: freelancers and clients burned by unpaid invoices or undelivered work; web3-curious builders
mode: collaborative
music: none
music_prompt: restrained editorial underscore — soft felt piano + low pulse, 92–100 BPM, builds gently, clean ending
---

## Locked

- storyboard.html v2 is confirmed by the user ("start", 2026-10-04): placement, hierarchy and copy are locked.
- Exhibits are built as reconstructed app windows (the v2 sketch treatment) because the dev stack is not
  running. Swap in real captures later if the user boots `pnpm chain` + `pnpm dev`.
- Captions: skipped (an editorial piece; the typeset clauses already carry the words).

## Video direction

- **Palette:** ink ground #09090b, voice #f4f4f5, card step #101014, rose #e11d48 / #f43f5e once per frame.
  Frame 06 is the single full-rose ground. Milestone states use the app's own colors (amber / blue / green).
- **Type:** display is Instrument Serif (the clauses, numerals, figures), body is Schibsted Grotesk, and chrome
  (kickers, tabs, function names) is IBM Plex Mono.
- **Motion grammar:** power3/power4 out for entrances, expo for slams, no bounce except the CTA pill (back.out 1.4).
  Text typesets word-by-word (y 40%→0 + opacity, 0.06s stagger). Exhibit windows swing in from off-frame on a
  3D tilt (rotateY ±28°→±16°, x ±30%→0) with a slow push-in that runs to frame end. Giant outlined numerals drift
  up 4% across the frame (the camera layer). Every reveal lands on its spoken cue (word timings in audio_meta.json).
- **Rhythm:** 01 builds, 02–05 reveal to the VO, 06 slams then HOLDS on "Code." (the breather before the close),
  07 settles and holds on the CTA through the final chord.
- **Never:** front-load-then-freeze; free-floating screensaver drift; glow, neon, coins, cubes; an exit tween on a
  non-final frame; a second rose element in a frame.

## Changes from v1

- User (sketch review): "make more eye-catching" — applies to all frames. v2 drawn in storyboard.html:
  giant outlined clause numerals (1–4) behind the type; type at bleed scale; exhibits as tilted, overlapping
  UI cards instead of flat placeholders; frame 05 "0.00" bleeding off-frame; frame 06 flips to a full rose
  ground (the film's one big voltage moment); frame 07 adds a drawn signature + seal ring; subtle film grain.

## Changes from v2 build

- User: "make the animation more eye-catching". Added per frame: camera punch-in (scale 1.09→1) then a slow push;
  deterministic impact jolts on every slam (hit()); numerals enter from 1.35× with rotation; words slam from 1.35×
  or flip up (rotationX); exhibit windows, the center arbiter card and the CTA get one specular gloss sweep
  (mechanic borrowed from registry gloss-sweep); the rail nodes and arbiter card ripple; cards deal in from ±38°;
  the seal spins in from −160°; wordmark letters flip up in 3D; "Code." slams from 1.9×.

## Still open

- Built and checked (lint 0 errors, check passed, 69/69 contrast). Awaiting the user's final review in Studio
  (http://localhost:3002/#project/video) before `npx hyperframes render --quality high --output renders/video.mp4`.
- Exhibits are reconstructed app windows; swap in real captures if the dev stack is booted.
- Audio: VO = scripts/tts.py (Alice), SFX = scripts/sfx.py (18 cues), BGM = assets/bgm/underscore.wav.

## Frame 1 — Two doubts

- scene: A blank contract page; "AGREEMENT" types in, then two doubts type on opposite sides: "Will they pay?" / "Will they deliver?"
- voiceover: "Every freelance deal starts with two doubts. Will they pay? Will they deliver?"
- duration: 6.701s
- transition_in: cut
- status: animated
- src: compositions/frames/01-two-doubts.html
- type: hook
- persuasion: Pain validation (both sides at once)
- beat: tension + recognition
- blueprint: typewriter-reveal
- asset_candidates:

- shot: Scene 1 (0–0.8s): ground + grain; caret blinks twice beside an empty kicker, then types "AGREEMENT" (0.15s/char feel, finished by 0.9s). → Scene 2 (1.2–3.4s): giant outlined "?" fades up 0→1 behind, scale 1.08→1, drifting up slowly to frame end. → Scene 3 (3.6s "Will they pay?"): left doubt slams in word by word (y 60%→0, expo.out), label "— asks the freelancer" fades in at 4.2s. → Scene 4 (4.6s "Will they deliver?"): rose italic doubt slams in cross-corner, label at 5.2s. Hold to 6.7s.
narrativeRole: Name the shared fear of clients AND freelancers, in their words, before any product appears.
keyMessage: Trust is the real cost of freelance work.

## Frame 2 — Clause 1: Funded first

- scene: "OpenLance" stamps the page; "Clause 1. The money exists before the work does." typesets in serif, then Exhibit A (the funded milestone in the project room) slides in as an evidence card
- voiceover: "OpenLance rewrites the deal. Clause one: the money exists before the work does."
- duration: 6.78s
- transition_in: crossfade
- status: animated
- src: compositions/frames/02-clause-funded.html
- type: product_intro
- persuasion: Risk reversal
- beat: relief
- blueprint: kinetic-type-beats
- asset_candidates:

- shot: Scene 1 (0–1.2s): outlined "1" rises from y+12% into place and keeps drifting; kicker "✱ OpenLance · Clause 1" stamps at 0.3s (scale 1.15→1, opacity). → Scene 2 (2.3–5.4s): clause typesets word by word, cued "the"@3.34, "money"@3.5, "exists"@3.88, "before"@4.35, "the work does."@4.7–5.2; rose highlighter swipe scaleX 0→1 under "before" at 4.45s. → Scene 3 (1.0–6.78s): Exhibit A swings in from off-frame right (x +35%, rotateY −32°→−16°) at 1.0s, tab drops in at 1.5s; "2.50 ETH LOCKED" counts up 0.00→2.50 between 3.5–4.6s; FUNDED pill pops at 4.6s; slow push-in scale 1→1.04 to the end.
narrativeRole: Land the message by beat 2: payment is locked in escrow before work starts.
keyMessage: The money exists before the work does.

## Frame 3 — Clause 2: Paid on proof

- scene: "Clause 2. Paid the moment proof is accepted." Exhibit B shows the milestone rail, with funded → submitted → released lighting up in turn
- voiceover: "Clause two: deliver the proof, get paid. No invoices. No chasing."
- duration: 6.641s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/03-clause-proof.html
- type: feature_showcase
- persuasion: Friction reduction
- beat: ease + control
- blueprint: device-surface-showcase
- asset_candidates:

- shot: Scene 1 (0–0.6s): outlined "2" rises in on the right; Exhibit B swings in from off-frame left (x −35%, rotateY 32°→14°), tab drops at 0.5s; kicker at 0.3s. → Scene 2 (1.4–3.2s): "Deliver the proof," typesets at 1.45s; SUBMITTED row slides up at 2.0s ("proof"); "get paid." rose italic lands at 2.55s with the RELEASED row. → Scene 3 (0.8–4.0s): foot rail draws left→right: FUNDED node lights at 0.9s, line to SUBMITTED by 2.0s, line to RELEASED + ✓ fill at 2.8s. → Scene 4 (3.47s "No invoices", 4.49s "No chasing"): lead words reveal on their cues. Push-in continues to 6.64s.
narrativeRole: Turn the escrow into the freelancer's benefit: pay arrives without asking.
keyMessage: Proof in, payment out.

## Frame 4 — Clause 3: Staked arbiters

- scene: "Clause 3. Disagreements go to arbiters with skin in the game." Exhibit C shows the arbiter registry with stakes and trust scores; three seats light up
- voiceover: "Clause three: if you disagree, three staked arbiters decide. And they have skin in the game."
- duration: 7.105s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/04-clause-arbiters.html
- type: feature_showcase
- persuasion: Authority by accountability (arbiters lose stake for bad rulings)
- beat: trust
- blueprint: grid-card-assemble
- asset_candidates:

- shot: Scene 1 (0–1.6s): kicker at 0.3s; headline "Disagree? Three arbiters decide —" typesets 0.6–2.0s; outlined "3" rises behind. → Scene 2 (2.2–3.6s, "three staked arbiters"): three seat cards deal up from below the frame (y +60%) and fan to −9° / 0° / +9°, staggered 0.18s from 2.2s; center card lifts last with the rose border. → Scene 3 (3.0–4.4s): center stake counts 0.0→2.0, side stakes 0→1.5 / 1.0; trust bar fills to 92%. → Scene 4 (4.9s "skin in the game"): italic line "with skin in the game." reveals word by word; the Exhibit C tab drops at 5.2s. Hold to 7.1s.
narrativeRole: Answer "what if it goes wrong?", the client's remaining doubt.
keyMessage: Disputes are settled by people who have something to lose.

## Frame 5 — Clause 4: No gas

- scene: "Clause 4. You act; we pay the gas." A serif number lockup reads "0.00" with a mono "GAS" unit as submit / approve / vote tick past
- voiceover: "Clause four: submit, approve, vote. No gas. It's on us."
- duration: 6.208s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/05-clause-gas.html
- type: benefit_highlight
- persuasion: Friction reduction (removes the crypto tax)
- beat: ease
- blueprint: kinetic-type-beats
- asset_candidates:

- shot: Scene 1 (0–0.6s): kicker; headline "You act. / We pay the gas." typesets 0.3–1.1s. → Scene 2 (1.2s / 1.8s / 2.56s): chips "✓ submit()" "✓ approve()" "✓ vote()" pop in on each spoken verb. → Scene 3 (2.7–3.6s, "No gas."): bleed-scale figure rises from below the edge (y +25%→0) while counting 0.42→0.00, landing exactly on "gas."@3.42. → Scene 4 (3.9s "It's on us."): rose "GAS · SPONSORED" stamps in (letter-spacing .6em→.24em, opacity). Hold to 6.2s.
narrativeRole: Remove the last web3 objection without saying "web3".
keyMessage: Using it feels like any app.

## Frame 6 — The reveal

- scene: Full rose page (the one big color moment). The four clause titles stack, then each serif title re-sets into its real Solidity call (fund() · approve() · openDispute() · execute()); the line "Enforced by a smart contract." lands in rose
- voiceover: "Every clause is enforced by a smart contract. Not a promise. Code."
- duration: 6.358s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/06-reveal.html
- type: benefit_highlight
- persuasion: Show-don't-tell proof (the real function names)
- beat: awe + confidence
- blueprint: kinetic-type-beats
- asset_candidates:

- shot: Scene 1 (0–0.5s): full rose page (arrives on the zoom-through). The four clause titles are already set, dim. → Scene 2 (0.5–2.6s, "Every clause is enforced"): row by row (0.5, 0.85, 1.2, 1.55s) each title strikes through (line scaleX 0→1) and its mono call types in beside it. → Scene 3 (1.45–2.9s): "Enforced by a / smart contract." slams in by line (y 50%→0, expo.out), landing "contract."@2.57. → Scene 4 (3.3s "Not a promise"): mono "NOT A PROMISE —" reveals. → Scene 5 (4.36s "Code."): italic "Code." lands alone. HOLD still to 6.36s (the breather).
narrativeRole: The withheld twist. The contract was literal all along.
keyMessage: Trust is enforced, not requested.

## Frame 7 — Sign here

- scene: The OpenLance shield mark assembles; the wordmark and the tagline "Freelance, with the money on the table." appear above a signature line, with github.com/zdnemz/openlance as the one rose CTA
- voiceover: "OpenLance. Freelance work, with the money on the table."
- duration: 6.269s
- transition_in: crossfade
- status: animated
- src: compositions/frames/07-sign-here.html
- type: cta
- persuasion: Inevitability close
- beat: confidence + urgency-to-act
- blueprint: logo-assemble-lockup
- asset_candidates: assets/openlance-icon.svg — the OpenLance shield mark

- shot: Scene 1 (0–1.2s): the shield mark scales 0.85→1 and fades in; the seal ring draws/rotates in (rotation −40°→0, opacity) and keeps turning slowly to the end; outlined "§" fades up behind. → Scene 2 (0.4s "OpenLance."): wordmark typesets by letter. → Scene 3 (1.6–3.4s): italic tagline reveals word by word on "Freelance work, with the money on the table"; the signature path draws itself (stroke-dashoffset) 2.5–3.6s. → Scene 4 (3.9s): rose CTA pill springs in (back.out 1.4) and holds; final 0.8s eases everything to a gentle settle (final frame — the only fade-out allowed).
narrativeRole: Sign the contract. Brand and ask.
keyMessage: OpenLance, github.com/zdnemz/openlance.
