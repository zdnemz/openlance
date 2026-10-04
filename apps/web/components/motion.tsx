"use client";

/**
 * Motion primitives — pixel motion is stepped. Nothing here eases: a value
 * moves in a handful of whole-pixel frames (`steps(n)`), the way a sprite
 * animates, never as a spring or a tween. Isolated so the calm app shell never
 * imports framer-motion; only the landing page does.
 */
import type { ComponentProps } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A quantised easing for framer-motion: progress snaps to `n` equal frames and
 * lands exactly on 1. `stepEase(4)` is a 4-frame sprite move.
 */
export const stepEase = (n: number) => (t: number) => Math.min(1, Math.floor(t * n) / (n - 1 || 1));

/** Frame budget used across the landing page: short, snappy, always a few frames. */
export const stepTransition = (duration = 0.4, frames = 5, delay = 0) =>
  ({ duration, ease: stepEase(frames), delay }) as const;

/**
 * A panel that lifts on hover: the face steps up-left and its slab grows
 * (`.pixel-lift`). Replaces the cursor-tracked spotlight — there is no pointer
 * tracking and nothing to re-render.
 */
export function LiftCard({ children, className, ...rest }: ComponentProps<"div">) {
  return (
    <div className={cn("pixel-lift", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Primary call-to-action link rendered as a pixel button. Replaces the magnetic
 * link: the press is physical (the face drops onto its slab) instead of pulled
 * toward the cursor.
 */
export function PixelLink({ children, className, ...rest }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "pixel-btn inline-flex min-h-12 cursor-pointer items-center justify-center gap-2.5 px-6 py-3.5 font-display text-[12px] uppercase leading-none text-white focus-visible:outline-offset-4",
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** Stagger container/child variants — parent + child must share one client tree. */
export const staggerParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.05 } },
} as const;

export const staggerChild = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: stepTransition(0.32, 4) },
} as const;
