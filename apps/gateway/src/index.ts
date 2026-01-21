import cors from '@elysiajs/cors'
import { createServiceLogger } from '@openlance/logger'
import { HTTP_STATUS, SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

import { healthRoutes } from './routes/health'
import { proxyMiddleware } from './middleware/proxy'

const logger = createServiceLogger(SERVICES.GATEWAY)
const port = process.env.GATEWAY_PORT || 3000

export const app = new Elysia()
  .use(cors())
  .use(healthRoutes)
  .use(proxyMiddleware)
  .onError(({ code, error, set }) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ code, error: errorMessage }, 'Request error')

    if (code === 'NOT_FOUND') {
      set.status = HTTP_STATUS.NOT_FOUND
      return { success: false, error: 'Route not found' }
    }

    set.status = HTTP_STATUS.INTERNAL_SERVER_ERROR
    return { success: false, error: 'Internal server error' }
  })
  .listen(port)

logger.info(`🚀 Gateway running at http://localhost:${port}`)

export type App = typeof app
