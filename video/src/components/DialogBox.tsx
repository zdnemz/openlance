import { useCurrentFrame } from "remotion";
import { useLayout } from "../layout";
import { blink } from "../motion";
import { FPS, SCENES, type Word } from "../timeline";
import { C, F, FRAME } from "../theme";

/** Split a line into phrases at sentence ends; the box shows one phrase at a time. */
function phrases(words: Word[]) {
  const out: Word[][] = [[]];
  words.forEach((w) => {
    out.at(-1)!.push(w);
    if (/[.!?]$/.test(w.text)) out.push([]);
  });
  return out.filter((p) => p.length);
}

/**
 * Captions as an RPG dialog box: the announcer's words type in as they are
 * spoken (word timings from the TTS alignment), emphasis in rose. Most social
 * video plays muted; this carries the script without the sound.
 */
export function DialogBox() {
  const frame = useCurrentFrame();
  const L = useLayout();
  const s = SCENES.findLast((sc) => sc.from <= frame);
  if (!s || s.id === "finale") return null;
  const local = frame - s.from;
  const t = (local - s.voFrom) / FPS;
  const lastEnd = s.line.words.at(-1)?.end ?? 0;
  if (t < -0.1 || t > lastEnd + 0.6) return null;

  const groups = phrases(s.line.words);
  const current = groups.findLast((g) => g[0]!.start <= Math.max(t, 0)) ?? groups[0]!;
  const done = t >= current.at(-1)!.end;

  return (
    <div
      style={{
        position: "absolute",
        left: L.caption.x,
        right: L.caption.x,
        top: L.caption.top,
        height: L.caption.h,
        background: C.raised,
        border: `${FRAME}px solid ${C.lineStrong}`,
        boxShadow: `12px 12px 0 0 #000`,
        padding: L.tall ? "40px 40px" : "28px 40px",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -22,
          left: 28,
          padding: "8px 14px",
          background: C.rose,
          color: C.fg,
          fontFamily: F.display,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ANNOUNCER
      </div>
      <div style={{ fontFamily: F.body, fontWeight: 500, fontSize: L.caption.size, lineHeight: 1.25, color: C.fg }}>
        {current.map((w, i) => {
          // type each word in across its own spoken span, on twos
          const p = w.end > w.start ? (t - w.start) / (w.end - w.start) : t >= w.start ? 1 : 0;
          const shown = Math.max(0, Math.min(w.text.length, Math.ceil(p * w.text.length)));
          return (
            <span key={i} style={{ color: w.emphasis ? C.roseLight : C.fg }}>
              {w.text.slice(0, shown)}
              <span style={{ color: "transparent" }}>{w.text.slice(shown)}</span>
              {i < current.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
      {done && (
        <div style={{ position: "absolute", right: 28, bottom: 24, width: 16, height: 16, background: C.roseLight, opacity: blink(local, 16) }} />
      )}
    </div>
  );
}
