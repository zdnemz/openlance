import { Elysia } from 'elysia'
import swagger from '@elysiajs/swagger'
import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { authRoutes } from './routes/auth'

const logger = createServiceLogger(SERVICES.AUTH)
const port = process.env.AUTH_SERVICE_PORT || 3004

export const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: { title: 'Auth Service API', version: '1.0.0' },
      },
    })
  )
  .use(authRoutes)
  .onError(({ code, error, set }) => {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ code, error: errorMessage }, 'Request error')
    set.status = 500
    if (errorMessage === 'Unauthorized') set.status = 401
    return { success: false, error: errorMessage } // Return error message dev friendly
  })
  .listen(port)

logger.info(`🚀 Auth service running at http://localhost:${port}`)

export type App = typeof app
