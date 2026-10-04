/**
 * HTTP helpers for the API service.
 *
 * The envelope is `{ data }` on success and `{ error: { code, message,
 * details? } }` on failure — clients destructure exactly that
 * (`apps/web/lib/api.ts`), so these shapes are a wire contract.
 *
 * Handlers receive a web `Request`; context (the authenticated user) is
 * threaded explicitly rather than via Hono's `c.set`/`c.get`, which keeps
 * every module testable without a server instance.
 */
import type { ZodType } from 'zod'
import { AppError, Errors } from './errors.ts'
import { logger } from './logger.ts'
import { env } from '../config.ts'
import type { User } from '../db/schema.ts'

export type RouteContext = {
  user?: User
  requestId: string
  headers: Headers
}

export function ok<T>(data: T, status = 200, init?: ResponseInit): Response {
  return Response.json({ data }, { status, ...init })
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
  // The gate cookies are read by the *web* app's edge proxy, but set by this
  // API. If the two live on different hosts they only reach both when the
  // domain is shared — e.g. api.example.com + example.com →
  // COOKIE_DOMAIN=.example.com.
  // Unset (default) keeps them host-only, which is right when both are on
  // localhost (cookies ignore ports, so :3000 and :4000 share a jar anyway) and
  // on a single-origin deployment (Vercel services), where the API and the
  // proxy that reads the cookie are the same host.
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
}

type CookieOpts = {
  path?: string
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  maxAge?: number
  secure?: boolean
  domain?: string
}

/** Serialize one Set-Cookie value. Replaces NextResponse's `res.cookies` API. */
function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (opts.path) parts.push(`Path=${opts.path}`)
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`)
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  return parts.join('; ')
}

function appendCookie(res: Response, name: string, value: string, opts: CookieOpts = {}): Response {
  res.headers.append('Set-Cookie', serializeCookie(name, value, opts))
  return res
}

/** Stamp the gate cookie on an `ok()` response (auth verify / role / KYC). */
export function withOnboardedCookie(res: Response, verified: boolean): Response {
  return appendCookie(res, ONBOARDED_COOKIE, verified ? '1' : '0', cookieBase)
}

/** Stamp both proxy cookies (onboarded + seat) after any identity change. */
export function withGateCookies(res: Response, gate: { verified: boolean; role: string }): Response {
  appendCookie(res, ONBOARDED_COOKIE, gate.verified ? '1' : '0', cookieBase)
  return appendCookie(res, ROLE_COOKIE, gate.role, { ...cookieBase, httpOnly: false })
}

/** Expire the gate cookie (logout — always succeeds, even unauthenticated). */
export function clearOnboardedCookie(res: Response): Response {
  return appendCookie(res, ONBOARDED_COOKIE, '', { path: '/', maxAge: 0 })
}

/** Expire both gate cookies (logout). */
export function clearGateCookies(res: Response): Response {
  appendCookie(res, ONBOARDED_COOKIE, '', { path: '/', maxAge: 0 })
  return appendCookie(res, ROLE_COOKIE, '', { path: '/', maxAge: 0 })
}

/** 201 Created envelope. */
export function created<T>(data: T): Response {
  return ok(data, 201)
}

/**
 * The `cause` chain of an error, innermost last. Drizzle wraps a driver failure
 * in "Failed query: ..." and the real reason (bad password, missing relation,
 * SSL, timeout) lives only on `cause`, so without this the log names the SQL
 * and never says why it failed. Message and Postgres code only, never params.
 */
function causeChain(err: Error): Array<{ name: string; code?: unknown; message: string }> {
  const out: Array<{ name: string; code?: unknown; message: string }> = []
  for (let c: unknown = err.cause, i = 0; c instanceof Error && i < 4; c = c.cause, i++) {
    out.push({ name: c.name, code: (c as { code?: unknown }).code, message: c.message })
  }
  return out
}

export function fail(err: unknown, requestId?: string): Response {
  if (err instanceof AppError) {
    return Response.json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } },
      { status: err.status },
    )
  }
  logger.error('unhandled error', {
    requestId,
    err: err instanceof Error ? { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | '), causes: causeChain(err) } : String(err),
  })
  return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 })
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

export function parseOrThrow<S extends ZodType>(schema: S, raw: unknown): import('zod').output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const flat = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    throw Errors.badRequest('Validation failed', flat)
  }
  return parsed.data
}
