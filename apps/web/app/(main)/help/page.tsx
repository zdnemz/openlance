"use client"

import { GlassCard } from "@/components/ui/glass-card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search, FileText, CreditCard, User, Shield, HelpCircle, ChevronRight } from "lucide-react"
import Link from "next/link"

const categories = [
  { icon: User, title: "Account & Profile", count: 12 },
  { icon: FileText, title: "Projects & Contracts", count: 8 },
  { icon: CreditCard, title: "Payments & Billing", count: 15 },
  { icon: Shield, title: "Trust & Safety", count: 5 },
]

const faqs = [
  {
    question: "How does the Escrow system work?",
    answer: "Funds are held securely in a neutral account until the agreed-upon milestones are met and approved by the client. This protects both parties.",
  },
  {
    question: "What are the service fees?",
    answer: "OpenLance charges a flat 10% fee on all contracts. There are no hidden fees or subscription costs for basic usage.",
  },
  {
    question: "How do I verify my identity?",
    answer: "Go to Settings > Verification and upload a government-issued ID. Verification typically takes less than 24 hours.",
  },
  {
    question: "Can I dispute a contract?",
    answer: "Yes, if mediation fails, you can file a dispute. Our support team will review all evidence and make a binding decision.",
  },
]

export default function HelpCenter() {
  return (
    <>
      <div className="relative pt-32 pb-20 px-4 sm:px-6 lg:px-8 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-violet-900/20 via-slate-950 to-slate-950">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl font-bold text-white mb-6">How can we help?</h1>
          <div className="relative">
            <Search className="absolute left-3 top-3 h-5 w-5 text-slate-500" />
            <Input 
              placeholder="Search for answers..." 
              className="pl-10 h-14 text-lg rounded-2xl bg-white/5 border-white/10 focus:bg-white/10 hover:bg-white/10"
            />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
          {categories.map((cat) => (
            <GlassCard key={cat.title} hoverEffect className="flex flex-col items-center text-center p-6 group cursor-pointer">
              <div className="h-12 w-12 rounded-full bg-violet-500/10 flex items-center justify-center mb-4 text-violet-400 group-hover:scale-110 transition-transform">
                <cat.icon className="h-6 w-6" />
              </div>
              <h3 className="font-semibold text-white mb-1">{cat.title}</h3>
              <p className="text-sm text-slate-500">{cat.count} articles</p>
            </GlassCard>
          ))}
        </div>

        <div className="max-w-3xl mx-auto mb-20">
          <h2 className="text-2xl font-bold text-white mb-8">Frequently Asked Questions</h2>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <GlassCard key={i} className="p-0 overflow-hidden">
                <details className="group">
                  <summary className="flex items-center justify-between p-6 cursor-pointer list-none">
                    <span className="font-medium text-white">{faq.question}</span>
                    <ChevronRight className="h-5 w-5 text-slate-500 transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="px-6 pb-6 text-slate-400 leading-relaxed border-t border-white/5 pt-4">
                    {faq.answer}
                  </div>
                </details>
              </GlassCard>
            ))}
          </div>
        </div>

        <GlassCard className="max-w-4xl mx-auto p-12 text-center bg-gradient-to-br from-violet-900/10 to-cyan-900/10 border-violet-500/20">
          <HelpCircle className="h-12 w-12 text-white mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-white mb-4">Still need support?</h2>
          <p className="text-slate-400 mb-8 max-w-xl mx-auto">
            Our support team is available 24/7 to help you with any issues regarding contracts, payments, or account disputes.
          </p>
          <div className="flex justify-center gap-4">
            <Button>Chat with Support</Button>
            <Link href="mailto:support@openlance.com">
               <Button variant="glass">Email Us</Button>
            </Link>
          </div>
        </GlassCard>
      </div>
    </>
  )
}
