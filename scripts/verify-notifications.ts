/**
 * E2E verification for notifications + webhooks (PRD F9).
 * Run with: tsx scripts/verify-notifications.ts
 * Requires the server running on :3000 with INBOUND_WEBHOOK_SECRET set.
 */
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const INBOUND_SECRET = process.env.INBOUND_WEBHOOK_SECRET ?? 'test-inbound-secret-1234'
const PERSONA = {
  key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const,
  address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
}

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`) }
  else { fail++; console.log(`  \u2717 ${name}`, extra ?? '') }
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

async function login(): Promise<string> {
  const account = privateKeyToAccount(PERSONA.key)
  const nonceRes = await api('GET', '/auth/nonce')
  const { nonce, siwe } = nonceRes.json.data
  const issuedAt = new Date().toISOString()
  const expirationTime = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const message = [
    `${siwe.domain} wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    siwe.statement,
    '',
    `URI: ${BASE}`,
    'Version: 1',
    `Chain ID: ${siwe.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n')
  const signature = await account.signMessage({ message })
  const verify = await api('POST', '/auth/verify', undefined, { message, signature })
  if (!verify.json.data?.token) throw new Error(`login failed: ${JSON.stringify(verify.json)}`)
  return verify.json.data.token as string
}

const FREELANCER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const

async function loginAs(key: `0x${string}`, base: string): Promise<string> {
  const account = privateKeyToAccount(key)
  const nonceRes = await fetch(`${base}/api/auth/nonce`).then((r) => r.json())
  const { nonce, siwe } = nonceRes.data
  const message = [
    `${siwe.domain} wants you to sign in with your Ethereum account:`,
    account.address,
    '',
    siwe.statement,
    '',
    `URI: ${base}`,
    'Version: 1',
    `Chain ID: ${siwe.chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expiration Time: ${new Date(Date.now() + 10 * 60 * 1000).toISOString()}`,
  ].join('\n')
  const signature = await account.signMessage({ message })
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, signature }),
  }).then((r) => r.json())
  if (!res.data?.token) throw new Error(`loginAs failed: ${JSON.stringify(res)}`)
  return res.data.token as string
}

async function main() {
  console.log('\nOpenLance — notifications + webhooks E2E\n')
  const token = await login()
  check('SIWE login mints a session', !!token)

  // ── Inbox ──────────────────────────────────────────────────────────────
  const inbox = await api('GET', '/notifications', token)
  check('GET /notifications 200 + items[]', inbox.status === 200 && Array.isArray(inbox.json.data?.items), inbox.json)
  check('inbox exposes an unread count', typeof inbox.json.data?.unread === 'number')

  const unreadOnly = await api('GET', '/notifications?unread=true', token)
  check('?unread=true filters the feed', unreadOnly.status === 200 && (unreadOnly.json.data.items as { readAt: string | null }[]).every((i) => i.readAt === null))

  const before = inbox.json.data.unread as number
  const readAll = await api('POST', '/notifications/read', token, {})
  check('POST /notifications/read marks all read', readAll.status === 200 && readAll.json.data.updated >= 0)
  const after = await api('GET', '/notifications', token)
  check('unread count drops to 0 after read-all', after.json.data.unread === 0, { before, after: after.json.data.unread })

  // ── Preferences ────────────────────────────────────────────────────────
  const prefs = await api('GET', '/notifications/preferences', token)
  check('GET /notifications/preferences returns catalogue', prefs.status === 200 && Array.isArray(prefs.json.data?.types))

  const mute = await api('PATCH', '/notifications/preferences', token, { eventType: 'review.received', muted: true })
  check('PATCH mutes a type', mute.status === 200 && mute.json.data.muted === true && mute.json.data.eventType === 'review.received')

  const muteGlobal = await api('PATCH', '/notifications/preferences', token, { eventType: '*', muted: true })
  check('PATCH supports the "*" global mute', muteGlobal.status === 200 && muteGlobal.json.data.eventType === '*')

  const unmute = await api('PATCH', '/notifications/preferences', token, { eventType: '*', muted: false })
  check('PATCH unmutes globally', unmute.json.data.muted === false)
  await api('PATCH', '/notifications/preferences', token, { eventType: 'review.received', muted: false })

  // ── Webhooks ───────────────────────────────────────────────────────────
  // A real local receiver so a delivery can settle to `success` and be redelivered.
  const received: { type?: string }[] = []
  const receivedRaw: { body: string; signature: string | undefined }[] = []
  const { createServer } = await import('node:http')
  const { createHmac } = await import('node:crypto')
  const receiver = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      receivedRaw.push({ body, signature: req.headers['x-openlance-signature'] as string | undefined })
      try { received.push(JSON.parse(body)) } catch { /* ignore */ }
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  const port = (receiver.address() as { port: number }).port

  const created = await api('POST', '/webhooks', token, { url: `http://127.0.0.1:${port}/hook`, eventTypes: [] })
  check('POST /webhooks creates a signed subscription', created.status === 201 && typeof created.json.data?.secret === 'string' && created.json.data.secret.length >= 32, created.json)
  const subId = created.json.data.id as string

  const list = await api('GET', '/webhooks', token)
  const listed = (list.json.data as { id: string; stats: { total: number } }[]).find((s) => s.id === subId)
  check('GET /webhooks lists with delivery stats', !!listed && typeof listed.stats.total === 'number')

  const test = await api('POST', `/webhooks/${subId}/test`, token, {})
  check('POST /webhooks/:id/test queues a delivery', test.status === 200 && !!test.json.data.deliveryId)

  // Wait for the successful delivery + a real signature check on the receiver.
  let terminal: { id: string; status: string; envelope: { type: string } } | undefined
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const poll = await api('GET', `/webhooks/${subId}/deliveries`, token)
    terminal = (poll.json.data.items as typeof terminal[])[0]
    if (terminal?.status !== 'pending') break
  }
  check('test delivery reaches the endpoint and succeeds', terminal?.status === 'success', terminal)
  check('the endpoint received a signed webhook.test envelope', received.some((b) => b.type === 'webhook.test'), received)

  // The signature must verify against the subscription secret (HMAC-SHA256).
  const secret = created.json.data.secret as string
  const sigOk = receivedRaw.some((m) => m.signature === `sha256=${createHmac('sha256', secret).update(m.body, 'utf8').digest('hex')}`)
  check('delivered payload signature verifies with HMAC-SHA256(secret)', sigOk)

  const deliveries = await api('GET', `/webhooks/${subId}/deliveries`, token)
  check('GET deliveries returns the test delivery', deliveries.status === 200 && deliveries.json.data.items.length >= 1)
  check('test delivery carries the webhook.test envelope', terminal?.envelope?.type === 'webhook.test')

  const rotate = await api('POST', `/webhooks/${subId}/rotate`, token, {})
  check('POST /webhooks/:id/rotate returns a NEW secret', rotate.status === 200 && rotate.json.data.secret !== created.json.data.secret)

  const redeliver = await api('POST', `/webhooks/${subId}/deliveries/${terminal!.id}/redeliver`, token, {})
  check('POST redeliver re-queues a terminal delivery', redeliver.status === 200 && redeliver.json.data.redelivered === true, redeliver.json)

  const del = await api('DELETE', `/webhooks/${subId}`, token)
  check('DELETE /webhooks/:id removes it', del.status === 200 && del.json.data.deleted === true)
  await new Promise<void>((r) => receiver.close(() => r()))

  // ── Inbound ────────────────────────────────────────────────────────────
  const inboundBody = JSON.stringify({ type: 'ops.deploy', payload: { env: 'staging', sha: 'abc123' } })
  const sig = createHmac('sha256', INBOUND_SECRET).update(inboundBody, 'utf8').digest('hex')

  const bad = await fetch(`${BASE}/api/internal/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenLance-Signature': 'sha256=deadbeef' }, body: inboundBody,
  })
  check('inbound rejects a bad signature (401)', bad.status === 401, bad.status)

  const good = await fetch(`${BASE}/api/internal/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenLance-Signature': `sha256=${sig}` }, body: inboundBody,
  })
  check('inbound accepts a valid signature (200)', good.status === 200, await good.text())

  // ── Recipient fan-out (a live domain action) ────────────────────────────
  const clientToken = token
  const freelancerToken = await loginAs(FREELANCER_KEY, BASE)
  const job = await api('POST', '/jobs', clientToken, {
    title: 'Fan-out verification job',
    description: 'Verifies recipient fan-out from a live proposal.received event.',
    category: 'Engineering',
    skills: ['typescript'],
    budgetMin: '0.5',
    budgetMax: '1.0',
    milestones: [{ title: 'M1', description: 'do the thing', amount: '0.5' }],
  })
  check('a fresh job can be posted', job.status === 201, job.json)

  const proposal = await api('POST', `/jobs/${job.json.data.id}/proposals`, freelancerToken, {
    coverNote: 'I can deliver this cleanly.',
    deliveryDays: 5,
    milestones: [{ title: 'M1', description: 'do the thing', amount: '0.5' }],
  })
  check('a freelancer can propose', proposal.status === 201, proposal.json)

  await new Promise((r) => setTimeout(r, 400))
  const clientInbox = await api('GET', '/notifications', clientToken)
  const clientTypes = (clientInbox.json.data?.items ?? []).map((i: { type: string }) => i.type)
  check('the JOB POSTER receives proposal.received in their inbox', clientTypes.includes('proposal.received'), clientTypes.slice(0, 5))

  const freelancerInbox = await api('GET', '/notifications', freelancerToken)
  const freeTypes = (freelancerInbox.json.data?.items ?? []).map((i: { type: string }) => i.type)
  check('the ACTOR does not get an unread copy of their own action', !(freelancerInbox.json.data?.unread > 0 && freeTypes[0] === 'proposal.received' && freelancerInbox.json.data.items[0].readAt === null))

  // ── Auth guards ────────────────────────────────────────────────────────
  const anon = await api('GET', '/notifications')
  check('GET /notifications without auth → 401', anon.status === 401, anon.status)

  console.log(`\n${fail === 0 ? '\u2713 PASS' : '\u2717 FAIL'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
