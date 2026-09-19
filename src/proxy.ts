/**
 * Next.js proxy (formerly middleware) — CORS for the API surface.
 *
 * Same-origin frontend calls need no CORS, but existing clients (and the
 * preview gateway) may call cross-origin; keep the Hono service's behaviour:
 * allow APP_URI + localhost:3000, and short-circuit OPTIONS preflight.
 */
import { NextResponse, type NextRequest } from 'next/server'

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
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
  }
  const response = NextResponse.next()
  for (const [k, v] of Object.entries(corsHeaders(origin))) response.headers.set(k, v)
  return response
}

export const config = {
  matcher: '/api/:path*',
}
