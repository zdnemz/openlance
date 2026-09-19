/**
 * Notification outbox (PRD F9). One row per domain event; webhook delivery is
 * a separate, retryable concern.
 *
 * Fan-out model:
 *   1. `writeOutbox(tx, n)` records the event and (a) materialises per-user
 *      inbox rows in `notification_recipients` and (b) creates pending webhook
 *      deliveries for matching active subscriptions.
 *   2. Recipients are DERIVED here from the event's project/milestone/actor and
 *      payload — emit call sites stay dumb (they describe the event, not the
 *      audience).
 *   3. A recipient who is also the actor is still notified (their own copy is
 *      marked read) — other participants always see the change.
 *
 * Shared by API routes and the chain indexer, so it must never throw on the
 * happy path: audience resolution is best-effort and degrades to "no recipients".
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDb, type Db } from '../db'
import { getQueues } from '../lib/queue'
import type { NotificationType, WebhookEnvelope } from '../domain/notifications'
import {
  disputes, notificationPreferences, notificationRecipients, notificationEvents,
  projectMilestones, projects, users, webhookDeliveries, webhookSubscriptions,
} from '../db/schema'

export interface NotifyInput {
  /** A canonical type, or any string for externally-sourced (inbound) events. */
  type: NotificationType | (string & {})
  actorAddress?: string | null
  projectId?: string | null
  milestoneId?: string | null
  payload?: Record<string, unknown>
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Resolve the user ids that should see `n` in their inbox. Best-effort:
 * unknown scopes yield an empty audience rather than throwing.
 */
async function resolveRecipients(tx: Tx, n: NotifyInput): Promise<{ userId: string; isActor: boolean }[]> {
  const ids = new Set<string>()
  const actor = n.actorAddress?.toLowerCase() ?? null

  if (n.projectId) {
    const [project] = await tx.select().from(projects).where(eq(projects.id, n.projectId)).limit(1)
    if (project) {
      ids.add(project.clientId)
      ids.add(project.freelancerId)
    }
  }

  // Dispute round events additionally reach the selected arbiters (by address).
  if (n.type.startsWith('dispute.') && n.milestoneId) {
    const arbiterAddresses = new Set<string>()
    const [d] = await tx.select().from(disputes).where(eq(disputes.milestoneId, n.milestoneId)).limit(1)
    const selected = d && Array.isArray(d.selectedArbiters) ? (d.selectedArbiters as string[]) : []
    for (const a of selected) arbiterAddresses.add(a.toLowerCase())
    for (const a of asStrings(n.payload?.selectedArbiters)) arbiterAddresses.add(a.toLowerCase())
    if (arbiterAddresses.size) {
      const arbiters = await tx.select({ id: users.id }).from(users)
        .where(inArray(users.walletAddress, [...arbiterAddresses]))
      for (const u of arbiters) ids.add(u.id)
    }
  }

  // Review events target the reviewee explicitly when supplied.
  const reviewee = typeof n.payload?.revieweeAddress === 'string' ? n.payload.revieweeAddress.toLowerCase() : null
  if (reviewee) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.walletAddress, reviewee)).limit(1)
    if (u) ids.add(u.id)
  }

  // Proposal events target the job poster (who is not necessarily a project party yet).
  const poster = typeof n.payload?.posterAddress === 'string' ? n.payload.posterAddress.toLowerCase() : null
  if (poster) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.walletAddress, poster)).limit(1)
    if (u) ids.add(u.id)
  }

  // Never notify a user about their own action within the same inbox? We DO — but
  // resolve `isActor` so the caller can pre-mark their copy as read.
  const actorUser = actor
    ? (await tx.select({ id: users.id }).from(users).where(eq(users.walletAddress, actor)).limit(1))[0]
    : undefined

  return [...ids].map((id) => ({ userId: id, isActor: actorUser?.id === id }))
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Which notification types a user has muted (row exists with muted=true). */
async function mutedTypes(tx: Tx, userIds: string[], type: string): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await tx.select().from(notificationPreferences)
    .where(and(
      inArray(notificationPreferences.userId, userIds),
      inArray(notificationPreferences.eventType, [type, '*']),
      eq(notificationPreferences.muted, true),
    ))
  return new Set(rows.map((r) => r.userId))
}

/**
 * Insert the event, project it into each recipient's inbox, and fan out to
 * matching webhook subscriptions — all inside the caller's transaction.
 * Returns the pending webhook-delivery ids to enqueue after commit.
 */
export async function writeOutbox(tx: Tx, n: NotifyInput): Promise<string[]> {
  const [event] = await tx.insert(notificationEvents).values({
    type: n.type,
    actorAddress: n.actorAddress?.toLowerCase() ?? null,
    projectId: n.projectId ?? null,
    milestoneId: n.milestoneId ?? null,
    payload: n.payload ?? {},
  }).returning({ id: notificationEvents.id })
  if (!event) return []

  // ── 1. In-app inbox projection ───────────────────────────────────────────
  const recipients = await resolveRecipients(tx, n)
  if (recipients.length) {
    const muted = await mutedTypes(tx, recipients.map((r) => r.userId), n.type)
    const visible = recipients.filter((r) => !muted.has(r.userId))
    if (visible.length) {
      await tx.insert(notificationRecipients).values(visible.map((r) => ({
        eventId: event.id,
        userId: r.userId,
        // the actor's own copy starts read so "unread" means "someone else acted"
        readAt: r.isActor ? new Date() : null,
      }))).onConflictDoNothing()
    }
  }

  // ── 2. Webhook fan-out ───────────────────────────────────────────────────
  const subs = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true))
  const matching = subs.filter((s) => s.eventTypes.length === 0 || s.eventTypes.includes(n.type))
  if (matching.length === 0) return []

  const envelope: WebhookEnvelope = {
    id: event.id, type: n.type, ts: new Date().toISOString(),
    actor: n.actorAddress?.toLowerCase() ?? null,
    projectId: n.projectId ?? null, milestoneId: n.milestoneId ?? null,
    payload: n.payload ?? {},
  }
  const rows = await tx.insert(webhookDeliveries).values(
    matching.map((s) => ({
      subscriptionId: s.id, eventId: event.id, envelope, status: 'pending' as const,
    })),
  ).returning({ id: webhookDeliveries.id })
  return rows.map((r) => r.id)
}

/** Standalone emission for API routes: outbox in one tx, enqueue after commit. */
export async function emitNotification(n: NotifyInput): Promise<void> {
  const deliveryIds = await (getDb()).transaction(async (tx) => writeOutbox(tx, n))
  if (deliveryIds.length) {
    const queues = await getQueues()
    await Promise.all(deliveryIds.map((id) => queues.enqueueWebhookDelivery(id)))
  }
}

// ── Inbox read model ────────────────────────────────────────────────────────

export interface InboxItem {
  id: string
  eventId: string
  type: string
  actorAddress: string | null
  projectId: string | null
  milestoneId: string | null
  payload: Record<string, unknown>
  readAt: string | null
  createdAt: string
}

/** Most recent inbox items for a user, newest first. `unreadOnly` filters to unread. */
export async function listInbox(
  userId: string,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
): Promise<InboxItem[]> {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const where = opts.unreadOnly
    ? and(eq(notificationRecipients.userId, userId), isNull(notificationRecipients.readAt))
    : eq(notificationRecipients.userId, userId)

  const rows = await db.select({
    id: notificationRecipients.id,
    eventId: notificationRecipients.eventId,
    readAt: notificationRecipients.readAt,
    createdAt: notificationRecipients.createdAt,
    type: notificationEvents.type,
    actorAddress: notificationEvents.actorAddress,
    projectId: notificationEvents.projectId,
    milestoneId: notificationEvents.milestoneId,
    payload: notificationEvents.payload,
  }).from(notificationRecipients)
    .innerJoin(notificationEvents, eq(notificationEvents.id, notificationRecipients.eventId))
    .where(where)
    .orderBy(notificationRecipients.createdAt)
    .limit(limit)
    .offset(offset)
  // newest first
  return rows.reverse().map((r) => ({
    id: r.id,
    eventId: r.eventId,
    type: r.type,
    actorAddress: r.actorAddress,
    projectId: r.projectId,
    milestoneId: r.milestoneId,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function unreadCount(userId: string): Promise<number> {
  const db = getDb()
  const rows = await db.select({ id: notificationRecipients.id }).from(notificationRecipients)
    .where(and(eq(notificationRecipients.userId, userId), isNull(notificationRecipients.readAt)))
  return rows.length
}

/** Mark specific inbox items (or all when ids omitted) as read. Returns count. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  const db = getDb()
  const scope = ids && ids.length
    ? and(eq(notificationRecipients.userId, userId), inArray(notificationRecipients.id, ids), isNull(notificationRecipients.readAt))
    : and(eq(notificationRecipients.userId, userId), isNull(notificationRecipients.readAt))
  const updated = await db.update(notificationRecipients).set({ readAt: new Date() })
    .where(scope).returning({ id: notificationRecipients.id })
  return updated.length
}

// ── Preferences ─────────────────────────────────────────────────────────────

export interface PreferenceView {
  eventType: string
  muted: boolean
}

export async function listPreferences(userId: string): Promise<PreferenceView[]> {
  const db = getDb()
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId))
  return rows.map((r) => ({ eventType: r.eventType, muted: r.muted }))
}

/** Upsert a single (userId, eventType) mute flag. `eventType` = '*' sets the global default. */
export async function setPreference(userId: string, eventType: string, muted: boolean): Promise<PreferenceView> {
  const db = getDb()
  const [row] = await db.insert(notificationPreferences)
    .values({ userId, eventType, muted })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.eventType],
      set: { muted, updatedAt: new Date() },
    })
    .returning()
  return { eventType: row!.eventType, muted: row!.muted }
}
