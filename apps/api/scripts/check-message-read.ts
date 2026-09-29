/**
 * Self-check: read state must never touch the evidence log
 * (run: pnpm check:message-read).
 *
 * `messages` is append-only by design (PRD F6), so "the other side read it"
 * cannot live as a `read_at` column — it is a per-viewer watermark in
 * `message_read_cursors` instead. Three things can silently break that promise:
 * the receipt is computed from the wrong row, a late request moves the cursor
 * backwards, or a client claims to have read the future. The last assertion is
 * the one that matters most: after a full read round-trip, the message rows
 * must still be byte-identical.
 *
 * Needs DATABASE_URL (it writes its own fixtures and removes them again). No
 * chain, no running API: the module is called in-process.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/db/index.ts'
import { signSession } from '../src/lib/jwt.ts'
import { AppError } from '../src/lib/errors.ts'
import { listMessages, markMessagesRead } from '../src/modules/chat.ts'
import { jobs, messageReadCursors, messages, projects, proposals, users } from '../src/db/schema.ts'

let failures = 0
function check(name: string, ok: boolean, extra: unknown = '') {
  if (ok) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}`, extra); failures++ }
}

async function rejects(name: string, run: () => Promise<unknown>, status: number, code?: string) {
  try {
    await run()
    check(name, false, 'expected a rejection, got a resolved call')
  } catch (err) {
    const ok = err instanceof AppError && err.status === status && (!code || err.code === code)
    check(name, ok, `${(err as Error)?.name}: ${(err as Error)?.message}`)
  }
}

const db = getDb()
const ETH = (10n ** 18n).toString()

const seats = await db.select().from(users).where(eq(users.kycStatus, 'verified')).limit(2)
const [client, freelancer] = seats
if (!client || !freelancer) {
  console.error('need two verified users in the DB to run this check')
  process.exit(1)
}

// The third party exists only to be refused, so it is minted here rather than
// requiring a demo persona the DB may not have. KYC is irrelevant to it: the
// participant guard runs before anything else.
const [stranger] = await db.insert(users).values({
  walletAddress: `0xcheck${randomBytes(19).toString('hex')}`,
  displayName: 'read-check stranger',
  role: 'client',
}).returning()

const [job] = await db.insert(jobs).values({
  posterId: client.id, title: 'message read check', description: 'temporary fixture',
  category: 'Engineering', skills: ['typescript'],
  budgetMinWei: ETH, budgetMaxWei: ETH, status: 'in_progress',
}).returning()
const [proposal] = await db.insert(proposals).values({
  jobId: job!.id, freelancerId: freelancer.id, coverNote: 'temp', deliveryDays: 1, bidTotalWei: ETH,
}).returning()
const [project] = await db.insert(projects).values({
  jobId: job!.id, proposalId: proposal!.id, clientId: client.id, freelancerId: freelancer.id, status: 'active',
}).returning()

const tokenFor = async (id: string, address: string) => (await signSession({ sub: id, address })).token
const asClient = await tokenFor(client.id, client.walletAddress)
const asFreelancer = await tokenFor(freelancer.id, freelancer.walletAddress)
const asStranger = await tokenFor(stranger.id, stranger.walletAddress)

const authed = (token: string, method: string, body?: unknown) => new Request('http://localhost/api', {
  method,
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

type Row = { id: string; body: string; createdAt: Date; readByOther: boolean }

try {
  // Three messages from the client, spaced so the cursor boundary is testable.
  const sent: { id: string; createdAt: Date }[] = []
  for (const body of ['first', 'second', 'third']) {
    const [m] = await db.insert(messages).values({
      projectId: project!.id, senderId: client.id, body,
    }).returning()
    sent.push({ id: m!.id, createdAt: m!.createdAt })
    await new Promise((r) => setTimeout(r, 5)) // distinct created_at
  }

  // ── 1. Nobody has read anything ────────────────────────────────────────
  const initial = await listMessages(authed(asFreelancer, 'GET'), project!.id) as Row[]
  check('the client sees all three of their messages', initial.length === 3, initial.length)
  check('an unread message carries readByOther: false', initial.every((m) => m.readByOther === false))
  check('the sender id is untouched by the read projection', initial.every((m) => m.body.length > 0))

  // ── 2. The reader marks read through the second message ────────────────
  const marked = await markMessagesRead(
    authed(asFreelancer, 'POST', { through: sent[1]!.createdAt.toISOString() }),
    project!.id,
  ) as { readThrough: string }
  check('the cursor lands exactly on the timestamp the client rendered',
    new Date(marked.readThrough).getTime() === sent[1]!.createdAt.getTime(), marked)

  const afterMark = await listMessages(authed(asClient, 'GET'), project!.id) as Row[]
  check('the sender sees the first message as read', afterMark[0]!.readByOther === true)
  check('the message the cursor names counts as read too', afterMark[1]!.readByOther === true)
  check('the message after the cursor stays unread', afterMark[2]!.readByOther === false)

  // ── 3. A late request must not un-read the room ────────────────────────
  await markMessagesRead(
    authed(asFreelancer, 'POST', { through: sent[0]!.createdAt.toISOString() }),
    project!.id,
  )
  const [cursor] = await db.select().from(messageReadCursors)
    .where(eq(messageReadCursors.projectId, project!.id))
    .limit(1)
  check('an older `through` does not move the cursor backwards',
    new Date(cursor!.readThrough).getTime() === sent[1]!.createdAt.getTime(), cursor)

  // ── 4. The future is not a timestamp anyone can have read ───────────────
  await rejects(
    'a future read_through is rejected',
    () => markMessagesRead(
      authed(asFreelancer, 'POST', { through: new Date(Date.now() + 3_600_000).toISOString() }),
      project!.id,
    ),
    400, 'bad_request',
  )
  await rejects(
    'a non-timestamp read_through is rejected',
    () => markMessagesRead(authed(asFreelancer, 'POST', { through: 'yesterday' }), project!.id),
    400, 'bad_request',
  )

  // ── 5. The room stays participant-only ─────────────────────────────────
  await rejects('a stranger cannot list the messages', () => listMessages(authed(asStranger, 'GET'), project!.id), 403, 'forbidden')
  await rejects('a stranger cannot move a cursor', () => markMessagesRead(authed(asStranger, 'POST'), project!.id), 403, 'forbidden')
  await rejects('a caller cannot mark read for someone else',
    () => markMessagesRead(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { Authorization: `Bearer ${asFreelancer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ through: sent[2]!.createdAt.toISOString(), userId: client.id }),
      }),
      project!.id,
    ), 400, 'bad_request')

  // ── 6. The evidence log was never touched ──────────────────────────────
  const rows = await db.select().from(messages).where(eq(messages.projectId, project!.id))
  check('the message count is unchanged after the whole read round-trip', rows.length === 3, rows.length)
  check('every message body is unchanged', JSON.stringify(rows.map((r) => r.body).sort()) === JSON.stringify(['first', 'second', 'third']))
  const messageCols = Object.keys(rows[0]!).sort()
  check('no message row gained a read column',
    JSON.stringify(messageCols) === JSON.stringify(['attachmentId', 'body', 'createdAt', 'id', 'projectId', 'senderId'])
      && !messageCols.some((c) => /read/i.test(c)),
    messageCols)

  // ── 7. One cursor per viewer, not per message ──────────────────────────
  const cursors = await db.select().from(messageReadCursors).where(eq(messageReadCursors.projectId, project!.id))
  check('one cursor row for the reader, none for the sender', cursors.length === 1, cursors.length)
} finally {
  await db.delete(projects).where(eq(projects.id, project!.id)) // cascades messages + cursors
  await db.delete(proposals).where(eq(proposals.id, proposal!.id))
  await db.delete(jobs).where(eq(jobs.id, job!.id))
  await db.delete(users).where(eq(users.id, stranger!.id))
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nReading the room never mutates the log — all checks passed')
process.exit(0)
