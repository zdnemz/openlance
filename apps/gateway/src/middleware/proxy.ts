import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { Elysia } from 'elysia'

const logger = createServiceLogger(SERVICES.GATEWAY)

// Service URL mappings
const serviceUrls: Record<string, string> = {
  users: process.env.USER_SERVICE_URL || 'http://localhost:3001',
  projects: process.env.PROJECT_SERVICE_URL || 'http://localhost:3002',
  notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
}

export const proxyMiddleware = new Elysia({ prefix: '/api' })
  .all('/users/*', async ({ request, params }) => {
    return proxyRequest(request, 'users', params['*'])
  })
  .all('/projects/*', async ({ request, params }) => {
    return proxyRequest(request, 'projects', params['*'])
  })
  .all('/notifications/*', async ({ request, params }) => {
    return proxyRequest(request, 'notifications', params['*'])
  })

async function proxyRequest(
  request: Request,
  service: keyof typeof serviceUrls,
  path: string
): Promise<Response> {
  const serviceUrl = serviceUrls[service]
  const targetUrl = `${serviceUrl}/${path}`

  logger.debug({ service, path, targetUrl }, 'Proxying request')

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    })

    return response
  } catch (error) {
    logger.error({ service, path, error }, 'Proxy request failed')
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
