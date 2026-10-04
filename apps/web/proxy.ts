/**
 * Next.js proxy (formerly middleware) — all route guards live here.
 *
 * 1. Onboarding gate: every page except `/onboarding` and the public landing
 *    `/` requires the `el_onboarded=1` cookie (stamped by the auth lifecycle
 *    routes when KYC is verified — see gate cookies in apps/api/src/lib/http.ts).
 *    Unfinished users bounce to /onboarding before any page code runs.
 * 2. Landing bounce: onboarded users never see `/` again — they are sent to
 *    their seat home (/dashboard).
 * 3. Seat gate (strict): onboarded users carry a plain `el_role` hint
 *    (client / freelancer / arbiter) stamped only by JWT-verified API routes.
 *    Paths outside the seat's allowlist bounce to /dashboard — the single
 *    adaptive home every role may view. The API remains the security
 *    boundary; this is navigation shaping.
 *
 * 4. Awarded jobs: once a job has a project, `/jobs/:id` is a stale address —
 *    the work lives in the room, and the room gates its own reads. This is a
 *    server-side 307 so the job page never paints for a link the user did not
 *    mean to click (a shared bid, a notification, the back button).
 *
 * The API is a separate origin now (apps/api on :4000) and answers its own
 * CORS preflights, so there is no `/api` branch here — this app serves pages.
 *
 * The gate cookies are stamped by the API. Cross-origin that only works if
 * they share a domain: set COOKIE_DOMAIN on the API in production
 * (e.g. .example.com), or every visitor is bounced to /onboarding forever.
 *
 * Edge runtime: no node-only imports — the matrix lives in the
 * dependency-free src/lib/role-routes.ts.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { ONBOARDED_COOKIE, ROLE_COOKIE, ROLE_HOME, ONBOARDING_PATH, isAllowed, isAppRole } from '@/lib/role-routes'

/** Same origin the client uses (lib/api.ts) — kept inline: this file is edge. */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000'

/** `/jobs/<uuid>` — the only path that can be answered by a redirect. */
const JOB_PATH = /^\/jobs\/([0-9a-fA-F-]{36})$/

function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = ''
  return NextResponse.redirect(url)
}

/**
 * An awarded job IS its project — send the room a `fromJob` breadcrumb so its
 * "not yours to see" wall can offer a way back to the posting.
 *
 * Fails open everywhere: `?stay=1` is that breadcrumb's escape hatch (answer it
 * with a redirect and the two pages ping-pong), and a non-OK read means the
 * page renders and decides for itself — the API treats a draft as poster-only,
 * and a draft has no project to redirect to anyway.
 */
async function redirectAwardedJob(request: NextRequest, jobId: string) {
  if (request.nextUrl.searchParams.get('stay') === '1') return NextResponse.next()
  try {
    // Forward the visitor's IP: the API's read limiter keys on it, and this is a
    // server-to-server call that would otherwise land in one shared bucket for
    // every user on the box.
    const forwarded = request.headers.get('x-forwarded-for')
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
      cache: 'no-store',
      headers: forwarded ? { 'x-forwarded-for': forwarded } : undefined,
    })
    if (!res.ok) return NextResponse.next()
    const { data } = (await res.json()) as { data?: { projectId?: string | null } }
    if (!data?.projectId) return NextResponse.next()
    const url = request.nextUrl.clone()
    url.pathname = `/projects/${data.projectId}`
    url.search = `fromJob=${jobId}`
    return NextResponse.redirect(url)
  } catch {
    return NextResponse.next()
  }
}

export async function proxy(request: NextRequest) {
  {
    const p = request.nextUrl.pathname
    const onboarded = request.cookies.get(ONBOARDED_COOKIE)?.value === '1'
    const isOnboarding = p === ONBOARDING_PATH || p.startsWith(`${ONBOARDING_PATH}/`)

    // One-way flow: verified users can't re-enter onboarding (role is locked).
    if (isOnboarding) {
      return onboarded ? redirectTo(request, ROLE_HOME) : NextResponse.next()
    }

    // Onboarding gate: every app route needs the cookie. The public landing is
    // the one exception — gating it too meant nobody, ever, saw the page that
    // explains the product.
    if (!onboarded) return p === '/' ? NextResponse.next() : redirectTo(request, ONBOARDING_PATH)

    // Onboarded users leave the public landing page for their seat home.
    if (p === '/') return redirectTo(request, ROLE_HOME)

    // Seat gate — only for onboarded users with a known role hint.
    const rawRole = request.cookies.get(ROLE_COOKIE)?.value
    const role = isAppRole(rawRole) ? rawRole : null
    if (role && !isAllowed(p, role)) return redirectTo(request, ROLE_HOME)

    // An awarded job's posting is a stale address — the room owns it now.
    // The page keeps its own client-side redirect for what the proxy cannot
    // cover: a job awarded while its posting sits in the router cache, or open
    // in front of the poster who just accepted a bid.
    const job = JOB_PATH.exec(p)
    if (job) return redirectAwardedJob(request, job[1])

    return NextResponse.next()
  }
}

export const config = {
  matcher: [
    // every page — the gate is enforced for all routes, landing included
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|webmanifest)$).*)',
  ],
}
