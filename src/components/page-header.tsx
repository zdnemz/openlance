"use client";

/**
 * PageHeader — one header grammar for every app page (DESIGN.md):
 * serif display h1 + dim description, right-aligned mono meta. No kickers.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  desc,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  desc?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-5", className)}>
      <div className="max-w-[62ch]">
        <h1 className="display text-[34px] leading-[1.05] md:text-[40px]">{title}</h1>
        {desc && <p className="mt-3 text-sm leading-relaxed text-dim">{desc}</p>}
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {meta && <div className="num pb-1.5 text-right text-[12px] leading-relaxed text-faint">{meta}</div>}
    </div>
  );
}
