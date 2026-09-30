/**
 * The Drafts section must render for a signed-in client.
 *
 * Getting to that assertion takes two detours worth recording, because both
 * produced a FAILING test for a screen that was actually fine:
 *
 *  1. Seeding the zustand store with `setState` and rendering showed the section
 *     missing. `renderToStaticMarkup` reads a store through React's SERVER
 *     snapshot, where the persisted session is always null. Correct React
 *     behaviour — the store genuinely has not read localStorage on a server.
 *  2. `useSessionHydrated` is a `useSyncExternalStore` over `hasHydrated()`, and
 *     under static render React always takes the server snapshot, which is
 *     `false` by design. So the dashboard's hydration gate can never open in a
 *     plain render, no matter what the store holds.
 *
 * Neither is an app bug. To observe the state a BROWSER is in once the session
 * has loaded, `useSessionHydrated` is overridden for this file only — a stand-in
 * that reports "hydrated" when told to. Everything else is the real component,
 * the real store and the real query cache.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

/* eslint-disable @typescript-eslint/no-require-imports -- the overrides below
   install into `require.cache` BEFORE the page module is loaded, which static
   `import` hoisting would make impossible. */
const sessionPath = require.resolve('@/lib/session')
const real = require(sessionPath)
let forceHydrated = false

type SessionUser = { role: string; walletAddress: string }
type SessionSlice = { token: string | null; user: SessionUser | null; boundAddress: string | null }

/**
 * The component imports `useSession` straight from this module, so the override
 * has to live here — not in a local wrapper. A static render resolves the store
 * through React's server snapshot (null, by design), so `useSession` is swapped
 * for one that reads the live store: the state a hydrated browser is in.
 */
const store = real.useSession as unknown as {
  getState: () => unknown
  setState: (p: unknown) => void
  subscribe: (cb: (s: unknown, p: unknown) => void) => () => void
  persist?: unknown
}
const useSessionOverridden = Object.assign(
  (sel?: (s: unknown) => unknown) => (sel ? sel(store.getState()) : store.getState()),
  { getState: store.getState, setState: store.setState, subscribe: store.subscribe, persist: store.persist },
)

require.cache[sessionPath] = {
  ...real,
  id: sessionPath,
  filename: sessionPath,
  loaded: true,
  exports: { ...real, useSession: useSessionOverridden, useSessionHydrated: () => forceHydrated },
} as never

const navPath = require.resolve('next/navigation')
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    useRouter: () => ({ push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} }),
    usePathname: () => '/dashboard',
    useSearchParams: () => new URLSearchParams(),
  },
} as never

const { default: DashboardPage } = require('../app/(app)/dashboard/page.tsx') as { default: (p: never) => never }

// Mutate the real store (a zustand hook, which carries setState); the
// overridden `useSession` reads it.
function signIn(role: string | null) {
  store.setState(
    role === null
      ? { token: null, user: null, boundAddress: null }
      : { token: TOKEN, user: { ...USER, role }, boundAddress: USER.walletAddress },
  )
}

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`✓ ${n}`) } else { fail++; console.log(`✗ ${n}${d ? ` — ${d}` : ''}`) }
}

const USER: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  walletAddress: '0x00000000000000000000000000000000da5730ff',
  displayName: 'Check Client',
  role: 'client',
  kycStatus: 'verified',
  isAdmin: false,
  stats: { totalPaidWei: '0', totalEarnedWei: '0' },
} as unknown as SessionUser

// Never verified against the API — the component only branches on it being
// non-empty, so a literal keeps this check runnable with no devnet, no wallet
// and no database.
const TOKEN = 'check.token.not.verified'

// Shaped exactly like the API's `jobView` for a draft, since that is the shape
// the query cache holds and the section renders.
const DRAFT = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: null,
  jobRef: '0x00',
  title: 'ZZDRAFT fixture',
  description: 'Fixture.',
  category: 'backend',
  skills: [],
  status: 'draft',
  budget: { maxWei: '500000000000000000', maxEth: '0.5' },
  deposit: null,
  publishedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
}

function cache() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['jobs', { status: 'draft' }], { items: [DRAFT], total: 1 })
  qc.setQueryData(['jobs', {}], { items: [], total: 0 })
  qc.setQueryData(['projects'], [])
  qc.setQueryData(['disputes'], [])
  qc.setQueryData(['ledger', { limit: '8' }], { items: [], total: 0 })
  qc.setQueryData(['arbiters'], [])
  return qc
}

function render() {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: cache() }, createElement(DashboardPage as never)),
  )
}

function main() {
  // ── before the session loads ────────────────────────────────────────────
  signIn(null)
  forceHydrated = false
  const loading = render()
  check('an unhydrated session does not paint the signed-out card', !loading.includes('Your dashboard lives behind your key'), 'signed-out card was server-rendered')
  check('an unhydrated session holds a stable skeleton', loading.includes('aria-busy="true"'), 'no busy placeholder')

  // ── signed in as a client, with a real draft ────────────────────────────
  signIn(USER.role)
  forceHydrated = true
  const html = render()
  check('the Drafts heading renders for a client', html.includes('Drafts'), html.slice(0, 260))
  check("the draft's title renders", html.includes(DRAFT.title), DRAFT.title)
  check('it states the budget still has to be locked', html.includes('ETH to publish'))
  check('it links into the draft', html.includes(`/jobs/${DRAFT.id}`))
  check('it says the draft is unpublished', /unpublished/i.test(html))

  // ── seat isolation ──────────────────────────────────────────────────────
  for (const role of ['freelancer', 'arbiter'] as const) {
    signIn(role)
    const other = render()
    check(`a ${role} does not see the client drafts section`, !other.includes('ETH to publish'))
    check(`a ${role} still gets their own dashboard`, !other.includes('Your dashboard lives behind your key'))
  }

  // ── no drafts, no section (and no broken layout) ────────────────────────
  signIn(USER.role)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['jobs', { status: 'draft' }], { items: [], total: 0 })
  qc.setQueryData(['jobs', {}], { items: [], total: 0 })
  qc.setQueryData(['projects'], [])
  qc.setQueryData(['disputes'], [])
  qc.setQueryData(['ledger', { limit: '8' }], { items: [], total: 0 })
  qc.setQueryData(['arbiters'], [])
  const empty = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(DashboardPage as never)),
  )
  check('a client with no drafts gets no empty Drafts section', !empty.includes('Drafts'))
  check('and still sees their dashboard', !empty.includes('Your dashboard lives behind your key'))

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
/* eslint-enable @typescript-eslint/no-require-imports */
