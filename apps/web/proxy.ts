/**
 * Next.js proxy (formerly middleware) — all route guards live here.
 *
 * 1. Onboarding gate: EVERY page except `/onboarding` itself requires the
 *    `el_onboarded=1` cookie (stamped by the auth lifecycle routes when KYC
 *    is verified — see gate cookies in apps/api/src/lib/http.ts). This includes
 *    the public landing page `/`: a brand-new visitor can reach nothing but
 *    /onboarding until they have onboarded. Unfinished users bounce to
 *    /onboarding before any page code runs.
 * 2. Landing bounce: onboarded users never see `/` again — they are sent to
 *    their seat home (/dashboard).
 * 3. Seat gate (strict): onboarded users carry a plain `el_role` hint
 *    (client / freelancer / arbiter) stamped only by JWT-verified API routes.
 *    Paths outside the seat's allowlist bounce to /dashboard — the single
 *    adaptive home every role may view. The API remains the security
 *    boundary; this is navigation shaping.
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

function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = ''
  return NextResponse.redirect(url)
}

export function proxy(request: NextRequest) {
  {
    const p = request.nextUrl.pathname
    const onboarded = request.cookies.get(ONBOARDED_COOKIE)?.value === '1'
    const isOnboarding = p === ONBOARDING_PATH || p.startsWith(`${ONBOARDING_PATH}/`)

    // One-way flow: verified users can't re-enter onboarding (role is locked).
    if (isOnboarding) {
      return onboarded ? redirectTo(request, ROLE_HOME) : NextResponse.next()
    }

    // Hard onboarding gate — EVERY route, `/` included, needs the cookie.
    // A visitor who hasn't onboarded (signed in or not) can only see
    // /onboarding.
    if (!onboarded) return redirectTo(request, ONBOARDING_PATH)

    // Onboarded users leave the public landing page for their seat home.
    if (p === '/') return redirectTo(request, ROLE_HOME)

    // Seat gate — only for onboarded users with a known role hint.
    const rawRole = request.cookies.get(ROLE_COOKIE)?.value
    const role = isAppRole(rawRole) ? rawRole : null
    if (role && !isAllowed(p, role)) return redirectTo(request, ROLE_HOME)
    return NextResponse.next()
  }
}

export const config = {
  matcher: [
    // every page — the gate is enforced for all routes, landing included
    '/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|txt|xml|webmanifest)$).*)',
  ],
}
