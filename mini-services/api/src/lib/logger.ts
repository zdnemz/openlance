/**
 * Minimal structured logger — JSON lines in production, pretty in development.
 * Zero dependencies (avoids pino transport/worker issues across Bun/Node).
 */
import { env } from '../config'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return
  const ts = new Date().toISOString()
  if (env.LOG_PRETTY) {
    const extra = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : ''
    const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level]
    console[level === 'debug' ? 'log' : level](`[${ts} ${tag}] ${msg}${extra}`)
  } else {
    console[level === 'debug' ? 'log' : level](JSON.stringify({ ts, level, msg, ...data }))
  }
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const merged = (data?: Record<string, unknown>) => ({ ...bindings, ...data })
  return {
    debug: (m, d) => emit('debug', m, merged(d)),
    info: (m, d) => emit('info', m, merged(d)),
    warn: (m, d) => emit('warn', m, merged(d)),
    error: (m, d) => emit('error', m, merged(d)),
    child: (b) => createLogger({ ...bindings, ...b }),
  }
}

export const logger = createLogger()
