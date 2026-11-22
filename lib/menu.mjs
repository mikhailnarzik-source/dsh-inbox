/**
 * The Telegram menu surface: the command list Telegram shows behind «/», the
 * persistent reply keyboard at the bottom of the chat, and the inline buttons
 * attached to `/sessions` and `/status`.
 *
 * Telegram only accepts latin lowercase command names, so the command list is
 * `help`, `status`, … while every description and every button label is Russian
 * and lives in `replies.mjs`. Callback data stays short: `use:<sessionId>` is a
 * few dozen bytes, well inside Telegram's 64-byte limit.
 */

import { MENU_LABELS, REPLIES } from './replies.mjs'

/** Version of the command list; a bump makes the bot re-publish it. */
export const MENU_VERSION = '0.5.0'

/** How long a published command list is trusted. */
export const COMMANDS_TTL_MS = 24 * 60 * 60 * 1000

/** How many sessions one `/sessions` keyboard carries. */
export const MAX_SESSION_BUTTONS = 10

/**
 * The command list for Telegram's «/» menu.
 * Descriptions are Russian; command names must stay latin lowercase.
 */
export const COMMANDS_MENU = [
  { command: 'help', description: 'Помощь' },
  { command: 'status', description: 'Состояние' },
  { command: 'sessions', description: 'Сессии' },
  { command: 'use', description: 'Выбрать сессию' },
  { command: 'ask', description: 'Спросить в сессию' },
  { command: 'steer', description: 'Вклиниться' },
  { command: 'new', description: 'Новая сессия' },
  { command: 'cancel', description: 'Прервать' },
  { command: 'last', description: 'Последние входящие' },
  { command: 'menu', description: 'Показать меню' },
]

/**
 * What a pressed reply-keyboard button means.
 * `hint` answers with instructions instead of running a command.
 */
export const MENU_BUTTON_ACTIONS = {
  [MENU_LABELS.sessions]: { command: 'sessions' },
  [MENU_LABELS.newSession]: { hint: 'new' },
  [MENU_LABELS.cancel]: { command: 'cancel' },
  [MENU_LABELS.status]: { command: 'status' },
  [MENU_LABELS.help]: { command: 'help' },
}

/** The persistent keyboard attached to the bottom of the chat. */
export function replyKeyboard() {
  return {
    keyboard: [
      [{ text: MENU_LABELS.sessions }, { text: MENU_LABELS.newSession }],
      [{ text: MENU_LABELS.cancel }, { text: MENU_LABELS.status }],
      [{ text: MENU_LABELS.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}

/** Short session label for a button. */
function buttonTitle(row, index) {
  const name = row.title === '' ? String(row.sessionId).slice(0, 8) : row.title
  return `${index + 1}. ${name} — ${row.running ? REPLIES.running : REPLIES.idle}`
}

/**
 * Inline keyboard with one button per session plus refresh/status.
 * @param rows - sessions from the gateway.
 * @returns an `inline_keyboard` payload.
 */
export function sessionsInlineKeyboard(rows) {
  const list = Array.isArray(rows) ? rows.slice(0, MAX_SESSION_BUTTONS) : []
  const keyboard = list.map((row, index) => [{
    text: buttonTitle(row, index),
    callback_data: `use:${row.sessionId}`,
  }])
  keyboard.push([
    { text: MENU_LABELS.refresh, callback_data: 'sessions:refresh' },
    { text: MENU_LABELS.status, callback_data: 'status' },
  ])
  return { inline_keyboard: keyboard }
}

/**
 * Inline keyboard shown after one session is chosen.
 * @param sessionId - chosen session.
 * @returns an `inline_keyboard` payload.
 */
export function sessionInlineKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.ask, callback_data: 'ask' },
        { text: MENU_LABELS.cancel, callback_data: `cancel:${sessionId}` },
      ],
      [
        { text: MENU_LABELS.refresh, callback_data: 'sessions:refresh' },
        { text: MENU_LABELS.status, callback_data: 'status' },
      ],
    ],
  }
}

/**
 * Inline keyboard of `/status`: cancel, menu, help.
 * @param sessionId - current session of the chat, may be ''.
 * @returns an `inline_keyboard` payload.
 */
export function statusInlineKeyboard(sessionId) {
  return {
    inline_keyboard: [[
      { text: MENU_LABELS.cancel, callback_data: sessionId === '' ? 'cancel' : `cancel:${sessionId}` },
      { text: MENU_LABELS.menu, callback_data: 'menu' },
      { text: MENU_LABELS.help, callback_data: 'help' },
    ]],
  }
}

/**
 * Inline keyboard of `/help`.
 * @returns an `inline_keyboard` payload.
 */
export function helpInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.sessions, callback_data: 'sessions:refresh' },
        { text: MENU_LABELS.status, callback_data: 'status' },
      ],
      [{ text: MENU_LABELS.menu, callback_data: 'menu' }],
    ],
  }
}

/**
 * The main inline menu shown by `/start`, `/menu` and the «🏠 Меню» button.
 * @returns an `inline_keyboard` payload.
 */
export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.sessions, callback_data: 'sessions:1' },
        { text: MENU_LABELS.newSession, callback_data: 'newhint' },
      ],
      [
        { text: MENU_LABELS.status, callback_data: 'status' },
        { text: MENU_LABELS.settings, callback_data: 'settings' },
      ],
      [
        { text: MENU_LABELS.help, callback_data: 'help' },
      ],
    ],
  }
}

/**
 * Keyboard of the sessions screen: one button per visible session, pagination
 * and the mode switch. Session buttons use short `use:<index>` data resolved
 * through the list remembered for the chat.
 * @param request - `{ page, pages, all }`.
 * @returns an `inline_keyboard` payload.
 */
export function sessionsScreenKeyboard({ page = 1, pages = 1, all = false } = {}) {
  const prefix = all ? 'sessionsall' : 'sessions'
  const keyboard = []
  const nav = []
  if (page > 1) nav.push({ text: MENU_LABELS.back, callback_data: `${prefix}:${page - 1}` })
  nav.push({ text: `${page}/${pages}`, callback_data: 'noop' })
  if (page < pages) nav.push({ text: MENU_LABELS.forward, callback_data: `${prefix}:${page + 1}` })
  keyboard.push(nav)
  keyboard.push([
    { text: MENU_LABELS.refreshShort, callback_data: `${all ? 'refreshall' : 'refresh'}:${page}` },
    { text: all ? MENU_LABELS.projectSessions : MENU_LABELS.allSessions, callback_data: all ? 'sessions:1' : 'sessionsall:1' },
    { text: MENU_LABELS.menu, callback_data: 'menu' },
  ])
  return { inline_keyboard: keyboard }
}

/**
 * Keyboard shown after one session is selected.
 * @returns an `inline_keyboard` payload.
 */
export function selectedSessionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.write, callback_data: 'askhint', style: 'primary' },
        { text: MENU_LABELS.stop, callback_data: 'stop', style: 'danger' },
      ],
      [
        { text: MENU_LABELS.refreshShort, callback_data: 'sessions:1' },
        { text: MENU_LABELS.menu, callback_data: 'menu' },
      ],
    ],
  }
}

/**
 * Keyboard of the status screen: stop, sessions and the home button.
 * @returns an `inline_keyboard` payload.
 */
export function statusScreenKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.stop, callback_data: 'stop', style: 'danger' },
        { text: MENU_LABELS.sessions, callback_data: 'sessions:1' },
        { text: MENU_LABELS.menu, callback_data: 'menu' },
      ],
    ],
  }
}

/** Keyboard of the settings screen. */
export function settingsScreenKeyboard() {
  return { inline_keyboard: [[{ text: MENU_LABELS.menu, callback_data: 'menu' }]] }
}

/** Keyboard of the help screen. */
export function helpScreenKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: MENU_LABELS.sessions, callback_data: 'sessions:1' },
        { text: MENU_LABELS.settings, callback_data: 'settings' },
        { text: MENU_LABELS.menu, callback_data: 'menu' },
      ],
    ],
  }
}

/**
 * Parse one `callback_data` value.
 * @param data - raw callback data.
 * @returns `{ action, sessionId?, index?, page? }`.
 */
export function parseCallbackData(data) {
  const text = typeof data === 'string' ? data : ''
  // New short scheme of 0.5.0.
  if (text === 'noop') return { action: 'noop' }
  if (text === 'status') return { action: 'status' }
  if (text === 'settings') return { action: 'settings' }
  if (text === 'help') return { action: 'help' }
  if (text === 'menu') return { action: 'menu' }
  if (text === 'askhint') return { action: 'ask-hint' }
  if (text === 'newhint') return { action: 'new-hint' }
  if (text === 'stop') return { action: 'stop' }
  let match = /^sessionsall:(\d{1,3})$/.exec(text)
  if (match !== null) return { action: 'sessions-all', page: Number(match[1]) }
  match = /^sessions:(\d{1,3})$/.exec(text)
  if (match !== null) return { action: 'sessions', page: Number(match[1]) }
  match = /^refreshall:(\d{1,3})$/.exec(text)
  if (match !== null) return { action: 'refresh-all', page: Number(match[1]) }
  match = /^refresh:(\d{1,3})$/.exec(text)
  if (match !== null) return { action: 'refresh', page: Number(match[1]) }
  match = /^use:(\d{1,3})$/.exec(text)
  if (match !== null) return { action: 'use', index: Number(match[1]) }
  // Older scheme kept for messages sent before the update.
  if (text === 'sessions:refresh') return { action: 'sessions-refresh' }
  if (text === 'ask') return { action: 'ask' }
  if (text === 'cancel') return { action: 'cancel', sessionId: '' }
  if (text.startsWith('cancel:')) return { action: 'cancel', sessionId: text.slice(7) }
  if (text.startsWith('use:')) return { action: 'use', sessionId: text.slice(4) }
  return { action: 'unknown', data: text }
}

/**
 * Whether the command list must be published again.
 * @param cache - `state.commandsMenu` (`{ version, at, ok }`).
 * @param now - current epoch milliseconds.
 * @param version - version of the local command list.
 * @returns true for a version change, a failed last attempt, or an expired cache.
 */
export function shouldRefreshCommands(cache, now = Date.now(), version = MENU_VERSION) {
  if (cache === null || typeof cache !== 'object') return true
  if (cache.version !== version) return true
  if (cache.ok !== true) return true
  const at = Number(cache.at)
  if (!Number.isFinite(at) || at <= 0) return true
  return now - at >= COMMANDS_TTL_MS
}
