"use client"

import { GlassCard } from "@/components/ui/glass-card"
import { motion } from "framer-motion"
import { Star } from "lucide-react"

const testimonials = [
    {
        quote: "OpenLance changed how we hire. The quality of developers is unmatched, and the escrow system gives us total peace of mind.",
        author: "Sarah Chen",
        role: "CTO at TechFlow",
        rating: 5,
    },
    {
        quote: "Finally, a platform that respects freelancers. The secure payments and instant payouts are a game changer for my business.",
        author: "James Wilson",
        role: "Senior Full Stack Dev",
        rating: 5,
    },
    {
        quote: "We built our entire MVP with a team from OpenLance. The transparency and speed were incredible. Highly recommended!",
        author: "Elena Rodriguez",
        role: "Founder, StartUpX",
        rating: 5,
    },
    {
        quote: "The best freelancing experience I've had in 10 years. No hidden fees, great clients, and a beautiful interface.",
        author: "Michael Chang",
        role: "UI/UX Designer",
        rating: 5,
    },
]

export function Testimonials() {
    return (
        <section className="py-24 bg-slate-950 overflow-hidden">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 mb-16 text-center">
                <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl mb-4">
                    Trusted by <span className="text-violet-400">industry leaders</span>
                </h2>
            </div>

            <div className="relative flex overflow-hidden">
                {/* Gradients to fade edges */}
                <div className="absolute left-0 top-0 bottom-0 w-20 bg-gradient-to-r from-slate-950 to-transparent z-10" />
                <div className="absolute right-0 top-0 bottom-0 w-20 bg-gradient-to-l from-slate-950 to-transparent z-10" />

                <motion.div
                    animate={{ x: ["0%", "-50%"] }}
                    transition={{
                        duration: 40,
                        ease: "linear",
                        repeat: Infinity,
                    }}
                    className="flex gap-8 px-4"
                >
                    {/* Double the list for infinite scroll */}
                    {[...testimonials, ...testimonials].map((t, i) => (
                        <GlassCard
                            key={i}
                            className="w-[400px] flex-shrink-0 p-8"
                            hoverEffect
                        >
                            <div className="flex gap-1 mb-4 text-amber-400">
                                {[...Array(t.rating)].map((_, i) => (
                                    <Star key={i} className="h-4 w-4 fill-current" />
                                ))}
                            </div>
                            <blockquote className="text-slate-300 text-lg mb-6 leading-relaxed">
                                &quot;{t.quote}&quot;
                            </blockquote>
                            <div>
                                <div className="font-semibold text-white">{t.author}</div>
                                <div className="text-sm text-slate-500">{t.role}</div>
                            </div>
                        </GlassCard>
                    ))}
                </motion.div>
            </div>
        </section>
    )
}
