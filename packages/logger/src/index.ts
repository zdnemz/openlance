import pino from 'pino'

const isDevelopment = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    pid: false,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

/**
 * Create a child logger with a specific service context
 */
export function createServiceLogger(service: string) {
  return logger.child({ service })
}

/**
 * Create a child logger with request context
 */
export function createRequestLogger(
  service: string,
  requestId: string,
  method?: string,
  path?: string
) {
  return logger.child({
    service,
    requestId,
    method,
    path,
  })
}

export type Logger = typeof logger
export default logger
