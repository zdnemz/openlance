/**
 * Webhook delivery domain logic: HMAC signing + the retry ladder.
 * Pure functions — unit-tested without HTTP.
 */
import { createHmac } from 'node:crypto'

/** Hex HMAC-SHA256 of the exact JSON body sent on the wire. */
export function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

export function webhookHeaders(signature: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-OpenLance-Signature': `sha256=${signature}`,
    'X-OpenLance-Event': 'delivery',
    'User-Agent': 'OpenLance-Webhooks/1.0',
  }
}

/**
 * Exponential-ish retry ladder, capped: attempt n waits min(10s · 4^(n-1), 1h).
 * attempts=1..5 → 10s, 40s, 160s, 640s, 2560s (~43min worst case) — enough
 * for a demo Discord webhook without hammering a dead endpoint.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(10_000 * 4 ** (attempt - 1), 3_600_000)
}

export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts
}

export function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300
}
