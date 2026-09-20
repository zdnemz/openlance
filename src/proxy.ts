/**
 * Next.js proxy (formerly middleware).
 *
 * 1. Onboarding gate (page level): every app page EXCEPT `/` and `/onboarding`
 *    requires the `el_onboarded=1` cookie (stamped by the auth lifecycle routes
 *    when KYC is verified — see ONBOARDED_COOKIE in src/server/lib/http.ts).
 *    Unfinished users bounce to /onboarding before any page code runs. The
 *    literal is duplicated here on purpose: this module must stay free of
 *    node-only imports (edge runtime).
 * 2. CORS for the API surface (unchanged).
 */
import { NextResponse, type NextRequest } from 'next/server'

const ALLOWED = [process.env.APP_URI ?? 'http://localhost:3000', 'http://localhost:3000']
const ONBOARDED_COOKIE = 'el_onboarded'

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
    '/arbiters/:path*',
    '/profile/:path*',
    '/settings/:path*',
    '/admin/:path*',
    '/console/:path*',
    '/onboarding',
    '/onboarding/:path*',
  ],
}
