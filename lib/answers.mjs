/**
 * Answers from DSH to Telegram.
 *
 * When a command sends a prompt to a DSH session, the bot first shows
 * «⏳ Думаю…». The tracker subscribes to `session/event`, remembers the latest
 * assistant text, and when that session's `turn/end` arrives it edits the
 * thinking message into the real answer (extra chunks become new messages).
 * A tracker that sees no turn end within ten minutes reports that clearly.
 *
 * The tracker runs on the device that executed the prompt: it has the local
 * token, and the local session log produces the `turn/end` event.
 */

import { isNotModifiedError } from './telegram.mjs'

/** Text shown while DSH works on an answer. */
export const THINKING_TEXT = '⏳ Думаю…'

/** Text shown when no turn end arrived in time. */
export const ANSWER_TIMEOUT_TEXT = '⚠️ Ответ не получен: DSH не завершил ход за 10 минут.'

/** How long to wait for a turn end before reporting the timeout. */
export const ANSWER_TIMEOUT_MS = 10 * 60 * 1000

/** Telegram's hard message limit. */
export const TELEGRAM_TEXT_LIMIT = 4096

/**
 * Split a long answer into Telegram-sized chunks, preferring line breaks.
 * @param text - answer text.
 * @param limit - maximum characters per chunk.
 * @returns chunks; an empty text yields an empty array.
 */
export function splitAnswerText(text, limit = TELEGRAM_TEXT_LIMIT) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.trim() === '') return []
  const safeLimit = Math.max(120, Math.floor(limit))
  const chunks = []
  let rest = value
  while (rest.length > safeLimit) {
    let cut = rest.lastIndexOf('\n', safeLimit)
    if (cut < safeLimit * 0.5) cut = rest.lastIndexOf(' ', safeLimit)
    if (cut < safeLimit * 0.5) cut = safeLimit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/**
 * Extract the plain text of one assistant message event.
 * @param event - `assistant/message` session event.
 * @returns the joined text, or '' when the message has no text blocks.
 */
export function extractAssistantText(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return ''
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** The id of a live session object or a plain `{ id }` stub. */
export function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id ?? ''
  return typeof id === 'string' ? id : String(id ?? '')
}

/**
 * Build the answer tracker.
 * @param deps - `{ sendTyping(chatId), sendMessage({chatId,text}) → { messageId },
 *   editMessage({chatId,messageId,text}), recordOutgoing?({chatId,chatTitle,text}),
 *   now?, timeoutMs? }`.
 * @returns the tracker API.
 */
export function createAnswerTracker(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : ANSWER_TIMEOUT_MS
  /** sessionId → { chatId, chatTitle, messageId, startedAt } */
  const pending = new Map()
  /** sessionId → last assistant text seen this turn */
  const lastText = new Map()

  /** Send typing, ignoring failures (a missing token must not break the flow). */
  async function typing(chatId) {
    if (typeof deps.sendTyping !== 'function') return
    try {
      await deps.sendTyping(chatId)
    } catch {
      // typing is decoration
    }
  }

  /** Record the final answer in the local history, best effort. */
  async function record(pendingEntry, text) {
    if (typeof deps.recordOutgoing !== 'function' || text.trim() === '') return
    try {
      await deps.recordOutgoing({
        chatId: pendingEntry.chatId,
        chatTitle: pendingEntry.chatTitle,
        text: text.slice(0, 3900),
      })
    } catch {
      // history is not critical for delivery
    }
  }

  /** Replace the thinking message text, ignoring "not modified" and falling back to a new message. */
  async function write(pendingEntry, text) {
    const chunks = splitAnswerText(text)
    if (chunks.length === 0) {
      await writeText(pendingEntry, '⚠️ Ответ не получен: DSH завершил ход без текста.')
      return
    }
    await writeText(pendingEntry, chunks[0])
    for (const chunk of chunks.slice(1)) {
      try {
        await deps.sendMessage({ chatId: pendingEntry.chatId, text: chunk })
      } catch {
        // a lost chunk is better than a broken listener
      }
    }
  }

  /** One edit-or-send operation for the primary chunk. */
  async function writeText(pendingEntry, text) {
    try {
      if (typeof deps.editMessage === 'function' && pendingEntry.messageId !== undefined) {
        await deps.editMessage({ chatId: pendingEntry.chatId, messageId: pendingEntry.messageId, text })
        return
      }
      await deps.sendMessage({ chatId: pendingEntry.chatId, text })
    } catch (error) {
      if (isNotModifiedError(error)) return
      try {
        await deps.sendMessage({ chatId: pendingEntry.chatId, text })
      } catch {
        // nothing else to do
      }
    }
  }

  return {
    /**
     * Show «⏳ Думаю…» and remember the message for the coming turn.
     * @param request - `{ sessionId, chatId, chatTitle }`.
     * @returns `{ sessionId, messageId }` or undefined when the session id is missing.
     */
    async begin({ sessionId, chatId, chatTitle }) {
      const id = String(sessionId ?? '')
      if (id === '') return undefined
      await typing(chatId)
      let messageId
      try {
        const sent = await deps.sendMessage({ chatId, text: THINKING_TEXT })
        messageId = sent?.messageId ?? sent?.message_id
      } catch {
        return undefined
      }
      pending.set(id, { chatId, chatTitle: chatTitle ?? '', messageId, startedAt: now() })
      return { sessionId: id, messageId }
    },
    /**
     * Report a failed prompt in the same thinking message.
     * @param sessionId - session whose prompt failed.
     * @param message - failure reason.
     */
    async fail(sessionId, message) {
      const entry = pending.get(String(sessionId ?? ''))
      if (entry === undefined) return false
      pending.delete(String(sessionId))
      await writeText(entry, `⚠️ Не выполнено: ${message}`)
      return true
    },
    /**
     * React to one `session/event`: remember assistant text, finish on turn end.
     * @param session - live session or `{ id }` stub.
     * @param event - session event.
     */
    async handleEvent(session, event) {
      const id = sessionIdOf(session)
      if (id === '') return
      const assistant = extractAssistantText(event)
      if (assistant !== '') lastText.set(id, assistant)
      if (event?.type !== 'turn/end') return
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      const answer = lastText.get(id) ?? ''
      lastText.delete(id)
      await write(entry, answer)
      await record(entry, answer)
    },
    /**
     * Finish one pending answer manually (used by tests and diagnostics).
     * @param sessionId - session id.
     * @param text - answer text.
     */
    async finish(sessionId, text) {
      const id = String(sessionId ?? '')
      const entry = pending.get(id)
      if (entry === undefined) return false
      pending.delete(id)
      lastText.delete(id)
      await write(entry, text)
      await record(entry, text)
      return true
    },
    /** Report every answer older than the timeout. */
    async sweep() {
      const at = now()
      for (const [sessionId, entry] of [...pending.entries()]) {
        if (at - entry.startedAt < timeoutMs) continue
        pending.delete(sessionId)
        await writeText(entry, ANSWER_TIMEOUT_TEXT)
      }
    },
    /** Number of answers still waiting. */
    size() {
      return pending.size
    },
    /** One pending entry without touching it. */
    pendingFor(sessionId) {
      return pending.get(String(sessionId ?? ''))
    },
    /** Forget everything (plugin unload). */
    clear() {
      pending.clear()
      lastText.clear()
    },
  }
}
