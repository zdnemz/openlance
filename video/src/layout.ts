import { useVideoConfig } from "remotion";

/**
 * One film, two frames. Wide (1920x1080) splits stage scenes into a title
 * column and an instrument column, the landing's asymmetric split. Tall
 * (1080x1920) stacks them, and keeps clear of the top ~96px and bottom ~340px
 * that Reels, TikTok and Shorts cover with their own UI.
 */
export function useLayout() {
  const { width: W, height: H } = useVideoConfig();
  const tall = H > W;
  return tall
    ? {
        tall,
        W,
        H,
        hud: { top: 96, h: 120, pad: 48 },
        stage: { top: 256, bottom: 1296 },
        caption: { top: 1336, h: 232, x: 48, size: 48 },
        title: { top: 280, h: 320 },
        instrument: { top: 616, h: 664 },
        /** the block-dissolve grid */
        cell: 120,
      }
    : {
        tall,
        W,
        H,
        hud: { top: 0, h: 112, pad: 64 },
        stage: { top: 136, bottom: 848 },
        caption: { top: 872, h: 168, x: 96, size: 44 },
        title: { top: 136, h: 712 },
        instrument: { top: 168, h: 664 },
        cell: 120,
      };
}

export type Layout = ReturnType<typeof useLayout>;
