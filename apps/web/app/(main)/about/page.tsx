import { GlassCard } from "@/components/ui/glass-card"

export default function AboutPage() {
    return (
        <div className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            <div className="text-center mb-16">
                <h1 className="text-4xl sm:text-6xl font-bold text-white mb-6">
                    We are <span className="text-violet-400">OpenLance</span>
                </h1>
                <p className="max-w-2xl mx-auto text-xl text-slate-400">
                    Reimagining the future of work through transparency, security, and decentralized trust.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-20">
                <GlassCard className="p-10">
                    <h2 className="text-2xl font-bold text-white mb-4">Our Mission</h2>
                    <p className="text-slate-300 leading-relaxed">
                        To empower the world&apos;s best talent and visionary companies to build together without borders, friction, or mistrust. We believe in a future where meritocracy rules and payment is guaranteed.
                    </p>
                </GlassCard>
                <GlassCard className="p-10">
                    <h2 className="text-2xl font-bold text-white mb-4">The Problem</h2>
                    <p className="text-slate-300 leading-relaxed">
                        Traditional freelancing platforms are plagued by high fees, opaque algorithms, and lack of trust. Disputes are common, and &quot;middlemen&quot; take a huge cut for little value.
                    </p>
                </GlassCard>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
                {[
                    { label: "Founded", value: "2026" },
                    { label: "Team Size", value: "25+" },
                    { label: "Countries", value: "40+" },
                ].map((stat) => (
                    <div key={stat.label}>
                        <div className="text-4xl font-bold text-white mb-2">{stat.value}</div>
                        <div className="text-slate-500">{stat.label}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}
