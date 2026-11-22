/**
 * Host half of `dsh-inbox` — «Входящие».
 *
 * The plugin runs a Telegram bot inside DSH. Long polling collects messages into
 * a small local history, the plugin page and agent tools read that history, and
 * chats on the allow-list can drive DSH itself: `/sessions`, `/use`, `/ask`,
 * `/steer`, `/new`, `/cancel` talk to the Host `sessionController`. An empty
 * allow-list means nobody may control DSH; unknown chats get one rate-limited
 * "no access" notice and their messages are stored only for the page, so the
 * owner can allow the chat from there.
 *
 * The bot token lives only in the DSH credential store under
 * `TELEGRAM_BOT_TOKEN`: the Host resolves it per operation, the browser and the
 * agent never receive it.
 */

import {
  MAX_MESSAGES,
  addMessage,
  addMessages,
  clearMessages,
  emptyState,
  lastChat,
  normalizeChatId,
  normalizeChatIds,
  readState,
  writeState,
} from './lib/storage.mjs'
import { createTelegram, describeTelegramError, redact, TelegramError } from './lib/telegram.mjs'
import { createPoller } from './lib/polling.mjs'
import { createTools } from './lib/tools.mjs'
import { SessionsError, createSessionsGateway } from './lib/sessions.mjs'
import { allowChat, createDenyLimiter, denyChat, isChatAllowed } from './lib/access.mjs'
import { executeCommand, parseIncoming } from './lib/commands.mjs'
import { REPLIES, formatAck } from './lib/replies.mjs'
import { messageFromUpdate } from './lib/messages.mjs'

/** Plugin name; also the id of the bundle row in `cordis.patch.yml`. */
export const name = 'dsh-inbox'

/** Services required before the routes and tools can be registered. */
export const inject = ['tools', 'credentials', 'connection', 'sessionPersistence', 'sessionQuery']

/** Credential-store reference holding the bot token. */
const TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

/** Telegram's hard message limit. */
const MAX_TEXT = 4096

/** How many messages the page receives per state call. */
const VISIBLE_MESSAGES = 30

/** How many DSH sessions `/sessions` remembers for `/use`. */
const MAX_LISTED_SESSIONS = 10

/** How long a resolved session title is reused by the page. */
const TITLE_CACHE_MS = 30_000

/** How long a resolved session description is reused by the page. */
const DESCRIBE_CACHE_MS = 5_000

/** Route the page calls for the current state. */
const STATE_PATH = '/api/dsh-inbox/state'

/** Route the page calls to prove the stored token with `getMe`. */
const VERIFY_PATH = '/api/dsh-inbox/verify'

/** Route the page and the agent use to send a message. */
const SEND_PATH = '/api/dsh-inbox/send'

/** Route the page calls to switch long polling on and off. */
const POLLING_PATH = '/api/dsh-inbox/polling'

/** Route the page calls to forget the history. */
const CLEAR_PATH = '/api/dsh-inbox/messages/clear'

/** Route the page calls to replace, add or remove allow-list chats. */
const ALLOWLIST_PATH = '/api/dsh-inbox/allowlist'

/** Route the page calls to forget the session routed to one chat. */
const SESSION_RESET_PATH = '/api/dsh-inbox/session/reset'

/**
 * Build one JSON response.
 * @param value - body to serialise.
 * @param status - HTTP status; 200 by default.
 * @returns the response.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Read a JSON request body, tolerating an empty or broken one.
 * @param request - incoming request.
 * @returns the parsed body, or `{}`.
 */
async function readBody(request) {
  try {
    const text = await request.text()
    return text === '' ? {} : JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Mount the polling runtime, the routes and the tools.
 * @param ctx - owning plugin context.
 */
export function apply(ctx) {
  const telegram = createTelegram()

  /** Live state: the file plus runtime-only fields (`lastError`). */
  let state = { ...emptyState(), lastError: '' }

  /** Serialises file writes so two batches cannot interleave. */
  let writeChain = Promise.resolve()

  /** Resolves after the first read of the state file. */
  const ready = readState().then(loaded => {
    state = { ...loaded, lastError: '' }
    return state
  })

  /** Write the current state, one write at a time. */
  const persist = () => {
    const current = state
    writeChain = writeChain
      .then(() => writeState(current))
      .catch(error => {
        console.error('[dsh-inbox] не удалось сохранить историю:', error?.message ?? error)
      })
    return writeChain
  }

  /**
   * Apply a patch to the live state.
   * @param patch - fields to replace.
   * @param options - `{ persist: true }` to save the result.
   */
  const update = (patch, options = {}) => {
    state = { ...state, ...patch }
    if (options.persist === true) void persist()
    return state
  }

  /** The bot token from the credential store, or ''. */
  const resolveToken = async () => {
    try {
      const hit = await ctx.credentials.resolve(TOKEN_REF)
      return typeof hit?.value === 'string' ? hit.value.trim() : ''
    } catch {
      return ''
    }
  }

  /** A Host service through the plugin context, or `undefined`. */
  const service = serviceName => {
    try {
      if (typeof ctx.get === 'function') {
        const found = ctx.get(serviceName)
        if (found !== undefined && found !== null) return found
      }
    } catch {
      // a missing service is reported by the caller
    }
    const direct = ctx[serviceName]
    return direct ?? undefined
  }

  /** DSH sessions: the gateway owns the lazy `sessionController`/`sessionQuery` lookups. */
  const sessions = createSessionsGateway({
    getController: () => service('sessionController'),
    getQuery: () => service('sessionQuery'),
    maxListed: MAX_LISTED_SESSIONS,
  })

  /** Rate limiter for the "no access" notice, one per chat. */
  const denyLimiter = createDenyLimiter()

  /** Cache of resolved session titles, so the 4-second page refresh stays cheap. */
  const titleCache = new Map()
  /** Cache of resolved session descriptions. */
  const describeCache = new Map()

  /**
   * Whether a token is configured and whether the store accepts writes — never
   * the value itself.
   * @returns `{ configured, writable }`.
   */
  const tokenInfo = async () => {
    const store = ctx.credentials
    if (store !== null && typeof store?.describe === 'function') {
      try {
        const info = await store.describe(TOKEN_REF)
        return { configured: info?.configured === true, writable: info?.writable !== false }
      } catch {
        // fall through to a plain resolve
      }
    }
    return { configured: (await resolveToken()) !== '', writable: true }
  }

  /**
   * Send one Telegram message. With `record` (the default) the text also goes to
   * the Inbox history as an outgoing message.
   * @param chatId - Telegram chat id.
   * @param text - message text.
   * @param options - `{ chatTitle?, record? }`.
   * @returns the Bot API result.
   */
  async function sendTelegram(chatId, text, options = {}) {
    const token = await resolveToken()
    if (token === '') {
      throw new TelegramError('Токен Telegram не сохранён: вставьте его на странице плагина «Входящие».', { code: 'no-token' })
    }
    telegram.setToken(token)
    let result
    try {
      result = await telegram.sendMessage({ chatId, text })
    } catch (error) {
      throw new Error(redact(describeTelegramError(error, token), token))
    }
    if (options.record !== false) {
      const title = typeof options.chatTitle === 'string' && options.chatTitle !== '' ? options.chatTitle : chatId
      const appended = addMessage(state, {
        chatId,
        chatTitle: title,
        from: 'DSH',
        text,
        at: new Date().toISOString(),
        direction: 'out',
      })
      update({ messages: appended.messages })
      await persist()
    }
    return result
  }

  /**
   * Prove the stored token with one `getMe` request.
   * @returns `{ ok, code, message, botUsername }`; a verdict rather than a
   *   transport error, so the page can print it.
   */
  async function verifyToken() {
    const token = await resolveToken()
    if (token === '') {
      return {
        ok: false,
        code: 'missing',
        botUsername: state.botUsername,
        message: 'Токен Telegram не сохранён: вставьте его на странице плагина «Входящие».',
      }
    }
    telegram.setToken(token)
    try {
      const me = await telegram.getMe()
      const username = typeof me?.username === 'string' ? me.username.trim() : ''
      update({ botUsername: username })
      await persist()
      return {
        ok: true,
        code: 'accepted',
        botUsername: username,
        message: username === '' ? 'Telegram принял токен.' : `Бот @${username} на связи.`,
      }
    } catch (error) {
      const status = error instanceof TelegramError ? error.status : undefined
      const code = status === 401
        ? 'rejected'
        : error instanceof TelegramError && (error.code === 'network' || error.code === 'timeout')
          ? 'unreachable'
          : 'error'
      const message = status === 401
        ? 'Telegram отклонил токен (401): проверьте значение от @BotFather.'
        : redact(describeTelegramError(error, token), token)
      return { ok: false, code, botUsername: state.botUsername, message }
    }
  }

  /**
   * Send a text message and append it to the history.
   * @param request - `{ chatId?, text }`; `chatId` may be `'last'` or omitted.
   * @returns `{ chatId, chatTitle, messageId }`.
   */
  async function sendReply({ chatId, text }) {
    const token = await resolveToken()
    if (token === '') {
      throw new TelegramError('Токен Telegram не сохранён: вставьте его на странице плагина «Входящие».', { code: 'no-token' })
    }
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '') throw new Error('Текст сообщения пуст.')
    if (value.length > MAX_TEXT) {
      throw new Error(`Слишком длинный текст: максимум ${MAX_TEXT} символов, сейчас ${value.length}.`)
    }
    let target = typeof chatId === 'string' ? chatId.trim() : ''
    let title = ''
    if (target === '' || target === 'last') {
      const chat = lastChat(state)
      if (chat === undefined) throw new Error('Нет чата для ответа: сначала напишите боту в Telegram.')
      target = chat.chatId
      title = chat.chatTitle
    } else {
      const known = [...state.messages].reverse().find(message => message.chatId === target)
      title = known === undefined ? target : known.chatTitle
    }
    const result = await sendTelegram(target, value, { chatTitle: title })
    return {
      chatId: target,
      chatTitle: title,
      messageId: result !== null && typeof result === 'object' ? result.message_id : undefined,
    }
  }

  /**
   * The title of a session with a short cache, so the page refresh is cheap.
   * @param sessionId - session id.
   * @returns the title, or ''.
   */
  async function cachedTitle(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return ''
    const hit = titleCache.get(id)
    if (hit !== undefined && Date.now() - hit.at < TITLE_CACHE_MS) return hit.title
    let title = ''
    try {
      title = await sessions.titleFor(id)
    } catch {
      title = ''
    }
    titleCache.set(id, { title, at: Date.now() })
    return title
  }

  /**
   * Describe one session without resuming its Agent, with a short cache.
   * @param sessionId - session id.
   * @returns `{ sessionId, title, running }`.
   */
  async function cachedDescribe(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return null
    const hit = describeCache.get(id)
    if (hit !== undefined && Date.now() - hit.at < DESCRIBE_CACHE_MS) return hit.value
    let value
    try {
      value = await sessions.describe(id)
    } catch {
      value = { sessionId: id, title: await cachedTitle(id), running: false }
    }
    describeCache.set(id, { value, at: Date.now() })
    return value
  }

  /**
   * The session routed to one chat, if any.
   * @param chatId - Telegram chat id.
   * @returns `{ chatId, chatTitle, sessionId, title, running }` or null.
   */
  async function currentSessionInfo(chatId) {
    const id = String(chatId ?? '')
    const sessionId = state.currentChatSession?.[id]
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const described = await cachedDescribe(sessionId)
    const known = [...state.messages].reverse().find(message => message.chatId === id)
    return {
      chatId: id,
      chatTitle: known === undefined ? id : known.chatTitle,
      sessionId,
      title: described?.title ?? '',
      running: described?.running === true,
    }
  }

  /** The session of the last chat, for `/status` and `telegram_status`. */
  async function currentSessionForLastChat() {
    const chat = lastChat(state)
    if (chat === undefined) return null
    return currentSessionInfo(chat.chatId)
  }

  /** Distinct chats of the recent history, with their allow-list and session state. */
  async function describeChats() {
    const chats = []
    const seen = new Set()
    for (let index = state.messages.length - 1; index >= 0 && chats.length < 10; index -= 1) {
      const message = state.messages[index]
      if (seen.has(message.chatId)) continue
      seen.add(message.chatId)
      chats.push({
        chatId: message.chatId,
        chatTitle: message.chatTitle,
        allowed: isChatAllowed(state, message.chatId),
        blocked: message.blocked === true,
        sessionId: state.currentChatSession?.[message.chatId] ?? '',
        sessionTitle: '',
      })
    }
    for (const chat of chats) {
      if (chat.sessionId !== '') chat.sessionTitle = await cachedTitle(chat.sessionId)
    }
    return chats
  }

  /** Add one chat to the allow-list and persist it. */
  async function addAllowedChat(chatId) {
    const id = normalizeChatId(chatId)
    if (id === '') throw new Error('Неверный chatId: нужен числовой идентификатор чата Telegram.')
    const result = allowChat(state, id)
    if (result.changed) {
      update({ allowedChatIds: result.state.allowedChatIds })
      await persist()
    }
    return { changed: result.changed, allowedChatIds: state.allowedChatIds }
  }

  /**
   * Answer one processed message.
   * @param record - incoming history record.
   * @param ok - whether the command succeeded.
   * @param summary - one short line.
   * @param details - optional command output.
   */
  async function answer(record, ok, summary, details) {
    try {
      await sendTelegram(record.chatId, formatAck(ok, summary, details), { chatTitle: record.chatTitle })
    } catch (error) {
      update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
      await persist()
    }
  }

  /**
   * Execute the command of one allowed message and answer it.
   * @param record - incoming message from an allowed chat.
   */
  async function processIncoming(record) {
    const parsed = parseIncoming(record.text)
    try {
      const result = await executeCommand({
        command: parsed.command,
        args: parsed.args,
        chatId: record.chatId,
        deps: {
          getState: () => state,
          save: async patch => {
            update(patch)
            await persist()
          },
          sessions,
          statusInfo: () => ({ polling: poller.running, lastError: state.lastError ?? '' }),
          maxSessions: MAX_LISTED_SESSIONS,
        },
      })
      await answer(record, true, result.summary, result.details)
    } catch (error) {
      const message = error instanceof SessionsError || error instanceof Error
        ? error.message
        : String(error)
      await answer(record, false, typeof message === 'string' && message !== '' ? message : 'неизвестная ошибка')
    }
  }

  /**
   * Handle one long-poll batch: advance the offset, store messages, answer
   * allowed chats and deny unknown ones.
   * @param batch - `{ updates, offset, signal }` from the poller.
   */
  async function handleBatch({ updates, offset }) {
    const incoming = []
    for (const update of updates) {
      const record = messageFromUpdate(update)
      if (record === undefined) continue
      if (!isChatAllowed(state, record.chatId)) {
        // Stored so the page can show the chat and offer "Разрешить этот чат".
        incoming.push({ ...record, blocked: true })
        if (denyLimiter.shouldNotify(record.chatId)) {
          try {
            await sendTelegram(record.chatId, REPLIES.denied, { record: false })
          } catch (error) {
            update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
          }
        }
        continue
      }
      incoming.push(record)
    }
    const appended = addMessages({ ...state, messages: state.messages }, incoming)
    update({ offset, messages: appended.messages, lastError: '' })
    await persist()
    for (const record of incoming) {
      if (record.blocked === true) continue
      if (record.text.trim() === '') continue
      await processIncoming(record)
    }
  }

  /** Long polling: collect updates into the history, keep the offset. */
  const poller = createPoller({
    getToken: resolveToken,
    getState: () => state,
    update: (patch, options) => update(patch, options),
    getTelegram: () => telegram,
    handleBatch,
  })

  /**
   * Switch the receive flag and start or stop the loop.
   * @param enabled - wanted value.
   * @returns `{ enabled, polling, lastError }`.
   */
  async function setPolling(enabled) {
    const wanted = enabled === true
    update({ enabled: wanted })
    if (wanted) {
      const token = await resolveToken()
      if (token === '') update({ lastError: 'токен не сохранён' })
    }
    await persist()
    if (wanted) poller.start()
    else await poller.stop()
    return { enabled: state.enabled, polling: poller.running, lastError: state.lastError ?? '' }
  }

  // Routes live as one effect: unloading the plugin removes all of them.
  try {
    ctx.effect(() => {
      ctx.connection.fetch.register({
        path: STATE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          await ready
          const info = await tokenInfo()
          const chat = lastChat(state)
          const currentSession = await currentSessionForLastChat()
          const chats = await describeChats()
          return json({
            ok: true,
            configured: info.configured,
            writable: info.writable,
            botUsername: state.botUsername,
            enabled: state.enabled,
            polling: poller.running,
            lastError: state.lastError ?? '',
            messages: state.messages.slice(-VISIBLE_MESSAGES),
            totalMessages: state.messages.length,
            maxMessages: MAX_MESSAGES,
            lastChat: chat === undefined ? null : chat,
            allowedChatIds: state.allowedChatIds,
            currentSession,
            chats,
          })
        },
      })

      ctx.connection.fetch.register({
        path: VERIFY_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          await ready
          return json(await verifyToken())
        },
      })

      ctx.connection.fetch.register({
        path: SEND_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const token = await resolveToken()
          try {
            const result = await sendReply({ chatId: body.chatId, text: body.text })
            return json({ ok: true, ...result, message: `Отправлено в «${result.chatTitle}».` })
          } catch (error) {
            return json({
              ok: false,
              code: error?.code ?? 'failed',
              message: redact(error instanceof Error ? error.message : String(error), token),
            })
          }
        },
      })

      ctx.connection.fetch.register({
        path: POLLING_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const wanted = body.enabled === true
          const result = await setPolling(wanted)
          const message = wanted
            ? result.lastError === 'токен не сохранён'
              ? 'Приём включён, но токен не сохранён: вставьте токен и нажмите «Проверить».'
              : 'Приём сообщений включён.'
            : 'Приём сообщений выключен.'
          return json({ ok: true, ...result, message })
        },
      })

      ctx.connection.fetch.register({
        path: CLEAR_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          await ready
          const cleared = state.messages.length
          update({ messages: clearMessages(state).messages })
          await persist()
          return json({
            ok: true,
            cleared,
            message: cleared === 0 ? 'История уже была пуста.' : `Очищено сообщений: ${cleared}.`,
          })
        },
      })

      ctx.connection.fetch.register({
        path: ALLOWLIST_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          if (Array.isArray(body.chatIds)) {
            const invalid = []
            const valid = []
            for (const item of body.chatIds) {
              const id = normalizeChatId(item)
              if (id === '') invalid.push(String(item))
              else if (!valid.includes(id)) valid.push(id)
            }
            if (invalid.length > 0) {
              return json({
                ok: false,
                message: `Неверные chatId: ${invalid.join(', ')}. Нужны числа, например 123456789 или -1001234567890.`,
              })
            }
            const allowedChatIds = normalizeChatIds(valid)
            update({ allowedChatIds })
            await persist()
            return json({
              ok: true,
              allowedChatIds,
              message: allowedChatIds.length === 0
                ? 'Белый список пуст: управлять DSH из Telegram нельзя никому.'
                : `Чатов в белом списке: ${allowedChatIds.length}.`,
            })
          }
          if (typeof body.add === 'string') {
            try {
              const result = await addAllowedChat(body.add)
              return json({
                ok: true,
                allowedChatIds: result.allowedChatIds,
                message: result.changed
                  ? `Чат ${normalizeChatId(body.add)} добавлен в белый список.`
                  : 'Чат уже был в белом списке.',
              })
            } catch (error) {
              return json({ ok: false, message: error instanceof Error ? error.message : String(error) })
            }
          }
          if (typeof body.remove === 'string') {
            const removed = denyChat(state, body.remove)
            const changed = removed.changed
            update({
              allowedChatIds: removed.state.allowedChatIds,
              currentChatSession: removed.state.currentChatSession,
              pendingLists: removed.state.pendingLists,
            })
            await persist()
            return json({
              ok: true,
              allowedChatIds: state.allowedChatIds,
              message: changed ? 'Чат удалён из белого списка.' : 'Этого чата не было в белом списке.',
            })
          }
          return json({ ok: false, message: 'Укажите chatIds, add или remove.' })
        },
      })

      ctx.connection.fetch.register({
        path: SESSION_RESET_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const id = normalizeChatId(body.chatId)
          if (id === '') return json({ ok: false, message: 'Неверный chatId.' })
          const current = { ...state.currentChatSession }
          delete current[id]
          update({ currentChatSession: current })
          await persist()
          return json({ ok: true, chatId: id, message: 'Текущая сессия для чата сброшена.' })
        },
      })
    }, 'dsh-inbox: routes')
  } catch (error) {
    console.error('[dsh-inbox] маршруты недоступны:', error)
  }

  try {
    for (const tool of createTools({
      ready,
      tokenInfo,
      snapshot: () => state,
      polling: () => poller.running,
      sendReply,
      addAllowedChat,
      currentSessionInfo: currentSessionForLastChat,
    })) {
      ctx.tools.register(tool)
    }
  } catch (error) {
    console.error('[dsh-inbox] инструменты недоступны:', error)
  }

  // A replaced or removed token must not keep an old bot name on screen, and a
  // running loop picks the new value up by itself (it resolves per iteration).
  try {
    ctx.effect(
      () =>
        ctx.on('credentials/reference-updated', ref => {
          if (ref !== TOKEN_REF) return
          update({ botUsername: '' }, { persist: true })
          if (state.enabled === true) poller.start()
        }),
      'dsh-inbox: token tracking',
    )
  } catch (error) {
    console.error('[dsh-inbox] отслеживание токена недоступно:', error)
  }

  // Resume polling after a restart, and fill the bot name once when polling is
  // already on.
  ctx.effect(() => {
    let stopped = false
    void ready.then(() => {
      if (stopped) return
      if (state.enabled !== true) return
      poller.start()
      if (state.botUsername === '') void verifyToken()
    })
    return () => {
      stopped = true
      void poller.stop()
    }
  }, 'dsh-inbox: polling lifecycle')
}
