import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Multi-line input for prose the app stores and later shows to the other side:
 * a job brief, a cover note, delivery notes, a dispute reason.
 *
 * It carries the house style itself rather than leaving it to call sites —
 * the same recessed `pixel-well` surface, border and focus treatment as
 * `Input` — so a textarea sitting under a text field is not visibly a different
 * control. Call sites override only what genuinely differs, usually a smaller
 * measure for a compact row.
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
        "pixel-well placeholder:text-faint focus-visible:border-rose-light",
        "aria-invalid:border-destructive",
        "field-sizing-content min-h-20 w-full resize-none px-3.5 py-2.5",
        "text-base leading-relaxed transition-colors outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
