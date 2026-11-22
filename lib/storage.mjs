/**
 * History storage of the Inbox plugin.
 *
 * One JSON file holds the Telegram polling offset, the receive switch, the bot
 * name and up to 200 messages. Everything is plain JSON so another DSH version
 * can read it. The bot token is never written here: it lives only in the DSH
 * credential store.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { stateFile } from './paths.mjs'

/** Layout version of the state file. version 2 adds the allow-list and session routing. */
export const STATE_VERSION = 2

/** How many messages the history keeps; older ones are dropped. */
export const MAX_MESSAGES = 200

/** Upper bound of the allow-list, so a broken input cannot bloat the file. */
export const MAX_CHAT_IDS = 100

/** Upper bound of one `/sessions` answer remembered per chat. */
export const MAX_PENDING_SESSIONS = 20

/** Message directions the history understands. */
export const DIRECTIONS = ['in', 'out']

/** A state value with nothing in it. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedChatIds: [],
    currentChatSession: {},
    pendingLists: {},
    messages: [],
  }
}

/** Convert a value to a trimmed string, or to ''. */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Validate one Telegram chat id: an integer, negative for groups.
 * @param value - unknown input.
 * @returns the trimmed id, or '' when it is not a chat id.
 */
export function normalizeChatId(value) {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : text(value).trim()
  return /^-?\d{1,20}$/.test(candidate) ? candidate : ''
}

/**
 * Clean a chat-id list: valid integers only, order kept, duplicates dropped.
 * @param value - unknown input.
 * @returns the clean list, at most MAX_CHAT_IDS entries.
 */
export function normalizeChatIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const result = []
  for (const item of value) {
    const id = normalizeChatId(item)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= MAX_CHAT_IDS) break
  }
  return result
}

/** Clean the `{ chatId: sessionId }` routing map. */
function normalizeSessionMap(value) {
  const result = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, sessionId] of Object.entries(value)) {
    const chatId = normalizeChatId(key)
    const id = text(sessionId).trim()
    if (chatId === '' || id === '') continue
    result[chatId] = id
  }
  return result
}

/** Clean the `{ chatId: [sessionId...] }` lists remembered from `/sessions`. */
function normalizePendingLists(value) {
  const result = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, list] of Object.entries(value)) {
    const chatId = normalizeChatId(key)
    if (chatId === '' || !Array.isArray(list)) continue
    const ids = list
      .map(item => text(item).trim())
      .filter(item => item !== '')
      .slice(0, MAX_PENDING_SESSIONS)
    result[chatId] = [...new Set(ids)]
  }
  return result
}

/**
 * Validate and normalise one history record.
 * @param value - unknown record from disk or from a Telegram update.
 * @returns the clean record, or `undefined` when it cannot be used.
 */
export function sanitizeMessage(value) {
  if (value === null || typeof value !== 'object') return undefined
  const chatId = text(value.chatId).trim()
  if (chatId === '') return undefined
  const direction = value.direction === 'out' ? 'out' : value.direction === 'in' ? 'in' : undefined
  if (direction === undefined) return undefined
  const parsed = Date.parse(text(value.at))
  return {
    chatId,
    chatTitle: text(value.chatTitle).trim() || chatId,
    from: text(value.from).trim(),
    text: text(value.text),
    at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : '',
    direction,
    // Only a true flag is kept: the field is present exactly for messages from
    // chats outside the allow-list, so the history stays compact.
    ...(value.blocked === true ? { blocked: true } : {}),
  }
}

/**
 * Accept anything read from disk and return a usable state.
 * @param raw - parsed JSON or any other value.
 * @returns the normalised state; invalid parts fall back to defaults.
 */
export function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  if (Number.isFinite(raw.offset) && raw.offset >= 0) state.offset = Math.floor(raw.offset)
  if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled
  if (typeof raw.botUsername === 'string') state.botUsername = raw.botUsername.replace(/^@/, '').trim()
  state.allowedChatIds = normalizeChatIds(raw.allowedChatIds)
  state.currentChatSession = normalizeSessionMap(raw.currentChatSession)
  state.pendingLists = normalizePendingLists(raw.pendingLists)
  if (Array.isArray(raw.messages)) {
    state.messages = raw.messages
      .map(sanitizeMessage)
      .filter(record => record !== undefined)
      .slice(-MAX_MESSAGES)
  }
  return state
}

/**
 * Read the state file.
 * @param file - path to read; the default is `stateFile()`.
 * @returns the state; a missing or broken file reads as an empty history.
 */
export async function readState(file = stateFile()) {
  try {
    return normalizeState(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return emptyState()
  }
}

/** Pause between write attempts, in milliseconds. */
function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Replace the state file with the temporary one.
 *
 * Windows refuses a rename while another process has the destination open —
 * an antivirus scan, a backup tool or an editor — with `EPERM`/`EBUSY`. A few
 * short retries make that transient, and the fallback keeps the history usable
 * even when the rename stays blocked.
 *
 * @param temporary - file with the new content.
 * @param file - destination.
 * @param content - the same content, for the in-place fallback.
 */
async function replaceFile(temporary, file, content) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temporary, file)
      return
    } catch (error) {
      lastError = error
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error
      await pause(20 * (attempt + 1))
    }
  }
  await writeFile(file, content, 'utf8')
  try {
    await unlink(temporary)
  } catch {
    // the temporary file is disposable
  }
  if (lastError !== undefined) {
    console.warn('[dsh-inbox] файл истории записан без атомарной замены:', lastError?.code ?? lastError)
  }
}

/**
 * Write the state file atomically: a temporary file first, then rename.
 * @param state - state to persist; it is normalised before writing.
 * @param file - path to write; the default is `stateFile()`.
 * @returns the normalised state that was written.
 */
export async function writeState(state, file = stateFile()) {
  const normalized = normalizeState(state)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const content = `${JSON.stringify(normalized, null, 2)}\n`
  await writeFile(temporary, content, 'utf8')
  await replaceFile(temporary, file, content)
  return normalized
}

/**
 * Append one message and keep the history inside its limit.
 * @param state - current state.
 * @param message - unknown record; an invalid one leaves the state unchanged.
 * @returns the new state (the input is not mutated).
 */
export function addMessage(state, message) {
  const record = sanitizeMessage(message)
  if (record === undefined) return state
  return { ...state, messages: [...state.messages, record].slice(-MAX_MESSAGES) }
}

/**
 * Append several messages in order, trimming once.
 * @param state - current state.
 * @param messages - unknown records.
 * @returns the new state.
 */
export function addMessages(state, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return state
  const records = messages.map(sanitizeMessage).filter(record => record !== undefined)
  if (records.length === 0) return state
  return { ...state, messages: [...state.messages, ...records].slice(-MAX_MESSAGES) }
}

/**
 * Drop the whole history, keeping the offset and the receive switch.
 * @param state - current state.
 * @returns the new state.
 */
export function clearMessages(state) {
  return { ...state, messages: [] }
}

/**
 * The chat a reply should go to: the last incoming one, otherwise the last
 * message of any direction.
 * @param state - current state.
 * @returns `{ chatId, chatTitle }` or `undefined` when the history is empty.
 */
export function lastChat(state) {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index]
    if (message.direction === 'in') return { chatId: message.chatId, chatTitle: message.chatTitle }
  }
  const last = state.messages[state.messages.length - 1]
  if (last === undefined) return undefined
  return { chatId: last.chatId, chatTitle: last.chatTitle }
}
