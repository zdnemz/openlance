/**
 * Route handler wrapper: request id, structured logging, and the error
 * envelope. Handlers return plain data (wrapped in `{ data }`) or a Response.
 */
import { NextResponse } from 'next/server'
import { AppError, Errors } from './errors'
import { logger } from './logger'
import { created, fail, ok } from './http'
import { bootstrapWorkers } from '../workers/bootstrap'

export type Handler<P = Record<string, string>> = (
  request: Request,
  ctx: { requestId: string; url: URL; params: P },
) => Promise<unknown>

/**
 * Wraps a handler with request id, structured logging and the error envelope.
 * The returned function matches Next.js's `(request, { params })` signature;
 * `params` is a Promise in Next 16, so it is awaited before dispatch.
 */
export function route<P extends Record<string, string> = Record<string, string>>(handler: Handler<P>) {
  return async (
    request: Request,
    ctx?: { params?: Promise<P> | P },
  ): Promise<NextResponse> => {
    const requestId = crypto.randomUUID()
    const url = new URL(request.url)
    const start = Date.now()
    // Idempotent, process-scoped: starts the chain indexer + periodic crons on
    // the first request (usually already booted, so this is a no-op).
    void bootstrapWorkers()
    try {
      const params = ((await ctx?.params) ?? {}) as P
      const result = await handler(request, { requestId, url, params })
      const res = result instanceof NextResponse ? result : ok(result)
      res.headers.set('X-Request-Id', requestId)
      logger.debug('request', { method: request.method, path: url.pathname, status: res.status, ms: Date.now() - start })
      return res
    } catch (err) {
      const res = fail(err, requestId)
      res.headers.set('X-Request-Id', requestId)
      if (err instanceof AppError) {
        logger.debug('request', { method: request.method, path: url.pathname, status: res.status, ms: Date.now() - start })
      }
      return res
    }
  }
}

export { Errors }
export { created, fail, ok }
