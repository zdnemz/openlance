/**
 * The OpenLance API service.
 *
 * A standalone Hono app. It was previously the Next.js app's route handlers
 * (`frontend/app/api/**`) importing the backend through an `@backend/*` alias;
 * the browser talked to the web origin, which proxied nothing — the handlers
 * *were* the API. Splitting it out means the API owns its own port, its own
 * CORS, and its own workers, and the web app is reduced to pages.
 *
 *   apps/web  ──fetch──▶  apps/api  ──▶  Postgres / Upstash / chain
 *      (pages)             (this)          (nothing imports this package)
 *
 * Two deployment shapes share this one app, and nothing in it depends on which:
 *
 *   - Separate origins (`pnpm dev`, Caddy/self-hosted): the browser calls this
 *     API cross-origin, so the CORS block below is load-bearing.
 *   - One origin (Vercel services, see the root `vercel.json`): a top-level
 *     rewrite sends `/api/*` here and everything else to the web app. The path
 *     is passed through UNCHANGED — every route is registered with the literal
 *     `/api` prefix (see `routes.ts`), so a rewrite that stripped it would turn
 *     every request into a 404. Do not add a `request.path` transform. CORS is
 *     simply never exercised, because same-origin requests do not use it.
 *
 * This file is the serverless entrypoint (default export); `serve.ts` is the
 * long-running Node one and is never used on Vercel.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './config.ts'
import { logger } from './lib/logger.ts'
import { fail } from './lib/http.ts'
import { ROUTES } from './routes.ts'

/** Frontend origins allowed to call the API. The web app is the only client. */
const ALLOWED = [env.APP_URI, 'http://localhost:3000'].filter(Boolean)

const app = new Hono()

/**
 * CORS. When the web app is on a different origin (local dev, self-hosted) the
 * browser calls this origin directly, so this replaces the CORS block that used
 * to live in the web app's proxy — the API is the security boundary, and it
 * answers preflights itself. Under a single-origin deployment (Vercel services)
 * the browser never sends a cross-origin request, so none of this fires; it
 * stays because the other shapes still need it.
 *
 * Credentials are required: the gate cookies (`el_onboarded`, `el_role`) are
 * read by the web app's edge proxy but stamped here, so a cross-origin request
 * must carry them. `Access-Control-Allow-Origin` echoes a specific origin
 * rather than `*` because that is incompatible with credentials.
 */
app.use(
  '*',
  cors({
    origin: (origin) => (origin && ALLOWED.includes(origin) ? origin : ALLOWED[0]),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
    credentials: true,
  }),
)

/** Fallback for anything the table does not mount (unknown path, bad method). */
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

/** Last-resort net. Handled routes already trap their own errors in `route()`. */
app.onError((err, c) => {
  const res = fail(err)
  return res
})

// The table is the single index of the API surface: one entry per exported
// method, with the path derived from the module's directory.
for (const [method, path, handler] of ROUTES) {
  app.on(method, path, handler)
}

logger.debug('routes registered', { count: ROUTES.length, origins: ALLOWED })

export default app
