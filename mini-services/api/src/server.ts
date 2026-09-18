/**
 * Bun entrypoint. `bun --hot src/server.ts` for development.
 *
 * In inline mode (no Redis) the API process also runs the workers — crons,
 * webhook deliveries, and (real-chain mode) the log poller — so the whole
 * backend is one process with zero infrastructure.
 */
import { env } from './config'
import { logger } from './lib/logger'
import { buildApp } from './app'

const app = buildApp()

const server = {
  port: env.PORT,
  fetch: app.fetch,
}
export default server

// Hot-reload-safe boot guard: `bun --hot` re-evaluates this module on change.
const g = globalThis as { __escrowlance_booted?: boolean }
if (!g.__escrowlance_booted) {
  g.__escrowlance_booted = true
  logger.info(`escrowlance-api listening on :${env.PORT}`, {
    db: env.databaseDriver,
    kv: env.queueMode,
    chain: env.chainMode,
    storage: env.storageDriver,
    chainId: env.CHAIN_ID,
    admin: env.adminWallets.length ? env.adminWallets : '(none configured)',
  })

  if (env.INLINE_WORKERS && env.queueMode === 'inline') {
    const { startWorkers } = await import('./workers/index')
    await startWorkers({ crons: true, poller: true }).catch((err) =>
      logger.error('inline workers failed to start', { err: String(err) }),
    )
  }

  const shutdown = (sig: string) => {
    logger.info(`received ${sig}, shutting down`)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
