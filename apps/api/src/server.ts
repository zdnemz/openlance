/**
 * API entrypoint. Run directly — no build step:
 *
 *   node --env-file=.env.local src/server.ts
 *
 * Node 24 strips TypeScript types natively, so what runs is what you read.
 * The service is intentionally thin: validate config, start the background
 * workers that used to be kicked off by the first request inside Next, then
 * listen.
 */
import { serve } from '@hono/node-server'
import app from './app.ts'
import { env } from './config.ts'
import { logger } from './lib/logger.ts'
import { bootstrapWorkers } from './workers/bootstrap.ts'

const log = logger.child({ component: 'server' })
const port = Number(process.env.PORT ?? 4000)

// Fail loudly on a bad port rather than listening on a random one.
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[server] PORT must be an integer in 1-65535, got ${process.env.PORT}`)
  process.exit(1)
}

// Workers start here, not per-request: the chain indexer, SLA scan and
// nightly reconciliation are the API's responsibility, and they should be
// running whether or not anyone is browsing.
void bootstrapWorkers()

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  log.info('api listening', {
    port: info.port,
    env: env.NODE_ENV,
    chainMode: env.chainMode,
    db: env.databaseDriver,
    queue: env.queueMode,
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal })
    process.exit(0)
  })
}
