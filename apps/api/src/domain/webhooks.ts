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

/**
 * True for addresses a webhook must never reach: loopback, private, link-local
 * (cloud metadata lives at 169.254.169.254), CGNAT, multicast, unspecified,
 * and their IPv6 / IPv4-mapped forms.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const h = ip.toLowerCase()
  return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
}

/**
 * Refuse a webhook URL that resolves to an internal address. Checked at
 * subscribe AND at each delivery (DNS can change in between).
 * ponytail: the fetch re-resolves, so a rebinding race remains; pin the
 * resolved IP with a custom dispatcher if this ever guards real infra.
 */
export async function assertPublicUrl(url: string, allowPrivate = false): Promise<void> {
  const { hostname, protocol } = new URL(url)
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('http(s) URL required')
  if (allowPrivate) return
  const { lookup } = await import('node:dns/promises')
  const host = hostname.replace(/^\[|\]$/g, '')
  const addrs = await lookup(host, { all: true })
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`webhook host ${host} resolves to a private address`)
  }
}
