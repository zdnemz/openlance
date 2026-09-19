/**
 * Inbound webhook receiver (PRD F9, supporting surface).
 *
 * Lets trusted external systems (CI, deploy hooks, ops tooling) inject a domain
 * event through the SAME outbox as internal events — so it fans out to webhook
 * subscriptions and the in-app inbox identically, with one delivery/retry path.
 *
 * Security: the raw request body is HMAC-SHA256-verified against
 * `INBOUND_WEBHOOK_SECRET` using a constant-time compare, before parsing. The
 * endpoint is disabled entirely when the secret is unset.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { env } from '../config'
import { Errors } from '../lib/errors'
import { emitNotification } from './notify'

/** Verify `sha256=<hex>` (or bare hex) against the raw body. */
export function verifyInboundSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const provided = header.startsWith('sha256=') ? header.slice(7) : header
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const inboundSchema = z.object({
  type: z.string().min(1).max(120),
  actorAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullish(),
  projectId: z.string().uuid().nullish(),
  milestoneId: z.string().uuid().nullish(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict()

/**
 * Handle an inbound event. Reads the raw body first (signature is over the exact
 * bytes), verifies, then parses + emits. Returns the created event id.
 */
export async function receiveInbound(request: Request): Promise<{ eventId?: string; accepted: true } | never> {
  const secret = env.INBOUND_WEBHOOK_SECRET
  if (!secret) throw Errors.notFound('Inbound webhook')

  const rawBody = await request.text()
  if (rawBody.length > 64 * 1024) throw Errors.badRequest('payload_too_large', 'Inbound payload exceeds 64KB')
  const signature = request.headers.get('x-openlance-signature')
  if (!verifyInboundSignature(rawBody, signature, secret)) {
    throw Errors.unauthorized('Invalid signature')
  }

  let json: unknown
  try { json = JSON.parse(rawBody) } catch { throw Errors.badRequest('invalid_json', 'Body must be JSON') }
  const body = parseStrict(inboundSchema, json)

  await emitNotification({
    type: body.type,
    actorAddress: body.actorAddress ?? null,
    projectId: body.projectId ?? null,
    milestoneId: body.milestoneId ?? null,
    payload: { ...body.payload, source: 'inbound' },
  })
  return { accepted: true }
}

function parseStrict<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw Errors.badRequest('Validation failed', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`))
  }
  return parsed.data
}
