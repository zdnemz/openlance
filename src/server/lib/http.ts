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
import type { User } from '../db/schema'

export type RouteContext = {
  user?: User
  requestId: string
  headers: Headers
}

export function ok<T>(data: T, status = 200, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, { status, ...init })
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
