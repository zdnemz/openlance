/** Hono app assembly — routes, middleware, error envelope. */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from './config'
import { AppError } from './lib/errors'
import { logger } from './lib/logger'
import { optionalAuth } from './auth/middleware'
import { authRoutes } from './auth/routes'
import { userRoutes } from './modules/users'
import { jobRoutes } from './modules/jobs'
import { proposalActionRoutes, proposalRoutes } from './modules/proposals'
import { projectRoutes } from './modules/projects'
import { chatRoutes } from './modules/chat'
import { submissionRoutes } from './modules/submissions'
import { fileRoutes } from './modules/files'
import { projectDisputeRoutes, disputeRoutes, adminDisputeRoutes } from './modules/disputes'
import { reviewRoutes } from './modules/reviews'
import { ledgerRoutes } from './modules/ledger'
import { arbiterRoutes } from './modules/arbiters'
import { webhookRoutes } from './modules/webhooks'
import { adminRoutes } from './modules/admin'
import { devChainRoutes } from './modules/devchain'
import { metaRoutes } from './modules/overview'
import type { User } from './db/schema'

type Vars = { user?: User }

export function buildApp(): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>()

  app.use('*', cors({ origin: [env.APP_URI, 'http://localhost:3000'], allowHeaders: ['Content-Type', 'Authorization'], allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'], maxAge: 600 }))

  app.use('*', async (c, next) => {
    const start = Date.now()
    c.header('X-Request-Id', crypto.randomUUID())
    await next()
    logger.debug('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start })
  })

  // auth context (optional) applies to everything below it
  app.use('*', optionalAuth)

  app.route('/', metaRoutes) // /health /ready /overview
  app.route('/auth', authRoutes)
  app.route('/users', userRoutes)
  app.route('/jobs', jobRoutes)
  app.route('/jobs', proposalRoutes) // /jobs/:jobId/proposals
  app.route('/proposals', proposalActionRoutes)
  app.route('/projects', projectRoutes)
  app.route('/projects', chatRoutes) // /projects/:id/messages
  app.route('/projects', submissionRoutes) // /projects/:id/milestones/:mid/submissions
  app.route('/projects', fileRoutes) // /projects/:id/attachments
  app.route('/projects', projectDisputeRoutes) // /projects/:id/milestones/:mid/disputes
  app.route('/disputes', disputeRoutes)
  app.route('/milestones', reviewRoutes) // /milestones/:id/reviews
  app.route('/ledger', ledgerRoutes)
  app.route('/arbiters', arbiterRoutes)
  app.route('/webhooks', webhookRoutes)
  app.route('/admin', adminRoutes)
  app.route('/admin', adminDisputeRoutes)
  if (env.NODE_ENV !== 'production' && env.chainMode === 'mock') {
    app.route('/dev/chain', devChainRoutes)
  }

  app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404))

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as never)
    }
    logger.error('unhandled error', { path: c.req.path, err: err instanceof Error ? { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') } : String(err) })
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500)
  })

  return app
}
