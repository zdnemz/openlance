/**
 * Next.js proxy (formerly middleware) — all route guards live here.
 *
 * 1. Onboarding gate: every app page EXCEPT `/` and `/onboarding`
 *    requires the `el_onboarded=1` cookie (stamped by the auth lifecycle
 *    routes when KYC is verified — see gate cookies in
 *    src/server/lib/http.ts). Unfinished users bounce to /onboarding
 *    before any page code runs.
 * 2. Seat gate (strict): onboarded users carry a plain `el_role` hint
 *    (client / freelancer / arbiter) stamped only by JWT-verified server
 *    routes. Paths outside the seat's allowlist bounce to /dashboard —
 *    the single adaptive home every role may view. The API remains the
 *    security boundary; this is navigation shaping.
 * 3. CORS for the API surface (unchanged).
 *
 * Edge runtime: no node-only imports — the matrix lives in the
 * dependency-free src/lib/role-routes.ts.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { ONBOARDED_COOKIE, ROLE_COOKIE, ROLE_HOME, isAllowed, isAppRole } from '@/lib/role-routes'

const ALLOWED = [process.env.APP_URI ?? 'http://localhost:3000', 'http://localhost:3000']

function corsHeaders(origin: string | null): HeadersInit {
  const allow = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

export function proxy(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith('/api')) {
    const p = request.nextUrl.pathname
    const isOnboarding = p === '/onboarding' || p.startsWith('/onboarding/')
    // One-way flow: verified users can't re-enter onboarding (role is locked).
    if (isOnboarding && request.cookies.get(ONBOARDED_COOKIE)?.value === '1') {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      url.search = ''
      return NextResponse.redirect(url)
    }
    const isPublic = p === '/' || isOnboarding
    if (!isPublic && request.cookies.get(ONBOARDED_COOKIE)?.value !== '1') {
      const url = request.nextUrl.clone()
      url.pathname = '/onboarding'
      url.search = ''
      return NextResponse.redirect(url)
    }
    // Seat gate — only for onboarded users with a known role hint.
    const rawRole = request.cookies.get(ROLE_COOKIE)?.value
    const role = isAppRole(rawRole) ? rawRole : null
    if (!isPublic && role && !isAllowed(p, role)) {
      const url = request.nextUrl.clone()
      url.pathname = ROLE_HOME
      url.search = ''
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
  }
  const response = NextResponse.next()
  for (const [k, v] of Object.entries(corsHeaders(origin))) response.headers.set(k, v)
  return response
}

export const config = {
  matcher: [
    '/api/:path*',
    '/dashboard/:path*',
    '/jobs/:path*',
    '/projects/:path*',
    '/disputes/:path*',
    '/stake/:path*',
    '/arbiters/:path*',
    '/profile/:path*',
    '/settings/:path*',
    '/admin/:path*',
    '/console/:path*',
    '/onboarding',
    '/onboarding/:path*',
  ],
}
