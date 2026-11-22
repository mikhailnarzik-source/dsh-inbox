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
import { MENU_TEXTS, REPLIES, formatAck, helpText, sessionLabel, statusText } from './lib/replies.mjs'
import {
  COMMANDS_MENU,
  MENU_BUTTON_ACTIONS,
  MENU_VERSION,
  helpInlineKeyboard,
  parseCallbackData,
  replyKeyboard,
  sessionInlineKeyboard,
  sessionsInlineKeyboard,
  shouldRefreshCommands,
  statusInlineKeyboard,
} from './lib/menu.mjs'
import { callbackFromUpdate, messageFromUpdate } from './lib/messages.mjs'
import { botIdFromToken, loadOrCreateDevice } from './lib/device.mjs'
import { QUEUE_BRANCH, createGitQueue, resolveSyncRemote } from './lib/queue.mjs'
import { createQueueWorker } from './lib/queue-worker.mjs'

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

/** Route the page calls to re-publish the Telegram command menu. */
const MENU_REFRESH_PATH = '/api/dsh-inbox/menu/refresh'

/** Route the page calls to switch this device's Telegram listener on or off. */
const QUEUE_LISTENER_PATH = '/api/dsh-inbox/queue/listener'

/** Route the page calls to sync the shared queue now. */
const QUEUE_SYNC_PATH = '/api/dsh-inbox/queue/sync'

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

  /** This device's stable identity; filled by `ready`. */
  let device = { id: '', name: '' }

  /** Numeric bot id derived from the current token; never persisted with the queue. */
  let botId = ''

  /** Shared git queue; `null` until `ready` resolves, and when no remote is set. */
  let queue = null

  /** Queue worker; `null` until `ready` resolves. */
  let worker = null

  /** Last queue-level failure, for the page and the status tool. */
  let queueLastError = ''

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

  /**
   * Load the state file, the device identity and the shared queue. Routes and
   * tools await this promise, so the queue is ready before the first poll.
   */
  const ready = (async () => {
    const loaded = await readState()
    state = { ...loaded, lastError: '' }
    try {
      device = await loadOrCreateDevice()
    } catch (error) {
      queueLastError = `не удалось прочитать идентификатор устройства: ${error?.message ?? error}`
      device = { id: '', name: '' }
    }
    if (device.id !== '') {
      const remoteUrl = await resolveSyncRemote()
      queue = createGitQueue({
        remoteUrl,
        device: { id: device.id, name: device.name },
        getBotId: () => botId,
      })
      worker = createQueueWorker({
        queue,
        execute: executeQueuedCommand,
        send: sendQueuedReply,
        isListener: () => state.queue?.listener === true,
        intervalMs: Number.isFinite(Number(process.env.DSH_INBOX_QUEUE_INTERVAL_MS)) && process.env.DSH_INBOX_QUEUE_INTERVAL_MS !== ''
          ? Number(process.env.DSH_INBOX_QUEUE_INTERVAL_MS)
          : 4000,
        log: message => console.warn(message),
      })
      if (state.deviceId !== device.id) {
        update({ deviceId: device.id })
        await persist()
      }
    }
    return state
  })()

  /** Whether this device is the Telegram listener (or the queue is not used). */
  const canPoll = () => (queue !== null && queue.configured() ? state.queue?.listener === true : true)

  /** Whether the polling loop should run right now. */
  const shouldPoll = () => state.enabled === true && canPoll()

  /** Adopt the queue's saved Telegram offset before a listener starts. */
  async function adoptQueueOffset() {
    if (queue === null || !queue.configured()) return
    const saved = await queue.readOffset().catch(() => undefined)
    if (Number.isFinite(saved) && saved > state.offset) {
      update({ offset: Math.floor(saved) })
      await persist()
    }
  }

  /** Start polling if the current flags allow it. */
  async function startPollingIfWanted() {
    if (!shouldPoll()) return false
    await adoptQueueOffset()
    poller.start()
    void refreshCommands()
    return true
  }

  /** Queue status for the page and the tool: local reads, no network. */
  async function queueStatus() {
    await ready
    const ws = worker?.status?.() ?? {}
    const base = {
      configured: queue !== null && queue.configured(),
      mode: queue !== null && queue.configured() ? 'queue' : 'inline',
      branch: QUEUE_BRANCH,
      device: { id: device.id, name: device.name, botId },
      listener: state.queue?.listener === true,
      polling: poller.running,
      counts: { total: 0, new: 0, inProgress: 0, done: 0 },
      devices: [],
      otherListener: null,
      inProgress: [],
      worker: {
        running: ws.running === true,
        busy: ws.busy === true,
        lastSyncAt: Number(ws.lastSyncAt) || 0,
        lastError: typeof ws.lastError === 'string' ? ws.lastError : '',
      },
      lastSyncAt: Number(ws.lastSyncAt) || 0,
      lastError: typeof ws.lastError === 'string' && ws.lastError !== '' ? ws.lastError : queueLastError,
    }
    if (queue === null || !queue.configured()) return base
    base.remote = queue.remoteUrl
    let snapshot = { items: [], counts: base.counts }
    try {
      snapshot = await queue.snapshot()
    } catch (error) {
      base.lastError = `не удалось прочитать очередь: ${error?.message ?? error}`
    }
    base.counts = snapshot.counts
    base.inProgress = snapshot.items
      .filter(item => item.done !== true && item.result === undefined && item.winner !== undefined)
      .slice(0, 5)
      .map(item => ({
        commandId: item.command.commandId,
        deviceName: item.winner.deviceName,
        chatTitle: item.command.chatTitle,
        text: String(item.command.text ?? '').slice(0, 80),
      }))
    try {
      base.devices = await queue.statuses()
    } catch {
      base.devices = []
    }
    const other = base.devices.find(entry => entry.listener === true && entry.deviceId !== device.id)
    if (other !== undefined) base.otherListener = { deviceId: other.deviceId, deviceName: other.deviceName }
    return base
  }

  /** Publish this device's status file (best effort; the worker also does it). */
  async function pushDeviceStatus() {
    if (queue === null || !queue.configured()) return
    try {
      await queue.updateStatus({
        listener: state.queue?.listener === true,
        lastSyncAt: worker?.status?.().lastSyncAt ?? 0,
        lastError: worker?.status?.().lastError ?? '',
        version: MENU_VERSION,
      })
    } catch (error) {
      queueLastError = `не удалось обновить статус устройства: ${error?.message ?? error}`
    }
  }

  /** The bot token from the credential store, or ''. */
  const resolveToken = async () => {
    try {
      const hit = await ctx.credentials.resolve(TOKEN_REF)
      const token = typeof hit?.value === 'string' ? hit.value.trim() : ''
      const derived = botIdFromToken(token)
      if (derived !== '') botId = derived
      return token
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
   * @param options - `{ chatTitle?, record?, replyMarkup? }`.
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
      result = await telegram.sendMessage({ chatId, text, replyMarkup: options.replyMarkup })
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
      // A working token is the natural moment to publish the «/» menu.
      await refreshCommands()
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
   * Publish the Telegram «/» command list, at most once a day per list version.
   * Failures are returned, never thrown: a menu problem must not stop polling.
   * @param force - ignore the cache (the page's button, a successful token check).
   * @returns `{ ok, cached, version, at, commands, message }`.
   */
  async function refreshCommands(force = false) {
    const token = await resolveToken()
    if (token === '') {
      return {
        ok: false,
        code: 'missing',
        cached: false,
        version: MENU_VERSION,
        at: 0,
        commands: COMMANDS_MENU.length,
        message: 'Токен Telegram не сохранён: меню команд не отправлено.',
      }
    }
    const now = Date.now()
    if (!force && !shouldRefreshCommands(state.commandsMenu, now)) {
      return {
        ok: true,
        cached: true,
        version: MENU_VERSION,
        at: state.commandsMenu.at,
        commands: COMMANDS_MENU.length,
        message: 'Меню команд уже опубликовано.',
      }
    }
    telegram.setToken(token)
    try {
      await telegram.setMyCommands(COMMANDS_MENU, { type: 'default' })
      update({ commandsMenu: { version: MENU_VERSION, at: now, ok: true } })
      await persist()
      return {
        ok: true,
        cached: false,
        version: MENU_VERSION,
        at: now,
        commands: COMMANDS_MENU.length,
        message: 'Меню команд обновлено в Telegram.',
      }
    } catch (error) {
      update({ commandsMenu: { version: '', at: now, ok: false } })
      await persist()
      const message = redact(describeTelegramError(error, token), token)
      console.warn('[dsh-inbox] не удалось обновить меню команд:', message)
      return {
        ok: false,
        code: 'failed',
        cached: false,
        version: MENU_VERSION,
        at: now,
        commands: COMMANDS_MENU.length,
        message,
      }
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
   * Dependencies every command receives.
   */
  const commandDeps = {
    getState: () => state,
    save: async patch => {
      update(patch)
      await persist()
    },
    sessions,
    statusInfo: () => ({ polling: poller.running, lastError: state.lastError ?? '' }),
    maxSessions: MAX_LISTED_SESSIONS,
  }

  /**
   * Build the reply of one message command without sending it.
   * @param record - `{ chatId, chatTitle, text }`.
   * @returns `{ status: 'ok'|'error', text, markup? }`.
   */
  async function buildCommandReply(record) {
    const pressed = MENU_BUTTON_ACTIONS[record.text.trim()]
    let text = record.text
    if (pressed !== undefined) {
      if (pressed.hint === 'new') {
        return { status: 'ok', text: MENU_TEXTS.hintNew, markup: replyKeyboard() }
      }
      text = `/${pressed.command}`
    }
    const parsed = parseIncoming(text)
    try {
      const result = await executeCommand({
        command: parsed.command,
        args: parsed.args,
        chatId: record.chatId,
        deps: commandDeps,
      })
      return {
        status: 'ok',
        text: formatAck(true, result.summary, result.details),
        markup: result.replyKeyboard === true ? replyKeyboard() : result.inlineKeyboard,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'error',
        text: formatAck(false, typeof message === 'string' && message !== '' ? message : 'неизвестная ошибка'),
      }
    }
  }

  /** Send one command reply and remember it in the local history. */
  async function deliverReply(record, reply) {
    try {
      await sendTelegram(record.chatId, reply.text, {
        chatTitle: record.chatTitle,
        replyMarkup: reply.markup,
      })
      return { ok: true }
    } catch (error) {
      update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
      await persist()
      return { ok: false, message: redact(error?.message ?? error) }
    }
  }

  /**
   * Execute the command of one allowed message and answer it. This is the legacy
   * inline path used when the shared queue has no configured remote.
   * @param record - incoming message from an allowed chat.
   */
  async function processIncoming(record) {
    const reply = await buildCommandReply(record)
    await deliverReply(record, reply)
  }

  /**
   * Execute one queued command on the device that won the claim. The reply is
   * returned to the worker, which publishes it exactly once.
   * @param command - queued command record.
   * @returns `{ status, output, text?, markup?, chatId?, chatTitle?, delivered? }`.
   */
  async function executeQueuedCommand(command) {
    if (command.callback !== undefined) {
      // A callback needs its own answer and message edit, so the executor sends
      // those itself and reports the command as delivered.
      await handleCallback({
        callbackId: command.callback.callbackId,
        chatId: command.chatId,
        chatTitle: command.chatTitle,
        messageId: command.callback.messageId,
        data: command.callback.data,
        from: '',
      })
      return {
        status: 'ok',
        output: `кнопка: ${command.callback.data}`,
        delivered: true,
      }
    }
    const record = { chatId: command.chatId, chatTitle: command.chatTitle, text: command.text }
    const reply = await buildCommandReply(record)
    return {
      ...reply,
      output: reply.text.slice(0, 500),
      chatId: record.chatId,
      chatTitle: record.chatTitle,
      delivered: false,
    }
  }

  /** Publish a queued command's reply (called by the worker once). */
  async function sendQueuedReply(payload) {
    await sendTelegram(payload.chatId, payload.text, {
      chatTitle: payload.chatTitle,
      replyMarkup: payload.markup,
    })
  }

  /**
   * Send one plain message — a menu greeting or a hint — and remember it.
   * @param chatId - Telegram chat id.
   * @param chatTitle - chat name for the history.
   * @param text - message text.
   * @param markup - optional `reply_markup` payload.
   */
  async function say(chatId, chatTitle, text, markup) {
    try {
      await sendTelegram(chatId, text, { chatTitle, replyMarkup: markup })
    } catch (error) {
      update({ lastError: `не удалось отправить сообщение в Telegram: ${redact(error?.message ?? error)}` })
      await persist()
    }
  }

  /**
   * Edit the message a button belongs to, falling back to a new message when
   * Telegram refuses the edit (a message older than 48 hours cannot be edited).
   * @param callback - parsed callback.
   * @param text - new text.
   * @param markup - optional inline keyboard.
   */
  async function editCallbackMessage(callback, text, markup) {
    const chatTitle = callback.chatTitle === '' ? callback.chatId : callback.chatTitle
    if (callback.messageId !== undefined) {
      try {
        await telegram.editMessageText({
          chatId: callback.chatId,
          messageId: callback.messageId,
          text,
          replyMarkup: markup,
        })
        return
      } catch {
        // fall back to a fresh message
      }
    }
    await sendTelegram(callback.chatId, text, { chatTitle, replyMarkup: markup })
  }

  /**
   * Run one inline-button action. Every branch answers the callback first, so
   * the button never shows a spinner for long.
   * @param parsed - `{ action, sessionId? }` from the callback data.
   * @param callback - parsed callback query.
   * @param ack - answers the callback at most once.
   */
  async function runCallbackAction(parsed, callback, ack) {
    const chatId = callback.chatId
    const chatTitle = callback.chatTitle === '' ? callback.chatId : callback.chatTitle
    if (parsed.action === 'use') {
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (sessionId === '') {
        await ack(MENU_TEXTS.sessionNotChosenForCallback)
        return
      }
      update({ currentChatSession: { ...state.currentChatSession, [chatId]: sessionId } })
      await persist()
      const label = sessionLabel(await cachedTitle(sessionId), sessionId)
      await ack('Сессия выбрана')
      await editCallbackMessage(
        callback,
        formatAck(true, 'сессия выбрана', MENU_TEXTS.sessionChosen(label)),
        sessionInlineKeyboard(sessionId),
      )
      return
    }
    if (parsed.action === 'cancel') {
      const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
        ? parsed.sessionId
        : (state.currentChatSession?.[chatId] ?? '')
      if (sessionId === '') {
        await ack(MENU_TEXTS.sessionNotChosenForCallback)
        return
      }
      try {
        await sessions.cancel(sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : MENU_TEXTS.cancelFailed
        await ack(MENU_TEXTS.cancelFailed)
        await editCallbackMessage(callback, formatAck(false, message), statusInlineKeyboard(sessionId))
        return
      }
      const label = sessionLabel(await cachedTitle(sessionId), sessionId)
      await ack('Отмена запрошена')
      await editCallbackMessage(
        callback,
        formatAck(true, MENU_TEXTS.cancelRequested(label)),
        statusInlineKeyboard(sessionId),
      )
      return
    }
    if (parsed.action === 'sessions-refresh') {
      let rows = []
      try {
        rows = await sessions.list({ limit: MAX_LISTED_SESSIONS })
      } catch (error) {
        const message = error instanceof Error ? error.message : MENU_TEXTS.refreshFailed
        await ack(MENU_TEXTS.refreshFailed)
        await editCallbackMessage(callback, formatAck(false, message), sessionsInlineKeyboard([]))
        return
      }
      if (rows.length === 0) {
        await ack('Сессий нет')
        await editCallbackMessage(callback, formatAck(false, REPLIES.emptySessions), sessionsInlineKeyboard([]))
        return
      }
      update({
        pendingLists: { ...state.pendingLists, [chatId]: rows.map(row => row.sessionId) },
      })
      await persist()
      await ack('Список обновлён')
      await editCallbackMessage(
        callback,
        formatAck(true, `сессий: ${rows.length}`, MENU_TEXTS.chooseSession),
        sessionsInlineKeyboard(rows),
      )
      return
    }
    if (parsed.action === 'status') {
      const current = await currentSessionInfo(chatId)
      await ack('Состояние')
      await editCallbackMessage(
        callback,
        statusText({
          polling: poller.running,
          lastError: state.lastError ?? '',
          totalMessages: state.messages.length,
          allowedCount: state.allowedChatIds.length,
          current,
          sessionsAvailable: sessions.available(),
        }),
        statusInlineKeyboard(current?.sessionId ?? ''),
      )
      return
    }
    if (parsed.action === 'help') {
      await ack('Помощь')
      await editCallbackMessage(callback, helpText(), helpInlineKeyboard())
      return
    }
    if (parsed.action === 'menu') {
      await ack(MENU_TEXTS.menuSent)
      await editCallbackMessage(callback, MENU_TEXTS.menuSent)
      await say(chatId, chatTitle, MENU_TEXTS.greeting, replyKeyboard())
      return
    }
    if (parsed.action === 'ask') {
      await ack(MENU_TEXTS.hintAsk)
      await say(chatId, chatTitle, MENU_TEXTS.hintAsk, replyKeyboard())
      return
    }
    await ack(MENU_TEXTS.unknownButton)
  }

  /**
   * Handle one pressed inline button: the whitelist is checked BEFORE any
   * action, `answerCallbackQuery` is always called (even for stale or foreign
   * buttons), and a failure never escapes into the polling loop.
   * @param callback - parsed callback query.
   */
  async function handleCallback(callback) {
    if (callback.callbackId === '') return
    const token = await resolveToken()
    if (token === '') return
    telegram.setToken(token)
    let answered = false
    const ack = async text => {
      if (answered) return
      answered = true
      try {
        await telegram.answerCallbackQuery({
          callbackQueryId: callback.callbackId,
          text: typeof text === 'string' && text !== '' ? text : MENU_TEXTS.callbackDone,
          showAlert: false,
        })
      } catch {
        // Telegram may have already dropped the query
      }
    }
    try {
      if (callback.chatId === '') {
        await ack('Не удалось определить чат.')
        return
      }
      if (!isChatAllowed(state, callback.chatId)) {
        if (denyLimiter.shouldNotify(callback.chatId)) {
          try {
            await sendTelegram(callback.chatId, REPLIES.denied, { record: false })
          } catch {
            // the denial is best effort
          }
        }
        await ack(MENU_TEXTS.callbackDenied)
        return
      }
      await runCallbackAction(parseCallbackData(callback.data), callback, ack)
    } catch (error) {
      update({ lastError: `ошибка кнопки Telegram: ${redact(error?.message ?? error)}` })
      await persist()
      await ack('Ошибка. Попробуйте ещё раз.')
    } finally {
      await ack(MENU_TEXTS.callbackDone)
    }
  }

  /**
   * Answer one pressed button quickly (stops the Telegram spinner) without
   * waiting for the queue executor.
   */
  async function answerCallbackQuick(callback, text) {
    const token = await resolveToken()
    if (token === '') return
    telegram.setToken(token)
    try {
      await telegram.answerCallbackQuery({
        callbackQueryId: callback.callbackId,
        text: typeof text === 'string' ? text : '',
        showAlert: false,
      })
    } catch {
      // the executor may answer again later
    }
  }

  /** Denial notice for a chat outside the allow-list, rate-limited per chat. */
  async function denyForeign(record) {
    if (!denyLimiter.shouldNotify(record.chatId)) return
    try {
      await sendTelegram(record.chatId, REPLIES.denied, { record: false })
    } catch (error) {
      update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
    }
  }

  /**
   * Handle one long-poll batch. Without a configured shared queue the commands
   * run inline (single-device mode). With a queue every allowed update becomes an
   * immutable command file; the worker executes it on whichever device wins the
   * claim, and the offset advances only after the batch was pushed.
   * @param batch - `{ updates, offset, signal }` from the poller.
   */
  async function handleBatch({ updates, offset }) {
    const queueActive = queue !== null && queue.configured()
    const incoming = []
    const commands = []
    const callbacks = []
    for (const update of updates) {
      const callback = callbackFromUpdate(update)
      if (callback !== undefined) {
        if (!queueActive) {
          callbacks.push(callback)
          continue
        }
        if (callback.chatId === '') {
          await answerCallbackQuick(callback, 'Не удалось определить чат.')
          continue
        }
        if (!isChatAllowed(state, callback.chatId)) {
          await answerCallbackQuick(callback, MENU_TEXTS.callbackDenied)
          await denyForeign(callback)
          continue
        }
        // Stop the spinner now; the executor edits the message later.
        await answerCallbackQuick(callback, '')
        commands.push({
          chatId: callback.chatId,
          chatTitle: callback.chatTitle,
          updateId: Number(update.update_id),
          callback: {
            callbackId: callback.callbackId,
            data: callback.data,
            messageId: callback.messageId,
          },
        })
        continue
      }
      const record = messageFromUpdate(update)
      if (record === undefined) continue
      if (!isChatAllowed(state, record.chatId)) {
        // Stored so the page can show the chat and offer "Разрешить этот чат".
        incoming.push({ ...record, blocked: true })
        await denyForeign(record)
        continue
      }
      incoming.push(record)
      if (queueActive) {
        commands.push({
          chatId: record.chatId,
          chatTitle: record.chatTitle,
          updateId: Number(update.update_id),
          text: record.text,
        })
      }
    }
    if (!queueActive) {
      const appended = addMessages({ ...state, messages: state.messages }, incoming)
      update({ offset, messages: appended.messages, lastError: '' })
      await persist()
      for (const record of incoming) {
        if (record.blocked === true) continue
        if (record.text.trim() === '') continue
        await processIncoming(record)
      }
      for (const callback of callbacks) {
        await handleCallback(callback)
      }
      return
    }
    // Queue mode: one push per batch, then the offset and the local history.
    const committed = await queue.commitBatch({ commands, offset })
    if (!committed.ok) {
      update({ lastError: `очередь: ${committed.message ?? 'не удалось сохранить команды'}` })
      await persist()
      return
    }
    const appended = addMessages({ ...state, messages: state.messages }, incoming)
    update({ offset: Math.floor(offset), messages: appended.messages, lastError: '' })
    await persist()
    void worker?.runNow()
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
   * @returns `{ enabled, polling, lastError, listenerActive }`.
   */
  async function setPolling(enabled) {
    const wanted = enabled === true
    update({ enabled: wanted })
    if (wanted) {
      const token = await resolveToken()
      if (token === '') update({ lastError: 'токен не сохранён' })
    }
    await persist()
    if (wanted) {
      const pollAllowed = await startPollingIfWanted()
      if (!pollAllowed) {
        update({ lastError: 'Telegram слушает другое устройство: включите «Слушать Telegram здесь» или выключите приём.' })
        await persist()
      }
    } else {
      await poller.stop()
    }
    return {
      enabled: state.enabled,
      polling: poller.running,
      lastError: state.lastError ?? '',
      listenerActive: canPoll(),
    }
  }

  /**
   * Switch the "listen to Telegram here" role of this device. Only one device
   * may poll the bot: Telegram returns 409 to a second getUpdates consumer.
   * @param enabled - wanted value.
   * @returns `{ ok, listener, enabled, message }`.
   */
  async function setQueueListener(enabled) {
    await ready
    if (enabled === true) {
      if (queue === null || !queue.configured()) {
        return { ok: false, listener: false, enabled: state.enabled, message: 'Общая очередь не настроена: заполните remote в ~/.dsh/dsh-sync.json.' }
      }
      const token = await resolveToken()
      if (token === '') {
        return { ok: false, listener: false, enabled: state.enabled, message: 'Сначала сохраните токен бота: без него Telegram не опросить.' }
      }
      update({ queue: { listener: true }, enabled: true, lastError: '' })
      await persist()
      await adoptQueueOffset()
      poller.start()
      await refreshCommands()
      worker?.start()
      await pushDeviceStatus()
      return { ok: true, listener: true, enabled: true, message: 'Это устройство слушает Telegram.' }
    }
    update({ queue: { listener: false }, enabled: false })
    await persist()
    await poller.stop()
    await pushDeviceStatus()
    return {
      ok: true,
      listener: false,
      enabled: false,
      message: 'Приём на этом устройстве выключен. Слушателем станет другое устройство.',
    }
  }

  /**
   * Tool-facing listener switch: same path as the page route, plus the fresh
   * queue status so the model can report the resulting role and warnings.
   * @param enabled - wanted value.
   * @returns `{ ok, listener, enabled, message, queue }`.
   */
  async function setListener(enabled) {
    const result = await setQueueListener(enabled === true)
    return { ...result, queue: await queueStatus() }
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
            device: { id: device.id, name: device.name },
            queue: await queueStatus(),
            menu: {
              version: MENU_VERSION,
              publishedVersion: state.commandsMenu?.version ?? '',
              at: Number(state.commandsMenu?.at) || 0,
              ok: state.commandsMenu?.ok === true && state.commandsMenu?.version === MENU_VERSION,
              commands: COMMANDS_MENU.map(item => `/${item.command}`),
            },
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

      ctx.connection.fetch.register({
        path: MENU_REFRESH_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          // The page's button always forces: the person clicked it to fix the menu.
          const result = await refreshCommands(body.force !== false)
          return json({ ok: result.ok === true, ...result })
        },
      })

      ctx.connection.fetch.register({
        path: QUEUE_LISTENER_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const result = await setQueueListener(body.enabled === true)
          return json({ ...result, queue: await queueStatus() })
        },
      })

      ctx.connection.fetch.register({
        path: QUEUE_SYNC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          await ready
          if (queue === null || !queue.configured()) {
            return json({ ok: false, message: 'Общая очередь не настроена: заполните remote в ~/.dsh/dsh-sync.json.' })
          }
          const result = worker === null ? { ok: false } : await worker.runNow()
          await pushDeviceStatus()
          return json({
            ok: result.ok === true,
            message: result.ok === true ? 'Очередь синхронизирована.' : (result.message ?? 'синхронизация не удалась'),
            executed: result.executed ?? [],
            queue: await queueStatus(),
          })
        },
      })
    }, 'dsh-inbox: routes')
  } catch (error) {
    console.error('[dsh-inbox] маршруты недоступны:', error)
  }

  try {
    // Effect-owned registrations: unloading or replacing the plugin disposes
    // every tool. Without this, DSH keeps the previous generation's names in the
    // global tool layer and a reload cannot register the same names again.
    ctx.effect(() => {
      const disposers = []
      for (const tool of createTools({
        ready,
        tokenInfo,
        snapshot: () => state,
        polling: () => poller.running,
        sendReply,
        addAllowedChat,
        currentSessionInfo: currentSessionForLastChat,
        queueStatus,
        setListener,
      })) {
        try {
          disposers.push(ctx.tools.register(tool))
        } catch (error) {
          // One bad definition must not hide the rest.
          console.error(`[dsh-inbox] инструмент ${tool.name} не зарегистрирован:`, error?.message ?? error)
        }
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            // disposal is best effort
          }
        }
      }
    }, 'dsh-inbox: tools')
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
          // A new token may belong to another bot, which needs its own menu.
          update({ botUsername: '', commandsMenu: { version: '', at: 0, ok: false } }, { persist: true })
          botId = ''
          if (shouldPoll()) {
            void resolveToken()
            void startPollingIfWanted()
          }
          void pushDeviceStatus()
        }),
      'dsh-inbox: token tracking',
    )
  } catch (error) {
    console.error('[dsh-inbox] отслеживание токена недоступно:', error)
  }

  // Resume the queue worker and polling after a restart.
  ctx.effect(() => {
    let stopped = false
    void ready.then(async () => {
      if (stopped) return
      if (!shouldPoll()) {
        if (state.enabled === true && !canPoll()) {
          update({ lastError: 'Telegram слушает другое устройство: включите «Слушать Telegram здесь» или выключите приём.' })
          await persist()
        }
      } else {
        await adoptQueueOffset()
        poller.start()
        // The daily-cached command list is checked on every start.
        void refreshCommands()
        if (state.botUsername === '') void verifyToken()
      }
      if (queue !== null && queue.configured()) {
        worker?.start()
        await pushDeviceStatus()
      }
    })
    return () => {
      stopped = true
      void poller.stop()
      worker?.stop()
    }
  }, 'dsh-inbox: polling lifecycle')
}
