import { GlassCard } from "@/components/ui/glass-card"
import { Briefcase, Search, ShieldCheck, CreditCard } from "lucide-react"

const steps = [
    {
        title: "Post a Job",
        description: "Describe your project, budget, and timeline. Get matched with top talent in minutes.",
        icon: Briefcase,
    },
    {
        title: "Hire Talent",
        description: "Review proposals, check portfolios, and chat with candidates. Hire the best fit with one click.",
        icon: Search,
    },
    {
        title: "Work Securely",
        description: "Manage the project with built-in milestones. Funds are held in escrow until you're satisfied.",
        icon: ShieldCheck,
    },
    {
        title: "Pay & Rate",
        description: "Release funds when the work is done. Rate your experience to help build trust in the community.",
        icon: CreditCard,
    },
]

export default function HowItWorksPage() {
    return (
        <div className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            <div className="text-center mb-16">
                <h1 className="text-4xl sm:text-6xl font-bold text-white mb-6">
                    How <span className="text-violet-400">OpenLance</span> Works
                </h1>
                <p className="max-w-2xl mx-auto text-xl text-slate-400">
                    The easiest way to get work done, from posting a job to final payment.
                </p>
            </div>

            <div className="relative">
                    {/* Connecting Line (Desktop) */}
                <div className="hidden md:block absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent transform -translate-x-1/2" />

                <div className="space-y-12 md:space-y-0">
                    {steps.map((step, i) => (
                        <div key={step.title} className={`flex flex-col md:flex-row items-center gap-8 ${i % 2 === 0 ? 'md:flex-row-reverse' : ''}`}>
                            <div className="flex-1 md:text-right w-full">
                                <div className={`hidden md:block ${i % 2 === 0 ? 'text-left pr-12' : 'text-right pl-12'}`}>
                                    {/* Spacer for alternating layout */}
                                </div>
                            </div>
                            
                            {/* Icon Bubble */}
                            <div className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full bg-slate-900 border border-white/10 shadow-xl ring-8 ring-slate-950">
                                <step.icon className="h-8 w-8 text-cyan-400" />
                            </div>

                            <div className="flex-1 w-full">
                                <GlassCard className={`p-8 ${i % 2 === 0 ? 'md:mr-auto' : 'md:ml-auto'} max-w-md mx-auto md:mx-0`}>
                                    <h3 className="text-xl font-bold text-white mb-2">{i + 1}. {step.title}</h3>
                                    <p className="text-slate-400">{step.description}</p>
                                </GlassCard>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
