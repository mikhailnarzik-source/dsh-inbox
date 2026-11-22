/**
 * Who may control DSH from Telegram.
 *
 * The allow-list is keyed by the Telegram **user id** (`from.id`), not the chat
 * id: a private chat's id usually equals the user id, but a group chat's does
 * not, and a bot in a group must never let any member drive DSH. Groups are
 * denied by default. The first person who allows themselves becomes the owner;
 * the owner may only be changed from the local plugin page.
 */

import { normalizeChatIds, normalizeChatId } from './storage.mjs'

/** One command per chat may start every this many milliseconds. */
export const RATE_WINDOW_MS = 1500

/** Hard hourly cap of commands per chat. */
export const RATE_HOUR_LIMIT = 30

/** The one-hour window used by {@link RATE_HOUR_LIMIT}. */
export const HOUR_MS = 60 * 60 * 1000

/** Whether the chat is a private conversation (missing type counts as private). */
export function isPrivateChat(chatType) {
  return chatType === undefined || chatType === null || chatType === 'private'
}

/** Normalise a Telegram user id to a string. */
export function senderId(chatId, fromId) {
  const from = String(fromId ?? '').trim()
  if (/^\d{1,20}$/.test(from)) return from
  return normalizeChatId(chatId)
}

/**
 * Decide whether this update may run a command.
 * @param state - plugin state with `allowedUserIds` and `security`.
 * @param update - `{ chatId, fromId, chatType }`.
 * @returns `{ allowed, reason }`; reasons: group, no-user, not-listed.
 */
export function checkSender(state, update) {
  const chatType = update?.chatType
  const groupsEnabled = state?.security?.groupsEnabled === true
  if (!groupsEnabled && !isPrivateChat(chatType)) return { allowed: false, reason: 'group' }
  const id = senderId(update?.chatId, update?.fromId)
  if (id === '') return { allowed: false, reason: 'no-user' }
  const allowed = Array.isArray(state?.allowedUserIds) ? state.allowedUserIds : []
  if (!allowed.includes(id)) return { allowed: false, reason: 'not-listed' }
  return { allowed: true, reason: '', userId: id }
}

/**
 * Add one user to the allow-list and make them the owner when there is none.
 * @param state - current state.
 * @param update - `{ chatId, fromId, fromName, chatTitle }`.
 * @returns `{ state, changed }`.
 */
export function allowSender(state, update) {
  const id = senderId(update?.chatId, update?.fromId)
  if (id === '') return { state, changed: false }
  const allowed = Array.isArray(state.allowedUserIds) ? [...state.allowedUserIds] : []
  const changed = !allowed.includes(id)
  if (changed) allowed.push(id)
  const next = {
    ...state,
    allowedUserIds: normalizeChatIds(allowed),
    allowedChatIds: normalizeChatIds(allowed),
  }
  // The first allowed sender owns this installation; later changes stay local.
  if (!next.ownerUserId) {
    next.ownerUserId = id
    next.ownerChatId = normalizeChatId(update?.chatId) || ''
  }
  return { state: next, changed: changed || next.ownerUserId !== state.ownerUserId }
}

/**
 * Remove one user from the allow-list. The owner is kept unless `includeOwner`.
 * @param state - current state.
 * @param userId - user id to drop.
 * @param options - `{ includeOwner?: boolean }`.
 * @returns `{ state, changed }`.
 */
export function denySender(state, userId, options = {}) {
  const id = normalizeChatId(userId)
  if (id === '') return { state, changed: false }
  if (id === state.ownerUserId && options.includeOwner !== true) return { state, changed: false }
  const allowed = (Array.isArray(state.allowedUserIds) ? state.allowedUserIds : []).filter(item => item !== id)
  return {
    state: {
      ...state,
      allowedUserIds: allowed,
      allowedChatIds: allowed,
      ownerUserId: id === state.ownerUserId ? '' : state.ownerUserId,
      ownerChatId: id === state.ownerUserId ? '' : state.ownerChatId,
    },
    changed: allowed.length !== (state.allowedUserIds ?? []).length,
  }
}

/**
 * Build the per-chat rate limiter.
 * @param options - `{ now?, windowMs?, hourLimit? }`; `windowMs=0` or
 *   `hourLimit=0` disables the matching rule (tests use that).
 * @returns `{ check(chatId), reset() }`.
 */
export function createRateLimiter(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : RATE_WINDOW_MS
  const hourLimit = Number.isFinite(options.hourLimit) ? options.hourLimit : RATE_HOUR_LIMIT
  const last = new Map()
  const hourly = new Map()
  return {
    /**
     * @param chatId - Telegram chat id.
     * @returns `{ ok, retryAfterMs?, reason? }`.
     */
    check(chatId) {
      const key = String(chatId ?? '')
      if (key === '') return { ok: false, retryAfterMs: 0, reason: 'no-chat' }
      const at = now()
      const previous = last.get(key)
      if (windowMs > 0 && Number.isFinite(previous) && at - previous < windowMs) {
        return { ok: false, retryAfterMs: windowMs - (at - previous), reason: 'window' }
      }
      if (hourLimit > 0) {
        const hits = (hourly.get(key) ?? []).filter(time => at - time < HOUR_MS)
        if (hits.length >= hourLimit) {
          return { ok: false, retryAfterMs: HOUR_MS - (at - hits[0]), reason: 'hour' }
        }
        hits.push(at)
        hourly.set(key, hits)
      }
      last.set(key, at)
      return { ok: true }
    },
    /** Forget every recorded moment. */
    reset() {
      last.clear()
      hourly.clear()
    },
  }
}

/**
 * Build an update-id deduplicator: a batch re-read after a failed push must not
 * run its commands twice.
 * @param max - how many recent ids to remember.
 * @returns `{ seen(updateId) }` — true the first time, false afterwards.
 */
export function createUpdateDeduper(max = 1000) {
  const seenIds = new Set()
  const order = []
  return {
    seen(updateId) {
      const id = String(updateId ?? '')
      if (id === '') return false
      if (seenIds.has(id)) return true
      seenIds.add(id)
      order.push(id)
      while (order.length > max) {
        const oldest = order.shift()
        seenIds.delete(oldest)
      }
      return false
    },
  }
}
