import { success } from '@openlance/shared'
import type { ServiceHealth } from '@openlance/shared'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

const version = process.env.npm_package_version || '0.0.1'

export const healthRoutes = new Elysia({ prefix: '/health' }).get('/', () => {
  const health: ServiceHealth = {
    status: 'healthy',
    service: SERVICES.NOTIFICATION,
    timestamp: new Date(),
    version,
  }
  return success(health, 'Notification service is healthy')
})
