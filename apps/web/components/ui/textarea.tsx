import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Multi-line input for prose the app stores and later shows to the other side:
 * a job brief, a cover note, delivery notes, a dispute reason.
 *
 * It carries the house style itself rather than leaving it to call sites —
 * the same ink surface, border and focus treatment as `Input` — so a textarea
 * sitting under a text field is not visibly a different control. The radius
 * matches `Input` (rounded-md) on purpose: the rounded-xl buttons next to it
 * are a different control class, and matching those instead is what made this
 * look wrong. Call sites override only what genuinely differs, usually a
 * smaller measure for a compact row.
 *
 * `resize-none` is the default because every consumer here is a fixed-proportion
 * box in a form, and a grab handle that resizes a proposal cover note into a
 * panel of its own is not an affordance anyone asked for. `field-sizing-content`
 * still grows it with the content.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-line bg-white/[0.03] placeholder:text-faint focus-visible:border-rose-accent/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        "field-sizing-content min-h-16 w-full resize-none rounded-md border px-3.5 py-2.5",
        "text-sm leading-relaxed transition-colors outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-rose-accent/20",
        "disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
