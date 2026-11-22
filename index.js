/**
 * Host half of `dsh-inbox` — «Входящие».
 *
 * The plugin runs a Telegram bot inside DSH: long polling collects messages into
 * a small local history, the plugin page and three agent tools read that history
 * and answer chats. The bot token lives only in the DSH credential store under
 * `TELEGRAM_BOT_TOKEN`: the Host resolves it per operation, the browser and the
 * agent never receive it.
 *
 * There is no mail support yet; the state shape and the routes are the place
 * where a second channel will plug in later.
 */

import {
  MAX_MESSAGES,
  addMessage,
  clearMessages,
  emptyState,
  lastChat,
  readState,
  writeState,
} from './lib/storage.mjs'
import { createTelegram, describeTelegramError, redact, TelegramError } from './lib/telegram.mjs'
import { createPoller } from './lib/polling.mjs'
import { createTools } from './lib/tools.mjs'

/** Plugin name; also the id of the bundle row in `cordis.patch.yml`. */
export const name = 'dsh-inbox'

/** Services required before the routes and tools can be registered. */
export const inject = ['tools', 'credentials', 'connection', 'sessionPersistence']

/** Credential-store reference holding the bot token. */
const TOKEN_REF = 'TELEGRAM_BOT_TOKEN'

/** Telegram's hard message limit. */
const MAX_TEXT = 4096

/** How many messages the page receives per state call. */
const VISIBLE_MESSAGES = 30

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
  let state = emptyState()

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
    telegram.setToken(token)
    let result
    try {
      result = await telegram.sendMessage({ chatId: target, text: value })
    } catch (error) {
      throw new Error(redact(describeTelegramError(error, token), token))
    }
    const appended = addMessage(state, {
      chatId: target,
      chatTitle: title,
      from: 'DSH',
      text: value,
      at: new Date().toISOString(),
      direction: 'out',
    })
    update({ messages: appended.messages })
    await persist()
    return {
      chatId: target,
      chatTitle: title,
      messageId: result !== null && typeof result === 'object' ? result.message_id : undefined,
    }
  }

  /** Long polling: collect updates into the history, keep the offset. */
  const poller = createPoller({
    getToken: resolveToken,
    getState: () => state,
    update: (patch, options) => update(patch, options),
    getTelegram: () => telegram,
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
