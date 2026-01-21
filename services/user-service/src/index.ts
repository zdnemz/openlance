import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

import { healthRoutes } from './routes/health'
import { userRoutes } from './routes/users'

const logger = createServiceLogger(SERVICES.USER)
const port = process.env.USER_SERVICE_PORT || 3001

export const app = new Elysia()
  .use(healthRoutes)
  .use(userRoutes)
  .onError(({ code, error, set }) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ code, error: errorMessage }, 'Request error')
    set.status = 500
    return { success: false, error: 'Internal server error' }
  })
  .listen(port)

logger.info(`🚀 User service running at http://localhost:${port}`)

export type App = typeof app
