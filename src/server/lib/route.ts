/**
 * Route handler wrapper: request id, structured logging, and the error
 * envelope. Handlers return plain data (wrapped in `{ data }`) or a Response.
 */
import { NextResponse } from 'next/server'
import { AppError, Errors } from './errors'
import { logger } from './logger'
import { fail, ok } from './http'

export type Handler = (request: Request, ctx: { requestId: string; url: URL }) => Promise<unknown>

export function route(handler: Handler) {
  return async (request: Request): Promise<NextResponse> => {
    const requestId = crypto.randomUUID()
    const url = new URL(request.url)
    const start = Date.now()
    try {
      const result = await handler(request, { requestId, url })
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
