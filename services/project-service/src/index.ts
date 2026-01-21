import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

import { healthRoutes } from './routes/health'
import { projectRoutes } from './routes/projects'

const logger = createServiceLogger(SERVICES.PROJECT)
const port = process.env.PROJECT_SERVICE_PORT || 3002

const app = new Elysia()
  .use(healthRoutes)
  .use(projectRoutes)
  .onError(({ code, error, set }) => {
    logger.error({ code, error: error.message }, 'Request error')
    set.status = 500
    return { success: false, error: 'Internal server error' }
  })
  .listen(port)

logger.info(`🚀 Project service running at http://localhost:${port}`)

export type App = typeof app
