/**
 * HTTP helpers for Next.js Route Handlers.
 *
 * Mirrors the Hono service's envelope surface: `{ data }` on success and
 * `{ error: { code, message, details? } }` on failure. Route handlers receive
 * a Web `Request`; context (the authenticated user) is threaded explicitly
 * rather than via Hono's `c.set`/`c.get`.
 */
import { NextResponse } from 'next/server'
import type { ZodType } from 'zod'
import { AppError, Errors } from './errors'
import { logger } from './logger'
import { env } from '../config'
import type { User } from '../db/schema'

export type RouteContext = {
  user?: User
  requestId: string
  headers: Headers
}

export function ok<T>(data: T, status = 200, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, { status, ...init })
}

/**
 * Onboarding-gate cookie read by the edge proxy (`src/proxy.ts`):
 * value '1' ⇔ KYC verified. httpOnly — only the proxy needs it.
 * Keep the literal in sync with proxy.ts (deliberately not imported there —
 * the proxy must stay free of node-only modules).
 */
export const ONBOARDED_COOKIE = 'el_onboarded'

/**
 * Role-hint cookie read by the edge proxy for strict seat separation.
 * Plain (not signed) UX hint stamped only by JWT-verified server routes —
 * the API still enforces auth/role per request; tampering just bounces
 * between friendly pages. In sync with src/lib/role-routes.ts ROLE_COOKIE.
 */
export const ROLE_COOKIE = 'el_role'

const cookieBase = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  maxAge: env.SESSION_TTL_SECONDS,
  ...(process.env.NODE_ENV === 'production' ? { secure: true } : {}),
}

/** Stamp the gate cookie on an `ok()` response (auth verify / role / KYC). */
export function withOnboardedCookie(res: NextResponse, verified: boolean): NextResponse {
  res.cookies.set(ONBOARDED_COOKIE, verified ? '1' : '0', cookieBase)
  return res
}

/** Stamp both proxy cookies (onboarded + seat) after any identity change. */
export function withGateCookies(res: NextResponse, gate: { verified: boolean; role: string }): NextResponse {
  res.cookies.set(ONBOARDED_COOKIE, gate.verified ? '1' : '0', cookieBase)
  res.cookies.set(ROLE_COOKIE, gate.role, { ...cookieBase, httpOnly: false })
  return res
}

/** Expire the gate cookie (logout — always succeeds, even unauthenticated). */
export function clearOnboardedCookie(res: NextResponse): NextResponse {
  res.cookies.set(ONBOARDED_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}

/** Expire both gate cookies (logout). */
export function clearGateCookies(res: NextResponse): NextResponse {
  res.cookies.set(ONBOARDED_COOKIE, '', { path: '/', maxAge: 0 })
  res.cookies.set(ROLE_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}

/** 201 Created envelope — parity with the original Hono routes. */
export function created<T>(data: T): NextResponse {
  return ok(data, 201)
}

export function fail(err: unknown, requestId?: string): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
      { status: err.status },
    )
  }
  logger.error('unhandled error', {
    requestId,
    err: err instanceof Error ? { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') } : String(err),
  })
  return NextResponse.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 })
}

export function pagination(url: URL, defLimit = 50, maxLimit = 200) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? defLimit) || defLimit, 1), maxLimit)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
  return { limit, offset }
}

/** Parse a JSON body against a zod schema → typed value or 400. */
export async function validate<S extends ZodType>(request: Request, schema: S): Promise<import('zod').output<S>> {
  const raw = await request.json().catch(() => null)
  return parseOrThrow(schema, raw)
}

/** Parse query params against a zod schema → typed value or 400. */
export function validateQuery<S extends ZodType>(url: URL, schema: S): import('zod').output<S> {
  const raw: Record<string, string> = {}
  url.searchParams.forEach((v, k) => (raw[k] = v))
  return parseOrThrow(schema, raw)
}

function parseOrThrow<S extends ZodType>(schema: S, raw: unknown): import('zod').output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const flat = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    throw Errors.badRequest('Validation failed', flat)
  }
  return parsed.data
}

/** CORS for the frontend origin(s). */
export function corsHeaders(origin: string | null, allowed: string[]): HeadersInit {
  const allow = origin && allowed.includes(origin) ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': allow ?? '',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}
