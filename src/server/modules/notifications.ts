/**
 * /notifications — HTTP surface over the inbox projection (PRD F9).
 *
 * The read model + mutation logic live in `notify.ts`; this module adds auth,
 * validation and pagination so route handlers stay one-liners.
 */
import { z } from 'zod'
import { requireAuth, requireKyc } from '../auth/middleware'
import { pagination, validate } from '../lib/http'
import { NOTIFICATION_TYPES } from '../domain/notifications'
import {
  listInbox, listPreferences, markRead, setPreference, unreadCount,
} from './notify'

export async function getInbox(request: Request) {
  const user = await requireAuth(request)
  const url = new URL(request.url)
  const { limit, offset } = pagination(url, 30, 100)
  const unreadOnly = url.searchParams.get('unread') === 'true'
  const [items, unread] = await Promise.all([
    listInbox(user.id, { limit, offset, unreadOnly }),
    unreadCount(user.id),
  ])
  return { items, unread }
}

export async function getUnreadCount(request: Request) {
  const user = await requireAuth(request)
  return { unread: await unreadCount(user.id) }
}

export async function markNotificationsRead(request: Request) {
  const user = await requireKyc(request)
  const body = await validate(request, z.object({
    ids: z.array(z.string().uuid()).max(200).optional(),
  }).strict().default({}))
  const updated = await markRead(user.id, body.ids)
  return { updated, unread: await unreadCount(user.id) }
}

export async function getPreferences(request: Request) {
  const user = await requireAuth(request)
  return {
    types: NOTIFICATION_TYPES,
    preferences: await listPreferences(user.id),
  }
}

export async function updatePreference(request: Request) {
  const user = await requireKyc(request)
  const body = await validate(request, z.object({
    eventType: z.union([z.literal('*'), z.enum(NOTIFICATION_TYPES)]),
    muted: z.boolean(),
  }).strict())
  return setPreference(user.id, body.eventType, body.muted)
}
