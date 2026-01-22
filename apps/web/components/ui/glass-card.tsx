"use client"

import { cn } from "@/lib/utils"
import { motion, HTMLMotionProps } from "framer-motion"

interface GlassCardProps extends HTMLMotionProps<"div"> {
  hoverEffect?: boolean
  glow?: boolean
}

export function GlassCard({ className, children, hoverEffect = false, glow = false, ...props }: GlassCardProps) {
  return (
    <motion.div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl shadow-xl transition-colors",
        hoverEffect && "hover:bg-white/10 hover:border-white/20 cursor-default",
        glow && "before:absolute before:-inset-full before:bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.15),transparent_70%)] before:opacity-0 hover:before:opacity-100 before:transition-opacity before:duration-500",
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
