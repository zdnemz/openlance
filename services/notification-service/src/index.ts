import swagger from '@elysiajs/swagger'
import { createServiceLogger } from '@openlance/logger'
import { connectMongoDB } from '@openlance/mongodb'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

import { healthRoutes } from './routes/health'
import { notificationRoutes } from './routes/notifications'

const logger = createServiceLogger(SERVICES.NOTIFICATION)
const port = process.env.NOTIFICATION_SERVICE_PORT || 3003

// Connect to MongoDB
connectMongoDB().catch((err) => {
  logger.error({ error: err }, 'Failed to connect to MongoDB')
})

export const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: { title: 'Notification Service API', version: '1.0.0' },
      },
    })
  )
  .use(healthRoutes)
  .use(notificationRoutes)
  .onError(({ code, error, set }) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ code, error: errorMessage }, 'Request error')
    set.status = 500
    return { success: false, error: 'Internal server error' }
  })
  .listen(port)

logger.info(`🚀 Notification service running at http://localhost:${port}`)

export type App = typeof app
