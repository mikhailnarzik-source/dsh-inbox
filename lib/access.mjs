/**
 * The allow-list: which Telegram chats may control this DSH installation.
 *
 * The bot is a remote control for the whole Harness, so an empty list means
 * "nobody", not "everybody": a chat must be added explicitly, from the plugin
 * page or by the agent's `telegram_allow` tool. The denial notice to an
 * unknown chat is rate-limited per chat, because a stranger retrying a command
 * must not turn the bot into a spam relay.
 */

import { normalizeChatId, normalizeChatIds } from './storage.mjs'

/** How often one unknown chat is told about the missing access. */
export const DENY_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Whether the chat may control DSH.
 * @param state - current state.
 * @param chatId - Telegram chat id.
 * @returns true only when the id is in the allow-list.
 */
export function isChatAllowed(state, chatId) {
  const id = String(chatId ?? '').trim()
  if (id === '') return false
  return Array.isArray(state.allowedChatIds) && state.allowedChatIds.includes(id)
}

/**
 * Add one chat to the list.
 * @param state - current state.
 * @param chatId - Telegram chat id.
 * @returns `{ state, changed }`; an invalid id leaves the state unchanged.
 */
export function allowChat(state, chatId) {
  const id = normalizeChatId(chatId)
  if (id === '') return { state, changed: false }
  if (isChatAllowed(state, id)) return { state, changed: false }
  return { state: { ...state, allowedChatIds: normalizeChatIds([...state.allowedChatIds, id]) }, changed: true }
}

/**
 * Remove one chat from the list; its session routing is dropped too.
 * @param state - current state.
 * @param chatId - Telegram chat id.
 * @returns `{ state, changed }`.
 */
export function denyChat(state, chatId) {
  const id = normalizeChatId(chatId)
  if (id === '') return { state, changed: false }
  if (!isChatAllowed(state, id)) return { state, changed: false }
  const current = { ...state.currentChatSession }
  const pending = { ...state.pendingLists }
  delete current[id]
  delete pending[id]
  return {
    state: {
      ...state,
      allowedChatIds: state.allowedChatIds.filter(item => item !== id),
      currentChatSession: current,
      pendingLists: pending,
    },
    changed: true,
  }
}

/**
 * Build a per-chat rate limiter for the "no access" notice.
 * @param now - clock, injectable for tests.
 * @returns `{ shouldNotify(chatId), reset() }`.
 */
export function createDenyLimiter(now = () => Date.now()) {
  const last = new Map()
  return {
    /**
     * Whether the chat should receive the notice now; records the moment when
     * it returns true.
     * @param chatId - Telegram chat id.
     * @returns true at most once per DENY_COOLDOWN_MS per chat.
     */
    shouldNotify(chatId) {
      const id = String(chatId ?? '')
      if (id === '') return false
      const at = now()
      const previous = last.get(id)
      if (Number.isFinite(previous) && at - previous < DENY_COOLDOWN_MS) return false
      last.set(id, at)
      return true
    },
    /** Forget every recorded moment. */
    reset() {
      last.clear()
    },
  }
}
