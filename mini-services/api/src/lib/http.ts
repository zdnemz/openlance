/** Response envelope + query parsing + tiny zod validator (zod v4 native). */
import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { Errors } from './errors'

export const ok = <T>(c: Context, data: T, status = 200) => c.json({ data }, status as never)

export function pagination(c: Context, defLimit = 50, maxLimit = 200) {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? defLimit) || defLimit, 1), maxLimit)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)
  return { limit, offset }
}

/** Parse a JSON body / query params against a zod schema → typed value or 400. */
export async function validate<S extends ZodType>(c: Context, schema: S, source: 'json' | 'query' = 'json'): Promise<import('zod').output<S>> {
  const raw = source === 'json' ? await c.req.json().catch(() => null) : c.req.query()
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const flat = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    throw Errors.badRequest('Validation failed', flat)
  }
  return parsed.data
}
