"use client"

import { GlassCard } from "@/components/ui/glass-card"
import { ShieldCheck, Zap, Globe, MessageSquare, Scale } from "lucide-react"
import { motion } from "framer-motion"

const features = [
    {
        title: "Secure Escrow Payments",
        description: "Funds are held safely until milestones are approved. No more chasing invoices. Your money is safe.",
        icon: ShieldCheck,
        color: "text-emerald-400",
        className: "md:col-span-2 md:row-span-2",
    },
    {
        title: "Global Talent Pool",
        description: "Access top 1% developers from 150+ countries. Rigorously vetted for technical excellence.",
        icon: Globe,
        color: "text-blue-400",
        className: "md:col-span-1 md:row-span-1",
    },
    {
        title: "Fast Payouts",
        description: "Withdraw earnings instantly to your preferred local bank account or wallet.",
        icon: Zap,
        color: "text-amber-400",
        className: "md:col-span-1 md:row-span-1",
    },
    {
        title: "Standard Contracts",
        description: "Industry-standard legal agreements generated automatically for every project scope.",
        icon: Scale,
        color: "text-violet-400",
        className: "md:col-span-1 md:row-span-2",
    },
    {
        title: "Real-time Chat",
        description: "End-to-end encrypted messaging with file sharing and video calls built right in.",
        icon: MessageSquare,
        color: "text-pink-400",
        className: "md:col-span-2 md:row-span-1",
    },
]

export function Features() {
    return (
        <section id="features" className="relative py-32 bg-slate-950">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="mb-20 text-center">
                    <motion.h2
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="text-3xl font-bold tracking-tight text-white sm:text-5xl mb-4"
                    >
                        Everything you need to <span className="text-cyan-400">scale</span>
                    </motion.h2>
                    <motion.p
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.1 }}
                        className="mx-auto max-w-2xl text-lg text-slate-400"
                    >
                        Powerful tools for modern freelancing, built into one seamless platform.
                    </motion.p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 auto-rows-[250px]">
                    {features.map((feature, i) => (
                        <GlassCard
                            key={feature.title}
                            className={`group relative flex flex-col justify-between p-8 ${feature.className}`}
                            hoverEffect
                            glow
                            initial={{ opacity: 0, scale: 0.95 }}
                            whileInView={{ opacity: 1, scale: 1 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.1, duration: 0.5 }}
                        >
                            <div className="relative z-10">
                                <div className={`mb-4 inline-flex rounded-xl bg-white/5 p-3 ${feature.color}`}>
                                    <feature.icon className="h-8 w-8" />
                                </div>
                                <h3 className="text-xl font-bold text-white mb-2 group-hover:text-cyan-400 transition-colors">
                                    {feature.title}
                                </h3>
                                <p className="text-slate-400 text-sm leading-relaxed">
                                    {feature.description}
                                </p>
                            </div>

                            {/* Decoration */}
                            <div className="absolute bottom-0 right-0 opacity-5 group-hover:opacity-10 transition-opacity duration-500">
                                <feature.icon className="h-48 w-48 -rotate-12 translate-x-12 translate-y-12" />
                            </div>
                        </GlassCard>
                    ))}
                </div>
            </div>
        </section>
    )
}
