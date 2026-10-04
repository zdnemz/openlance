"use client";

/**
 * PageHeader — one header grammar for every app page (DESIGN.md):
 * pixel display h1 + dim description, right-aligned mono meta. No kickers.
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
        <h1 className="display text-[18px] leading-[1.5] md:text-[24px]">{title}</h1>
        {desc && <p className="mt-4 text-[16px] leading-relaxed text-dim">{desc}</p>}
        {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {meta && <div className="num w-full pb-0 text-[13px] leading-relaxed text-faint md:w-auto md:pb-1.5 md:text-right">{meta}</div>}
    </div>
  );
}
