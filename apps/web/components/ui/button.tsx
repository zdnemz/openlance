import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Pixel button — a notched frame, a bevel and a 4px slab (see `.pixel-btn` in
 * globals.css). Face / frame / slab colors are three custom properties, so a
 * variant is just a palette. The label is Press Start 2P: keep it to a few
 * words. `ghost` and `link` are flat on purpose — they are not the action.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2.5 whitespace-nowrap font-display uppercase leading-none outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-offset-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "pixel-btn text-white",
        destructive: "pixel-btn text-white [--pb:#b91c1c] [--pf:#fca5a5] [--ps:#450a0a]",
        outline: "pixel-btn text-foreground [--pb:#14141b] [--pf:var(--color-line-strong)] [--ps:#000]",
        secondary: "pixel-btn text-foreground [--pb:#1f1f2a] [--pf:#52525b] [--ps:#000]",
        ghost: "pixel-press border-2 border-transparent text-dim hover:border-line-strong hover:bg-white/5 hover:text-foreground",
        link: "pixel-press text-rose-light underline decoration-2 underline-offset-4 hover:text-white",
      },
      size: {
        default: "min-h-11 px-4 py-3 text-[12px]",
        sm: "min-h-9 px-3 py-2 text-[11px]",
        lg: "min-h-12 px-6 py-3.5 text-[13px]",
        icon: "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
