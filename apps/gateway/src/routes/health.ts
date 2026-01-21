import { createServiceLogger } from '@openlance/logger'
import { success } from '@openlance/shared'
import type { ServiceHealth } from '@openlance/shared'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

const logger = createServiceLogger(SERVICES.GATEWAY)
const version = process.env.npm_package_version || '0.0.1'

// Service URLs for health checks
const serviceUrls: Record<string, string> = {
  [SERVICES.USER]: process.env.USER_SERVICE_URL || 'http://localhost:3001',
  [SERVICES.PROJECT]: process.env.PROJECT_SERVICE_URL || 'http://localhost:3002',
  [SERVICES.NOTIFICATION]: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
}

export interface AggregatedHealth {
  gateway: ServiceHealth
  services: Record<string, ServiceHealth | { status: 'unhealthy'; error: string }>
  allHealthy: boolean
}

async function checkServiceHealth(
  service: string,
  url: string
): Promise<ServiceHealth | { status: 'unhealthy'; error: string }> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      return { status: 'unhealthy', error: `HTTP ${response.status}` }
    }
    const data = (await response.json()) as { data: ServiceHealth }
    return data.data
  } catch (err) {
    logger.warn({ service, url, error: err }, 'Service health check failed')
    return { status: 'unhealthy', error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

export const healthRoutes = new Elysia({ prefix: '/health' })
  .get('/', async ({ set }) => {
    // Check all services health
    const serviceChecks = await Promise.all(
      Object.entries(serviceUrls).map(async ([service, url]) => {
        const health = await checkServiceHealth(service, url)
        return [service, health] as const
      })
    )

    const services = Object.fromEntries(serviceChecks)
    const allHealthy = Object.values(services).every((s) => s.status === 'healthy')

    const gatewayHealth: ServiceHealth = {
      status: allHealthy ? 'healthy' : 'degraded',
      service: SERVICES.GATEWAY,
      timestamp: new Date(),
      version,
    }

    const aggregated: AggregatedHealth = {
      gateway: gatewayHealth,
      services,
      allHealthy,
    }

    if (!allHealthy) {
      set.status = 503
      return {
        success: false,
        data: aggregated,
        message: 'Some services are unhealthy',
      }
    }

    return success(aggregated, 'All services are healthy')
  })
  .get('/ready', async ({ set }) => {
    // Quick readiness check - just verify gateway can respond
    const serviceChecks = await Promise.all(
      Object.entries(serviceUrls).map(async ([service, url]) => {
        try {
          const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
          return [service, response.ok] as const
        } catch {
          return [service, false] as const
        }
      })
    )

    const ready = serviceChecks.every(([, ok]) => ok)

    if (!ready) {
      set.status = 503
      return {
        success: false,
        data: { ready: false, services: Object.fromEntries(serviceChecks) },
        message: 'Not all services are ready',
      }
    }

    return success(
      { ready: true, services: Object.fromEntries(serviceChecks) },
      'All services are ready'
    )
  })
  .get('/live', () => {
    return success({ alive: true }, 'Gateway is alive')
  })
