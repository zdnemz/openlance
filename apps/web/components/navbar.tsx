"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion, useScroll, useTransform } from "framer-motion"
import { Menu, X, Code2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function Navbar() {
  const [isOpen, setIsOpen] = React.useState(false)
  const pathname = usePathname()
  const { scrollY } = useScroll()

  // Transform background opacity based on scroll
  const bgOpacity = useTransform(scrollY, [0, 100], [0, 0.8])
  const backdropBlur = useTransform(scrollY, [0, 100], ["0px", "12px"])
  const borderOpacity = useTransform(scrollY, [0, 100], [0, 0.1])

  const navLinks = [
    { name: "Find Talent", href: "/talent" },
    { name: "Find Work", href: "/work" },
    { name: "Why OpenLance", href: "/about" },
    { name: "Enterprise", href: "/enterprise" },
  ]

  return (
    <motion.nav
      style={{
        backgroundColor: `rgba(var(--background-rgb), ${bgOpacity})`, // Dynamic background with CSS var
        backdropFilter: `blur(${backdropBlur})`, // Dynamic blur
        borderColor: `rgba(255, 255, 255, ${borderOpacity})`,
      }}
      className="fixed top-0 left-0 right-0 z-50 border-b border-transparent transition-colors duration-300"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-violet-600 to-cyan-400 text-white shadow-lg transition-transform group-hover:scale-105">
              <Code2 className="h-5 w-5" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white dark:text-white text-slate-900">
              Open<span className="text-cyan-400">Lance</span>
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className={cn(
                  "text-sm font-medium transition-colors hover:text-cyan-400",
                  pathname === link.href ? "text-cyan-400" : "text-slate-500 dark:text-slate-300"
                )}
              >
                {link.name}
              </Link>
            ))}
          </div>

          {/* Actions */}
          <div className="hidden md:flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost" size="sm" className="hidden lg:inline-flex text-slate-300 hover:text-white font-medium">
                Log In
              </Button>
            </Link>
            <Link href="/signup">
              <Button variant="primary" size="sm" className="font-semibold px-6">
                Sign Up
              </Button>
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <div className="flex md:hidden">
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="text-slate-300 hover:text-white p-2"
            >
              {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="md:hidden glass-nav absolute top-16 left-0 right-0 border-b border-white/10 px-4 py-4 backdrop-blur-xl"
        >
          <div className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className="text-base font-medium text-slate-300 hover:text-cyan-400"
                onClick={() => setIsOpen(false)}
              >
                {link.name}
              </Link>
            ))}
            <div className="h-px bg-white/10 my-2" />
            <Link href="/login" onClick={() => setIsOpen(false)}>
              <Button variant="ghost" className="w-full justify-start text-slate-300 font-medium">
                Log In
              </Button>
            </Link>
            <Link href="/signup" onClick={() => setIsOpen(false)}>
              <Button variant="primary" className="w-full font-semibold">
                Sign Up
              </Button>
            </Link>
          </div>
        </motion.div>
      )}
    </motion.nav>
  )
}
