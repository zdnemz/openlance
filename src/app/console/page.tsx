'use client'

/**
 * OpenLance — Backend Console.
 *
 * The product frontend arrives in a later build phase; this page is the live
 * window into the backend-first deliverable (Next.js route handlers on /api): health,
 * adapter modes, seeded demo project, the on-chain ledger mirror, arbiter
 * trust scores, and the API surface. All requests are same-origin `/api` calls
 * served by this Next.js app's route handlers.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Activity, ArrowUpRight, Blocks, Boxes, Coins, Database, FileText, Gauge, HardDrive,
  Layers, Link2, MessageSquare, Radio, ServerCog, ShieldCheck, Star, Users, Wallet, Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const API_PORT = 3030
/** Backend now runs in the same Next.js app under /api (same-origin). */
const GW = (path: string) => `/api/${path.replace(/^\//, '')}`

async function fetchApi(path: string): Promise<Response> {
  return fetch(GW(path), { cache: 'no-store' })
}

// ── Types (mirror the API's /overview response) ────────────────────────────
interface Overview {
  service: string
  config: {
    chainMode: string; chainId: number; feeBps: number; dbDriver: string
    storageDriver: string; queueMode: string
    contracts: { escrow: string; arbiterRegistry: string }
  }
  counts: { users: number; jobs: number; projects: number; proposals: number; messages: number; reviews: number; ledgerEvents: number }
  milestoneHistogram: Record<string, number>
  arbiters: { address: string; registered: boolean; sbtTokenId: number | null; trustScore: number; resolutions: number; resolutionsWithinSla: number; resolutionsLate: number }[]
  latestLedger: { id: number; eventType: string; blockNumber: number; blockTime: string; txHash: string; payload: Record<string, unknown> }[]
  demoProject: {
    id: string; status: string; createdAt: string
    client: { displayName: string | null; walletAddress: string } | null
    freelancer: { displayName: string | null; walletAddress: string } | null
    milestones: { id: string; position: number; title: string; amountWei: string; chainStatus: string; softStatus: string | null; settlementTxHash: string | null }[]
  } | null
}

const ETH = (wei: string) => {
  try { return (Number(BigInt(wei)) / 1e18).toFixed(2) } catch { return '0' }
}
const short = (s: string, n = 10) => s ? `${s.slice(0, n)}…${s.slice(-4)}` : ''
const shortAddr = (a: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

const CHAIN_STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending_funding: { label: 'Pending funding', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/25' },
  funded: { label: 'Funded', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25' },
  submitted: { label: 'Submitted', className: 'bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/25' },
  released: { label: 'Released', className: 'bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 border-emerald-600/30' },
  disputed: { label: 'Disputed', className: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/25' },
  resolved_release: { label: 'Resolved · release', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25' },
  resolved_refund: { label: 'Resolved · refund', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25' },
  resolved_split: { label: 'Resolved · split', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25' },
  cancelled: { label: 'Cancelled', className: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400 border-zinc-500/25' },
}

const EVENT_ICON: Record<string, typeof Coins> = {
  MilestoneFunded: Coins, MilestoneReleased: Zap, MilestoneSubmitted: FileText,
  MilestoneSplit: Layers, MilestoneRefunded: ArrowUpRight, MilestoneCancelled: ArrowUpRight,
  DisputeOpened: ShieldCheck, DisputeResolved: ShieldCheck, FeeWithdrawn: Coins,
  ArbiterRegistered: Star, ArbiterDeregistered: Star, TrustScoreUpdated: Star,
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${ok
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400'}`}>
      <span className={`size-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`} aria-hidden />
      {label}
    </span>
  )
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string | number; sub?: string }) {
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-medium tracking-wide uppercase">{label}</span>
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </Card>
  )
}

const API_GROUPS: { title: string; icon: typeof ServerCog; rows: [string, string][] }[] = [
  { title: 'Auth & identity (SIWE)', icon: Wallet, rows: [
    ['POST /auth/nonce', 'single-use nonce (KV, TTL)'],
    ['POST /auth/verify', 'EIP-4361 verify → Supabase-compatible JWT'],
    ['GET /auth/me', 'profile + on-chain-derived stats'],
  ] },
  { title: 'Marketplace (F1–F2)', icon: Blocks, rows: [
    ['POST /jobs', 'milestone template sum validated server-side'],
    ['POST /jobs/:id/proposals', 'one per freelancer, own breakdown'],
    ['POST /proposals/:id/accept', 'bridge event → project + milestones'],
  ] },
  { title: 'Collaboration (F6–F8)', icon: MessageSquare, rows: [
    ['POST /projects/:id/messages', 'append-only evidence log + realtime'],
    ['POST /projects/:id/attachments', 'signed upload, 25MB + MIME allowlist'],
    ['POST …/milestones/:mid/submissions', 'off-chain record + on-chain flip'],
  ] },
  { title: 'Money & trust (F4–F14)', icon: ShieldCheck, rows: [
    ['GET /projects/:id/milestones', 'mirror + fund tx hints (ref bytes32)'],
    ['POST /milestones/:id/reviews', 'settlement re-verified via RPC'],
    ['POST …/disputes → /disputes/:id/arbiter-proposal', '48h mutual agreement window'],
    ['GET /ledger · GET /arbiters', 'event-sourced cache + SBT scores'],
  ] },
  { title: 'Platform (F9)', icon: Radio, rows: [
    ['POST /webhooks', 'HMAC-signed, 5-attempt backoff'],
    ['POST /admin/reconcile', 'mirror-vs-chain drift report'],
    ['/dev/chain/*', 'mock chain (drives the real indexer; dev only)'],
  ] },
]

export default function BackendConsole() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetchApi('overview')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()).data as Overview)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unreachable')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [refresh])

  const online = !error && !!data

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8">
        {/* ── Header ── */}
        <header className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-xl bg-emerald-600/15 border border-emerald-600/25 grid place-items-center">
                <ShieldCheck className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">OpenLance · Backend Console</h1>
                <p className="text-sm text-muted-foreground">Milestone escrow marketplace — backend-first build (Hono · Supabase-compatible Postgres · Redis · viem)</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill ok={online} label={online ? 'API online' : 'API offline'} />
              {data ? (
                <>
                  <Badge variant="outline" className="font-mono">chain {data.config.chainMode}</Badge>
                  <Badge variant="outline" className="font-mono">fee {data.config.feeBps / 100}%</Badge>
                </>
              ) : null}
            </div>
          </div>

          {data ? (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Database className="size-3.5" aria-hidden />{data.config.dbDriver === 'pglite' ? 'embedded Postgres (PGlite)' : 'external Postgres'}</span>
              <Separator orientation="vertical" className="h-3.5" />
              <span className="inline-flex items-center gap-1.5"><Zap className="size-3.5" aria-hidden />queue: {data.config.queueMode}</span>
              <Separator orientation="vertical" className="h-3.5" />
              <span className="inline-flex items-center gap-1.5"><HardDrive className="size-3.5" aria-hidden />storage: {data.config.storageDriver}</span>
              <Separator orientation="vertical" className="h-3.5" />
              <span className="inline-flex items-center gap-1.5"><Link2 className="size-3.5" aria-hidden />chainId {data.config.chainId}</span>
              <Separator orientation="vertical" className="h-3.5" />
              <span className="inline-flex items-center gap-1.5 font-mono">{short(data.config.contracts.escrow, 12)}</span>
            </div>
          ) : null}

          {loaded && error ? (
            <Card className="border-rose-500/30 bg-rose-500/5">
              <CardContent className="p-4 text-sm text-rose-700 dark:text-rose-400">
                Backend unreachable ({error}). Start it with <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">bun run dev</code> and ensure <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">DATABASE_URL</code> is set, then this console refreshes automatically.
              </CardContent>
            </Card>
          ) : null}
        </header>

        {/* ── Stats ── */}
        <section aria-label="Platform statistics" className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {data ? (
            <>
              <StatCard icon={Users} label="Users" value={data.counts.users} sub="wallet identities" />
              <StatCard icon={Blocks} label="Jobs" value={data.counts.jobs} />
              <StatCard icon={Boxes} label="Projects" value={data.counts.projects} />
              <StatCard icon={FileText} label="Proposals" value={data.counts.proposals} />
              <StatCard icon={MessageSquare} label="Messages" value={data.counts.messages} />
              <StatCard icon={Star} label="Reviews" value={data.counts.reviews} sub="settlement-bound" />
              <StatCard icon={Activity} label="Ledger events" value={data.counts.ledgerEvents} sub="from chain events" />
            </>
          ) : (
            Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          )}
        </section>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* ── Demo project ── */}
          <section aria-label="Demo project" className="lg:col-span-3 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Gauge className="size-4 text-emerald-600" aria-hidden />Demo project</CardTitle>
                <CardDescription>
                  {data?.demoProject
                    ? <>Client <strong>{data.demoProject.client?.displayName ?? shortAddr(data.demoProject.client?.walletAddress ?? '')}</strong> × freelancer <strong>{data.demoProject.freelancer?.displayName ?? shortAddr(data.demoProject.freelancer?.walletAddress ?? '')}</strong> — status <Badge variant="secondary" className="ml-1">{data.demoProject.status}</Badge></>
                    : 'The seeded project and its milestone state machine.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data?.demoProject ? (
                  <ol className="space-y-3">
                    {data.demoProject.milestones.map((m) => {
                      const st = CHAIN_STATUS_STYLES[m.chainStatus] ?? { label: m.chainStatus, className: 'bg-muted text-muted-foreground border-border' }
                      return (
                        <li key={m.id} className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="grid place-items-center size-6 rounded-md bg-muted text-xs font-semibold">{m.position}</span>
                              <span className="font-medium truncate">{m.title}</span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {ETH(m.amountWei)} ETH{m.settlementTxHash ? <> · settled <span className="font-mono">{short(m.settlementTxHash, 8)}</span></> : null}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {m.softStatus === 'changes_requested' ? <Badge variant="outline">changes requested</Badge> : null}
                            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${st.className}`}>{st.label}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                ) : (
                  <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
                )}
              </CardContent>
            </Card>

            {/* ── Ledger ── */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-emerald-600" aria-hidden />On-chain ledger <span className="text-muted-foreground font-normal text-sm">(event-sourced cache)</span></CardTitle>
                <CardDescription>Every money movement, derived from chain events. Each row links to the explorer tx.</CardDescription>
              </CardHeader>
              <CardContent>
                {data ? (
                  <div className="max-h-96 overflow-y-auto rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur">
                        <TableRow>
                          <TableHead className="w-8" aria-label="icon" />
                          <TableHead>Event</TableHead>
                          <TableHead className="text-right">Block</TableHead>
                          <TableHead className="hidden sm:table-cell">Tx</TableHead>
                          <TableHead className="hidden md:table-cell text-right">When</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.latestLedger.length === 0 ? (
                          <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No chain events yet — fund a milestone via /dev/chain.</TableCell></TableRow>
                        ) : data.latestLedger.map((e) => {
                          const Icon = EVENT_ICON[e.eventType] ?? Activity
                          return (
                            <TableRow key={e.id}>
                              <TableCell><Icon className="size-3.5 text-muted-foreground" aria-hidden /></TableCell>
                              <TableCell className="font-medium font-mono text-xs">{e.eventType}</TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">{e.blockNumber.toLocaleString()}</TableCell>
                              <TableCell className="hidden sm:table-cell font-mono text-xs text-muted-foreground">{short(e.txHash, 10)}</TableCell>
                              <TableCell className="hidden md:table-cell text-right text-xs text-muted-foreground">{new Date(e.blockTime).toLocaleTimeString()}</TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <Skeleton className="h-64 rounded-md" />
                )}
              </CardContent>
            </Card>
          </section>

          {/* ── Sidebar: arbiters + histogram ── */}
          <section aria-label="Trust layer" className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-emerald-600" aria-hidden />Arbiter registry <span className="text-muted-foreground font-normal text-sm">(SBT)</span></CardTitle>
                <CardDescription>ERC-5194 soulbound trust: +1 per resolution within SLA, −2 late. Pure function of history.</CardDescription>
              </CardHeader>
              <CardContent>
                {data ? (
                  data.arbiters.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No arbiters registered yet.</p>
                  ) : (
                    <ul className="space-y-3">
                      {data.arbiters.map((a) => (
                        <li key={a.address} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                          <div className="min-w-0">
                            <div className="font-mono text-xs truncate">{shortAddr(a.address)}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              SBT #{a.sbtTokenId ?? '—'} · {a.resolutions} resolution{a.resolutions === 1 ? '' : 's'}
                              {a.resolutionsLate > 0 ? <span className="text-rose-600 dark:text-rose-400"> · {a.resolutionsLate} late</span> : null}
                            </div>
                          </div>
                          <div className="flex flex-col items-end">
                            <span className="text-lg font-semibold tabular-nums leading-none">{a.trustScore}</span>
                            <span className={`text-[10px] ${a.registered ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>{a.registered ? 'active' : 'deregistered'}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )
                ) : <Skeleton className="h-32 rounded-lg" />}
              </CardContent>
            </Card>

            {data ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Milestone states</CardTitle>
                  <CardDescription>Histogram across all project milestones.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {Object.entries(data.milestoneHistogram).map(([k, v]) => {
                    const st = CHAIN_STATUS_STYLES[k] ?? { label: k, className: 'bg-muted text-muted-foreground border-border' }
                    const max = Math.max(...Object.values(data.milestoneHistogram), 1)
                    return (
                      <div key={k} className="flex items-center gap-3 text-xs">
                        <span className="w-32 shrink-0 text-muted-foreground">{st.label}</span>
                        <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-emerald-600/70" style={{ width: `${(v / max) * 100}%` }} />
                        </div>
                        <span className="w-6 text-right tabular-nums font-medium">{v}</span>
                      </div>
                    )
                  })}
                  {Object.keys(data.milestoneHistogram).length === 0 ? <p className="text-sm text-muted-foreground">No milestones yet.</p> : null}
                </CardContent>
              </Card>
            ) : null}
          </section>
        </div>

        {/* ── API reference ── */}
        <section aria-label="API reference">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><ServerCog className="size-4 text-emerald-600" aria-hidden />API surface <span className="text-muted-foreground font-normal text-sm">— what the frontend will build against</span></CardTitle>
              <CardDescription>
                Full walkthrough in <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">src/app/api/**</code>. Golden path E2E: <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">bash scripts/anvil/run-anvil-e2e.sh</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
              {API_GROUPS.map((g) => (
                <div key={g.title} className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><g.icon className="size-4 text-emerald-600" aria-hidden />{g.title}</h3>
                  <ul className="space-y-2">
                    {g.rows.map(([route, desc]) => (
                      <li key={route} className="text-xs leading-relaxed">
                        <code className="font-mono bg-muted px-1.5 py-0.5 rounded">{route}</code>
                        <span className="text-muted-foreground"> — {desc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="mt-auto border-t bg-muted/30">
        <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-5 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <span>OpenLance — portfolio build, testnet only. On-chain = money + commitments + trust; off-chain = content + velocity.</span>
          <span className="font-mono">Next.js route handlers · /api</span>
        </div>
      </footer>
    </div>
  )
}
