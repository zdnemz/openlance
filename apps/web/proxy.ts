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
 * There is no `/api` branch here — this app serves pages. The API is apps/api,
 * either on its own origin (:4000, which answers its own CORS preflights) or,
 * on Vercel, on this same origin: the top-level `/api/(.*)` rewrite sends those
 * requests to the api service before they reach this app. lib/api-base.ts
 * decides which.
 *
 * The gate cookies are stamped by the API. On one origin they are host-only and
 * just work. Cross-origin that only works if they share a domain: set
 * COOKIE_DOMAIN on the API in production (e.g. .example.com), or every visitor
 * is bounced to /onboarding forever.
 *
 * Keep imports dependency-free (no node-only or client-only modules): the seat
 * matrix lives in lib/role-routes.ts and the API base in lib/api-base.ts.
 * Service bindings do not resolve in the proxy, so it reaches the API by URL.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { ONBOARDED_COOKIE, ROLE_COOKIE, ROLE_HOME, ONBOARDING_PATH, isAllowed, isAppRole } from '@/lib/role-routes'
import { absoluteApiUrl } from '@/lib/api-base'

/**
 * Longest the proxy waits on the API before letting the page render. This read
 * sits in front of every `/jobs/<uuid>` navigation, and on Vercel it is a
 * round trip through routing to a function that may be cold — an API that is
 * slow or hung must cost the visitor a redirect, not the page.
 */
const JOB_READ_TIMEOUT_MS = 5000

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
    // A server-side fetch needs an absolute URL. With a separate API origin that
    // is the configured base; same-origin (empty base) it is this request's own
    // origin, where `/api/*` is routed to the API.
    const res = await fetch(absoluteApiUrl(`/api/jobs/${jobId}`, () => request.nextUrl.origin), {
      cache: 'no-store',
      headers: forwarded ? { 'x-forwarded-for': forwarded } : undefined,
      signal: AbortSignal.timeout(JOB_READ_TIMEOUT_MS),
      // Never follow a redirect: one (say, to a protection login page) is not the
      // job, and following it would parse HTML as JSON for no gain. A 3xx is not
      // `ok`, so it falls through to the page like any other failed read.
      redirect: 'manual',
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
    // every page — the gate is enforced for all routes, landing included. `api/`
    // is excluded: on one origin the top-level rewrite sends it to the api service
    // before this app sees it, but a cookie-less sign-in call must never be bounced
    // to /onboarding even if that order ever changes.
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|webmanifest)$).*)',
  ],
}
