"use client";

/**
 * Motion primitives (MOTION_INTENSITY 6) — isolated so the calm app shell
 * never imports framer-motion. Both run entirely outside the React render
 * cycle: spotlight mutates CSS vars on the DOM node, magnetic drives
 * useMotionValue through springs. Zero re-renders on pointer move.
 */
import { useRef, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Spotlight card — cursor-tracked rose border illumination.
 * The ::before layer lives in globals.css (.spotlight); this component
 * only feeds it --mx/--my coordinates. Cheap, compositional, no state.
 */
export function SpotCard({ children, className, ...rest }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
      className={cn("spotlight", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * Magnetic link — the physical pull toward the cursor (skill: magnetic
 * micro-physics for MOTION_INTENSITY > 5). Springs, never setState.
 */
export function MagneticLink({
  children,
  pull = 9,
  className,
  ...rest
}: ComponentProps<typeof Link> & { pull?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 150, damping: 15, mass: 0.25 });
  const sy = useSpring(y, { stiffness: 150, damping: 15, mass: 0.25 });

  return (
    <motion.span ref={ref} style={{ x: sx, y: sy, display: "inline-block" }}>
      <Link
        onPointerMove={(e) => {
          const el = ref.current;
          if (!el) return;
          const r = el.getBoundingClientRect();
          x.set(((e.clientX - r.left) / r.width - 0.5) * 2 * pull);
          y.set(((e.clientY - r.top) / r.height - 0.5) * 2 * pull);
        }}
        onPointerLeave={() => {
          x.set(0);
          y.set(0);
        }}
        className={className}
        {...rest}
      >
        {children}
      </Link>
    </motion.span>
  );
}

/** Stagger container/child variants — parent + child must share one client tree. */
export const staggerParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
} as const;

export const staggerChild = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 110, damping: 20 } },
} as const;

export type MotionNode = ReactNode;
