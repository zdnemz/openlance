import { Navbar } from "@/components/navbar"
import { Footer } from "@/components/footer"

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-slate-950 selection:bg-violet-500/30 selection:text-violet-200">
        {children}
      </main>
      <Footer />
    </>
  )
}
