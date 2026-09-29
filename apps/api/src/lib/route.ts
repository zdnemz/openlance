/**
 * Route handler wrapper: request id, structured logging, and the error
 * envelope. Handlers return plain data (wrapped in `{ data }`) or a Response.
 *
 * The call-site contract is unchanged from the App Router era —
 * `route(async (request, { url, params }) => …)` — so the 70+ route modules
 * read exactly as they did inside Next. What changed is the runtime: the
 * returned function is a Hono handler, mounted by the table in `routes.ts`.
 *
 * Background workers are NOT started here. This used to be the only place
 * they could be kicked off, because the API *was* the Next process. The
 * service now boots them itself in `server.ts`, which is the whole point of
 * the split — a request no longer pays for, or depends on, worker startup.
 */
import type { Context } from 'hono'
import { AppError, Errors } from './errors.ts'
import { logger } from './logger.ts'
import { created, fail, ok } from './http.ts'

export type Handler<P = Record<string, string>> = (
  request: Request,
  ctx: { requestId: string; url: URL; params: P },
) => Promise<unknown>

/**
 * True for a Response the handler built itself, which `route()` passes through
 * instead of wrapping in the `{ data }` envelope.
 *
 * Deliberately NOT `instanceof Response`: @hono/node-server swaps the global
 * `Response` for a lightweight wrapper class, and the real Responses app code
 * creates are not instances of it. `instanceof` therefore answered "no" and
 * every direct-Response route was re-wrapped as `ok(response)` — a Response
 * serializes to `{}`, so those routes answered `{"data":{}}`. Silent, and it
 * broke login: `/auth/verify` handed the client an empty body, the client
 * stored `token: undefined`, and every later call came back 401.
 */
const isResponse = (v: unknown): v is Response =>
  typeof v === 'object' && v !== null && typeof (v as Response).arrayBuffer === 'function'

/**
 * Wraps a handler with request id, structured logging and the error envelope.
 */
export function route<P extends Record<string, string> = Record<string, string>>(handler: Handler<P>) {
  return async (c: Context): Promise<Response> => {
    const requestId = crypto.randomUUID()
    const request = c.req.raw
    const url = new URL(request.url)
    const start = Date.now()
    try {
      const result = await handler(request, { requestId, url, params: c.req.param() as P })
      const res = isResponse(result) ? result : ok(result)
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
