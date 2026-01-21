import swagger from '@elysiajs/swagger'
import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

import { healthRoutes } from './routes/health'
import { projectRoutes } from './routes/projects'

const logger = createServiceLogger(SERVICES.PROJECT)
const port = process.env.PROJECT_SERVICE_PORT || 3002

export const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: { title: 'Project Service API', version: '1.0.0' },
      },
    })
  )
  .use(healthRoutes)
  .use(projectRoutes)
  .onError(({ code, error, set }) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ code, error: errorMessage }, 'Request error')
    set.status = 500
    return { success: false, error: 'Internal server error' }
  })
  .listen(port)

logger.info(`🚀 Project service running at http://localhost:${port}`)

export type App = typeof app
