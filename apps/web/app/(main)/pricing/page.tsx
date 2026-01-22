import { GlassCard } from "@/components/ui/glass-card"
import { Button } from "@/components/ui/button"
import { Check } from "lucide-react"

const plans = [
    {
        name: "Freelancer Basic",
        price: "$0",
        description: "For new freelancers just starting out.",
        features: ["5 Bids per month", "Standard Profile", "5% Service Fee", "Basic Support"],
        cta: "Sign Up Free",
    },
    {
        name: "Freelancer Pro",
        price: "$15",
        period: "/mo",
        description: "For serious professionals scaling their career.",
        features: ["Unlimited Bids", "Verified Badge", "2% Service Fee", "Priority Support", "Analytics Dashboard"],
        cta: "Go Pro",
        featured: true,
    },
    {
        name: "Client Enterprise",
        price: "Custom",
        description: "For companies hiring at scale.",
        features: ["Dedicated Account Manager", "Custom Contracts", "Invoice Consolidation", "API Access", "SSO Integration"],
        cta: "Contact Sales",
    },
]

export default function PricingPage() {
    return (
        <div className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
            <div className="text-center mb-16">
                <h1 className="text-4xl sm:text-6xl font-bold text-white mb-6">
                    Simple, transparent <span className="text-cyan-400">pricing</span>
                </h1>
                <p className="max-w-2xl mx-auto text-xl text-slate-400">
                    Choose the plan that fits your needs. No hidden fees.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {plans.map((plan) => (
                    <GlassCard key={plan.name} className={`p-8 flex flex-col ${plan.featured ? 'border-cyan-400/50 shadow-cyan-900/20' : ''}`} glow={plan.featured}>
                        <div className="mb-8">
                            <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                            <div className="flex items-baseline gap-1">
                                <span className="text-4xl font-bold text-white">{plan.price}</span>
                                {plan.period && <span className="text-slate-500">{plan.period}</span>}
                            </div>
                            <p className="text-slate-400 mt-4 text-sm">{plan.description}</p>
                        </div>
                        <ul className="space-y-4 mb-8 flex-1">
                            {plan.features.map((feature) => (
                                <li key={feature} className="flex items-center gap-3 text-slate-300">
                                    <div className="h-5 w-5 rounded-full bg-cyan-500/10 flex items-center justify-center flex-shrink-0">
                                        <Check className="h-3 w-3 text-cyan-400" />
                                    </div>
                                    <span className="text-sm">{feature}</span>
                                </li>
                            ))}
                        </ul>
                        <Button variant={plan.featured ? "primary" : "glass"} className="w-full">
                            {plan.cta}
                        </Button>
                    </GlassCard>
                ))}
            </div>
        </div>
    )
}
