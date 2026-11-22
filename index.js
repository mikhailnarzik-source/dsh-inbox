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
import { createTelegram, describeTelegramError, isNotModifiedError, redact, TelegramError } from './lib/telegram.mjs'
import { createPoller } from './lib/polling.mjs'
import { createTools } from './lib/tools.mjs'
import { SessionsError, createSessionsGateway } from './lib/sessions.mjs'
import { allowChat, createDenyLimiter, denyChat, isChatAllowed } from './lib/access.mjs'
import { executeCommand, parseIncoming } from './lib/commands.mjs'
import { MENU_LABELS, MENU_TEXTS, REPLIES, formatAck, helpText, sessionLabel, statusText } from './lib/replies.mjs'
import {
  COMMANDS_MENU,
  MENU_BUTTON_ACTIONS,
  MENU_VERSION,
  helpScreenKeyboard,
  mainMenuKeyboard,
  parseCallbackData,
  replyKeyboard,
  selectedSessionKeyboard,
  sessionInlineKeyboard,
  sessionsInlineKeyboard,
  sessionsScreenKeyboard,
  settingsScreenKeyboard,
  shouldRefreshCommands,
  statusInlineKeyboard,
  statusScreenKeyboard,
} from './lib/menu.mjs'
import { callbackFromUpdate, messageFromUpdate } from './lib/messages.mjs'
import { botIdFromToken, loadOrCreateDevice } from './lib/device.mjs'
import { QUEUE_BRANCH, createGitQueue, resolveSyncRemote } from './lib/queue.mjs'
import { createQueueWorker } from './lib/queue-worker.mjs'
import {
  RATE_HOUR_LIMIT,
  RATE_WINDOW_MS,
  allowSender,
  checkSender,
  createRateLimiter,
  createUpdateDeduper,
  denySender,
} from './lib/security.mjs'
import { ANSWER_TIMEOUT_MS, THINKING_TEXT, createAnswerTracker } from './lib/answers.mjs'
import {
  BOT_DESCRIPTION,
  BOT_NAME,
  BOT_SHORT_DESCRIPTION,
  PROFILE_VERSION,
  botMenuButton,
  shouldRefreshProfile,
} from './lib/profile.mjs'

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

/** Route the page calls to publish the bot profile (name/description/menu button). */
const PROFILE_REFRESH_PATH = '/api/dsh-inbox/profile/refresh'

/** Route the page calls to delete a conflicting webhook. */
const WEBHOOK_DELETE_PATH = '/api/dsh-inbox/webhook/delete'

/** Route the page calls to change local security settings (owner, groups). */
const SECURITY_PATH = '/api/dsh-inbox/security'

/** How many sessions one `/sessions` page shows. */
const SESSIONS_PAGE_SIZE = 5

/** Sweep interval for answers that never received a turn end. */
const ANSWER_SWEEP_MS = 15_000

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
          : 1200,
        getClaimWaitMs: async () => {
          // One published device means no competitor: shorten the settle window.
          try {
            const devices = await queue.statuses()
            const others = devices.filter(entry => entry.deviceId !== device.id)
            if (others.length === 0 && state.queue?.listener === true) return 400
          } catch {
            // keep the default
          }
          return undefined
        },
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

  /** Per-chat command rate limiter (tests may disable it through the environment). */
  const rateLimiter = createRateLimiter({
    windowMs: Number.isFinite(Number(process.env.DSH_INBOX_RATE_LIMIT_MS))
      ? Number(process.env.DSH_INBOX_RATE_LIMIT_MS)
      : RATE_WINDOW_MS,
    hourLimit: Number.isFinite(Number(process.env.DSH_INBOX_RATE_HOUR_LIMIT))
      ? Number(process.env.DSH_INBOX_RATE_HOUR_LIMIT)
      : RATE_HOUR_LIMIT,
  })

  /** Telegram update ids already handled; a re-read batch must not run twice. */
  const updateDeduper = createUpdateDeduper()

  /** The chat of the command being executed, for the `beforePrompt` hook. */
  let activeCommandChat = null

  /** Last session id for which «⏳ Думаю…» was shown in this execution. */
  let thinkingSessionId = ''

  /** Answers waiting for `turn/end`. */
  const answers = createAnswerTracker({
    now: () => Date.now(),
    timeoutMs: Number.isFinite(Number(process.env.DSH_INBOX_ANSWER_TIMEOUT_MS))
      ? Number(process.env.DSH_INBOX_ANSWER_TIMEOUT_MS)
      : ANSWER_TIMEOUT_MS,
    sendTyping: async chatId => {
      const token = await resolveToken()
      if (token === '') return
      telegram.setToken(token)
      await telegram.sendChatAction({ chatId })
    },
    sendMessage: async ({ chatId, text }) => {
      const token = await resolveToken()
      if (token === '') throw new TelegramError('Токен Telegram не сохранён.', { code: 'no-token' })
      telegram.setToken(token)
      const result = await telegram.sendMessage({ chatId, text })
      return { messageId: result?.message_id }
    },
    editMessage: async ({ chatId, messageId, text }) => {
      const token = await resolveToken()
      if (token === '') throw new TelegramError('Токен Telegram не сохранён.', { code: 'no-token' })
      telegram.setToken(token)
      await telegram.editMessageText({ chatId, messageId, text })
    },
    recordOutgoing: async ({ chatId, chatTitle, text }) => {
      const appended = addMessage(state, {
        chatId,
        chatTitle: chatTitle === '' ? chatId : chatTitle,
        from: 'DSH',
        text,
        at: new Date().toISOString(),
        direction: 'out',
      })
      update({ messages: appended.messages })
      await persist()
    },
  })

  /** The working directory of the project the bot should list sessions for. */
  async function projectCwd() {
    try {
      const registry = service('workspaceRegistry')
      const workspaces = registry?.list?.() ?? []
      const first = workspaces.find?.(item => typeof item?.path === 'string' && item.path !== '')
      if (first !== undefined) return first.path
    } catch {
      // fall through to the current session/project directory
    }
    const chat = lastChat(state)
    const current = chat === undefined ? '' : (state.currentChatSession?.[chat.chatId] ?? '')
    if (current !== '') {
      try {
        const described = await sessions.describe(current)
        if (typeof described?.cwd === 'string' && described.cwd !== '') return described.cwd
      } catch {
        // ignore
      }
    }
    return process.cwd()
  }

  /** Normalise a path for comparisons (Windows is case-insensitive). */
  function samePath(left, right) {
    const a = String(left ?? '').replace(/[\\/]+$/, '').toLowerCase()
    const b = String(right ?? '').replace(/[\\/]+$/, '').toLowerCase()
    return a === b
  }

  /**
   * Build one page of the sessions screen: project filtering, page size and the
   * remembered index list for `use:<index>`.
   * @param request - `{ all?, page?, chatId }`.
   * @returns `{ text, keyboard, count, page, pages, rows }`.
   */
  async function sessionsScreen({ all = false, page = 1, chatId } = {}) {
    let rows = []
    try {
      rows = await sessions.list({ limit: 200 })
    } catch (error) {
      rows = []
      throw error
    }
    if (!all) {
      const cwd = await projectCwd()
      rows = rows.filter(row => row.blank !== true && row.cwd !== '' && samePath(row.cwd, cwd))
    }
    const pages = Math.max(1, Math.ceil(rows.length / SESSIONS_PAGE_SIZE))
    const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages)
    const pageRows = rows.slice((current - 1) * SESSIONS_PAGE_SIZE, current * SESSIONS_PAGE_SIZE)
    if (chatId !== undefined) {
      await commandPersist({
        pendingLists: {
          ...state.pendingLists,
          [String(chatId)]: pageRows.map(row => row.sessionId),
        },
      })
    }
    const lines = pageRows.map((row, index) =>
      `${index + 1}. ${row.title === '' ? row.sessionId.slice(0, 8) : row.title} — ${row.running ? 'выполняется' : 'ожидает'}`,
    )
    const text = rows.length === 0
      ? MENU_TEXTS.sessionsEmpty
      : `${MENU_TEXTS.sessionsHeader({ all, page: current, pages, count: rows.length })}\n${lines.join('\n')}`
    return {
      text,
      keyboard: sessionsScreenKeyboardWithRows(pageRows, { page: current, pages, all }),
      count: rows.length,
      page: current,
      pages,
      rows: pageRows,
    }
  }

  /** Screen keyboard with the session rows in front of the navigation row. */
  function sessionsScreenKeyboardWithRows(rows, options) {
    const nav = sessionsScreenKeyboard(options)
    const sessionsRows = rows.map((row, index) => [{
      text: `${index + 1}. ${row.title === '' ? row.sessionId.slice(0, 8) : row.title} — ${row.running ? 'выполняется' : 'ожидает'}`,
      callback_data: `use:${index + 1}`,
    }])
    return { inline_keyboard: [...sessionsRows, ...nav.inline_keyboard] }
  }

  /** Persist a state patch (helper for the screen builders). */
  async function commandPersist(patch) {
    update(patch)
    await persist()
  }

  /** The `/settings` screen content. */
  async function settingsScreen() {
    const info = await tokenInfo()
    const cwd = await projectCwd()
    const lines = [
      MENU_TEXTS.settingsTitle,
      `Бот: ${info.configured ? (state.botUsername === '' ? 'токен сохранён, имя не проверено' : `@${state.botUsername}`) : 'токен не сохранён'}`,
      `Владелец: ${state.ownerUserId === '' ? 'не назначен' : `${state.ownerUserId}${state.ownerChatId === '' ? '' : ` (чат ${state.ownerChatId})`}`}`,
      `Группы: ${state.security?.groupsEnabled === true ? 'разрешены' : 'запрещены'}`,
      `Белый список: ${state.allowedUserIds.length === 0 ? 'пуст — управлять нельзя никому' : `${state.allowedUserIds.length} польз.`}`,
      `Проект: ${cwd}`,
      `Очередь: ${queue !== null && queue.configured() ? (state.queue?.listener === true ? 'настроена, это устройство слушает Telegram' : 'настроена, это исполнитель') : 'inline, без remote'}`,
      '',
      'Изменить белый список, владельца и разрешение групп можно на странице плагина «Входящие».',
    ]
    return { text: lines.join('\n'), keyboard: settingsScreenKeyboard() }
  }

  /**
   * Select a session by the id from a deep link.
   * @param sessionId - id from `/start <id>`.
   * @returns `{ text, keyboard }`.
   */
  async function selectSessionById(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (id === '') throw new Error('Укажите идентификатор сессии: /start <sessionId>.')
    let rows = []
    try {
      rows = await sessions.list({ limit: 200 })
    } catch {
      rows = []
    }
    const row = rows.find(item => item.sessionId === id)
    if (row === undefined) {
      throw new Error('Сессия не найдена: возможно, её удалили или она ещё не загружена.')
    }
    const targetChat = activeCommandChat?.chatId ?? lastChat(state)?.chatId ?? ''
    update({ currentChatSession: { ...state.currentChatSession, [targetChat]: id } })
    await persist()
    const label = sessionLabel(row.title, id)
    return { text: MENU_TEXTS.sessionChosen(label), keyboard: selectedSessionKeyboard() }
  }

  /**
   * Publish the bot profile (name, descriptions, chat menu button) with a daily
   * cache. Failures are reported, never thrown into polling.
   * @param force - ignore the cache.
   * @returns `{ ok, cached, message }`.
   */
  async function refreshBotProfile(force = false) {
    const token = await resolveToken()
    if (token === '') return { ok: false, code: 'missing', cached: false, message: 'Токен Telegram не сохранён.' }
    const now = Date.now()
    if (!force && !shouldRefreshProfile(state.botProfile, now, PROFILE_VERSION)) {
      return { ok: true, cached: true, message: 'Профиль бота уже опубликован.' }
    }
    telegram.setToken(token)
    try {
      await telegram.setMyName(BOT_NAME)
      await telegram.setMyDescription(BOT_DESCRIPTION)
      await telegram.setMyShortDescription(BOT_SHORT_DESCRIPTION)
      await telegram.setChatMenuButton(botMenuButton())
      update({
        botProfile: {
          name: BOT_NAME,
          description: BOT_DESCRIPTION,
          shortDescription: BOT_SHORT_DESCRIPTION,
          at: now,
          version: PROFILE_VERSION,
          ok: true,
        },
      })
      await persist()
      return { ok: true, cached: false, message: 'Профиль бота обновлён.' }
    } catch (error) {
      update({
        botProfile: {
          ...state.botProfile,
          at: now,
          version: PROFILE_VERSION,
          ok: false,
        },
      })
      await persist()
      const message = redact(describeTelegramError(error, token), token)
      console.warn('[dsh-inbox] не удалось обновить профиль бота:', message)
      return { ok: false, code: 'failed', cached: false, message }
    }
  }

  /**
   * Explain a 409 Conflict: read the webhook and ask the person to remove it.
   * @returns the instruction text.
   */
  async function explainConflict() {
    const token = await resolveToken()
    let url = ''
    if (token !== '') {
      telegram.setToken(token)
      try {
        const info = await telegram.getWebhookInfo()
        url = typeof info?.url === 'string' ? info.url : ''
      } catch {
        url = ''
      }
    }
    update({ webhook: { url, checkedAt: Date.now() } })
    await persist()
    const message = url === ''
      ? 'Конфликт 409: этого бота опрашивает другая программа. Остановите её и включите приём снова.'
      : `Конфликт 409: у бота включён webhook (${url}). Нажмите «Снять webhook» на странице плагина, чтобы вернуться к long polling.`
    update({ lastError: message })
    await persist()
    return message
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
      // A working token is the natural moment to publish the «/» menu and profile.
      await refreshCommands()
      await refreshBotProfile()
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
      const userId = typeof message.fromId === 'string' ? message.fromId : message.chatId
      const verdict = checkSender(state, { chatId: message.chatId, fromId: userId, chatType: message.chatType })
      chats.push({
        chatId: message.chatId,
        chatTitle: message.chatTitle,
        userId,
        chatType: message.chatType ?? 'private',
        allowed: verdict.allowed === true,
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

  /** Add one Telegram user to the allow-list and persist it. */
  async function addAllowedChat(chatId) {
    const id = normalizeChatId(chatId)
    if (id === '') throw new Error('Неверный chatId: нужен числовой идентификатор пользователя Telegram.')
    const result = allowSender(state, { chatId: id, fromId: id })
    if (result.changed) {
      update({
        allowedUserIds: result.state.allowedUserIds,
        allowedChatIds: result.state.allowedChatIds,
        ownerUserId: result.state.ownerUserId,
        ownerChatId: result.state.ownerChatId,
      })
      await persist()
    }
    return { changed: result.changed, allowedChatIds: state.allowedChatIds, allowedUserIds: state.allowedUserIds }
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
    sessionsScreen,
    settingsScreen,
    selectSessionById,
    beforePrompt: async sessionId => {
      thinkingSessionId = String(sessionId ?? '')
      if (thinkingSessionId === '' || activeCommandChat === null) return
      await answers.begin({
        sessionId: thinkingSessionId,
        chatId: activeCommandChat.chatId,
        chatTitle: activeCommandChat.chatTitle,
      })
    },
  }

  /**
   * Build the reply of one message command without sending it.
   * @param record - `{ chatId, chatTitle, text }`.
   * @returns `{ status, text, markup?, skipAck? }`.
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
    activeCommandChat = { chatId: record.chatId, chatTitle: record.chatTitle }
    thinkingSessionId = ''
    try {
      const result = await executeCommand({
        command: parsed.command,
        args: parsed.args,
        chatId: record.chatId,
        deps: commandDeps,
      })
      if (result.thinking === true) {
        // The «⏳ Думаю…» message becomes the answer on turn/end; no extra ack.
        return { status: 'ok', skipAck: true, text: '' }
      }
      return {
        status: 'ok',
        text: formatAck(true, result.summary, result.details),
        markup: result.replyKeyboard === true ? replyKeyboard() : result.inlineKeyboard,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const clean = typeof message === 'string' && message !== '' ? message : 'неизвестная ошибка'
      if (thinkingSessionId !== '') {
        await answers.fail(thinkingSessionId, clean)
        return { status: 'error', skipAck: true, text: '' }
      }
      return { status: 'error', text: formatAck(false, clean) }
    } finally {
      activeCommandChat = null
    }
  }

  /** Send one command reply and remember it in the local history. */
  async function deliverReply(record, reply) {
    if (reply.skipAck === true) return { ok: true, skipped: true }
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
    // Defence in depth: a command file from git is re-checked against the local
    // allow-list before it runs.
    const verdict = checkSender(state, {
      chatId: command.chatId,
      fromId: command.fromId,
      chatType: command.chatType,
    })
    if (verdict.allowed !== true) {
      return { status: 'error', output: 'отклонено проверкой отправителя на исполнителе', delivered: true }
    }
    if (command.callback !== undefined) {
      // A callback needs its own answer and message edit, so the executor sends
      // those itself and reports the command as delivered.
      await handleCallback({
        callbackId: command.callback.callbackId,
        chatId: command.chatId,
        chatTitle: command.chatTitle,
        messageId: command.callback.messageId,
        data: command.callback.data,
        from: command.fromName ?? '',
        fromId: command.fromId,
        chatType: command.chatType,
      })
      return {
        status: 'ok',
        output: `кнопка: ${command.callback.data}`,
        delivered: true,
      }
    }
    const record = {
      chatId: command.chatId,
      chatTitle: command.chatTitle,
      text: command.text,
      fromId: command.fromId,
      chatType: command.chatType,
    }
    const reply = await buildCommandReply(record)
    if (reply.skipAck === true) return { status: reply.status, output: '', delivered: true }
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
    const token = await resolveToken()
    if (token !== '') {
      telegram.setToken(token)
      if (callback.messageId !== undefined) {
        try {
          await telegram.editMessageText({
            chatId: callback.chatId,
            messageId: callback.messageId,
            text,
            replyMarkup: markup,
          })
          return
        } catch (error) {
          // The wanted text is already there; sending a duplicate would be wrong.
          if (isNotModifiedError(error)) return
          // fall back to a fresh message
        }
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
    /** Show one sessions page; the list is also remembered for `use:<index>`. */
    const showSessions = async (all, page) => {
      let screen
      try {
        screen = await sessionsScreen({ all, page, chatId })
      } catch (error) {
        const message = error instanceof Error ? error.message : MENU_TEXTS.refreshFailed
        await ack(MENU_TEXTS.refreshFailed)
        await editCallbackMessage(callback, formatAck(false, message), mainMenuKeyboard())
        return
      }
      await ack(screen.count === 0 ? MENU_TEXTS.sessionsEmpty : `Страница ${screen.page}/${screen.pages}`)
      await editCallbackMessage(callback, screen.text, screen.keyboard)
    }
    /** Select a session by id and show the selected screen. */
    const chooseSession = async sessionId => {
      if (String(sessionId ?? '') === '') {
        await ack(MENU_TEXTS.sessionNotChosenForCallback)
        return
      }
      update({ currentChatSession: { ...state.currentChatSession, [chatId]: String(sessionId) } })
      await persist()
      const label = sessionLabel(await cachedTitle(sessionId), sessionId)
      await ack('Сессия выбрана')
      await editCallbackMessage(callback, `${MENU_TEXTS.sessionChosen(label)}\n\n${MENU_TEXTS.hintAsk}`, selectedSessionKeyboard())
    }
    if (parsed.action === 'use') {
      let sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      if (Number.isFinite(parsed.index)) {
        const list = state.pendingLists?.[chatId] ?? []
        sessionId = list[parsed.index - 1] ?? ''
        if (sessionId === '') {
          await ack(MENU_TEXTS.sessionNotChosenForCallback)
          return
        }
      }
      await chooseSession(sessionId)
      return
    }
    if (parsed.action === 'sessions' || parsed.action === 'sessions-all' || parsed.action === 'refresh' || parsed.action === 'refresh-all' || parsed.action === 'sessions-refresh') {
      const all = parsed.action === 'sessions-all' || parsed.action === 'refresh-all'
      const page = Number.isFinite(parsed.page) ? parsed.page : 1
      await showSessions(all, page)
      return
    }
    if (parsed.action === 'stop' || parsed.action === 'cancel') {
      const sessionId = parsed.action === 'cancel' && typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
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
        await editCallbackMessage(callback, formatAck(false, message), statusScreenKeyboard())
        return
      }
      const label = sessionLabel(await cachedTitle(sessionId), sessionId)
      await ack('Отмена запрошена')
      await editCallbackMessage(callback, MENU_TEXTS.stopCancelled(label), statusScreenKeyboard())
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
          allowedCount: state.allowedUserIds.length,
          current,
          sessionsAvailable: sessions.available(),
        }),
        statusScreenKeyboard(),
      )
      return
    }
    if (parsed.action === 'settings') {
      const screen = await settingsScreen()
      await ack('Настройки')
      await editCallbackMessage(callback, screen.text, screen.keyboard)
      return
    }
    if (parsed.action === 'help') {
      await ack('Помощь')
      await editCallbackMessage(callback, helpText(), helpScreenKeyboard())
      return
    }
    if (parsed.action === 'menu') {
      await ack(MENU_TEXTS.menuSent)
      await editCallbackMessage(callback, MENU_TEXTS.greeting, mainMenuKeyboard())
      return
    }
    if (parsed.action === 'ask-hint' || parsed.action === 'ask') {
      await ack(MENU_TEXTS.askHintSent)
      await editCallbackMessage(callback, `${MENU_TEXTS.askHintSent}\n${MENU_TEXTS.hintAsk}`, mainMenuKeyboard())
      return
    }
    if (parsed.action === 'new-hint') {
      await ack(MENU_TEXTS.hintNew)
      await say(chatId, chatTitle, MENU_TEXTS.hintNew)
      return
    }
    if (parsed.action === 'noop') {
      await ack('Обновите список кнопкой «🔄 Обновить»')
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
      const verdict = checkSender(state, callback)
      if (verdict.allowed !== true) {
        const text = verdict.reason === 'group' ? MENU_TEXTS.groupsDenied : MENU_TEXTS.callbackDenied
        if (denyLimiter.shouldNotify(callback.chatId)) {
          try {
            await sendTelegram(callback.chatId, text, { record: false })
          } catch {
            // the denial is best effort
          }
        }
        await ack(text)
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

  /** Denial notice for an unknown sender or a forbidden group, at most one per 5 min. */
  async function denyForeign(target, reason) {
    if (!denyLimiter.shouldNotify(target.chatId)) return
    const text = reason === 'group' ? MENU_TEXTS.groupsDenied : MENU_TEXTS.notListed
    try {
      await sendTelegram(target.chatId, text, { record: false })
    } catch (error) {
      update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
    }
  }

  /** Text of a rate-limit notice. */
  function rateNoticeText(rate) {
    if (rate.reason === 'hour') return MENU_TEXTS.hourLimited
    const seconds = Math.max(1, Math.ceil((rate.retryAfterMs ?? RATE_WINDOW_MS) / 1000))
    return MENU_TEXTS.rateLimited(seconds)
  }

  /** Rate-limit notice, at most once per 5 minutes per chat. */
  const rateNoticeLimiter = createDenyLimiter()
  async function rateNotice(record, rate) {
    if (!rateNoticeLimiter.shouldNotify(record.chatId)) return
    try {
      await sendTelegram(record.chatId, rateNoticeText(rate))
    } catch (error) {
      update({ lastError: `не удалось ответить в Telegram: ${redact(error?.message ?? error)}` })
    }
  }

  /**
   * Handle one long-poll batch. Every callback is answered immediately (before
   * any slow work); senders are checked by user id and chat type; commands are
   * rate-limited and deduplicated. Without a configured shared queue commands run
   * inline, with a queue they become immutable command files for the worker.
   * @param batch - `{ updates, offset, signal }` from the poller.
   */
  async function handleBatch({ updates, offset }) {
    const queueActive = queue !== null && queue.configured()
    const incoming = []
    const executable = []
    const commands = []
    const callbacks = []
    for (const update of updates) {
      if (updateDeduper.seen(update.update_id)) continue
      const callback = callbackFromUpdate(update)
      if (callback !== undefined) {
        callbacks.push(callback)
        continue
      }
      const record = messageFromUpdate(update)
      if (record === undefined) continue
      const verdict = checkSender(state, record)
      if (verdict.allowed !== true) {
        // Stored so the page can show the chat and offer "Разрешить".
        incoming.push({ ...record, blocked: true })
        await denyForeign(record, verdict.reason)
        continue
      }
      incoming.push(record)
      const rate = rateLimiter.check(record.chatId)
      if (!rate.ok) {
        await rateNotice(record, rate)
        continue
      }
      executable.push(record)
      if (queueActive) {
        commands.push({
          chatId: record.chatId,
          chatTitle: record.chatTitle,
          updateId: Number(update.update_id),
          text: record.text,
          fromId: record.fromId,
          chatType: record.chatType,
          fromName: record.from,
        })
      }
    }
    // Callbacks first: a pressed button must never wait for a slow command batch.
    for (const callback of callbacks) {
      if (callback.chatId === '') {
        await answerCallbackQuick(callback, 'Не удалось определить чат.')
        continue
      }
      const verdict = checkSender(state, callback)
      if (verdict.allowed !== true) {
        await answerCallbackQuick(callback, verdict.reason === 'group' ? MENU_TEXTS.groupsDenied : MENU_TEXTS.callbackDenied)
        await denyForeign(callback, verdict.reason)
        continue
      }
      const rate = rateLimiter.check(callback.chatId)
      if (!rate.ok) {
        await answerCallbackQuick(callback, rateNoticeText(rate))
        continue
      }
      if (queueActive) {
        // Stop the spinner now; the executor edits the message later.
        await answerCallbackQuick(callback, '')
        commands.push({
          chatId: callback.chatId,
          chatTitle: callback.chatTitle,
          updateId: Number(update.update_id),
          fromId: callback.fromId,
          chatType: callback.chatType,
          fromName: callback.from,
          callback: {
            callbackId: callback.callbackId,
            data: callback.data,
            messageId: callback.messageId,
          },
        })
      } else {
        await handleCallback(callback)
      }
    }
    if (!queueActive) {
      const appended = addMessages({ ...state, messages: state.messages }, incoming)
      update({ offset, messages: appended.messages, lastError: '' })
      await persist()
      for (const record of executable) {
        if (record.text.trim() === '') continue
        await processIncoming(record)
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
    onConflict: async () => {
      await explainConflict()
    },
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
      void refreshBotProfile()
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
            allowedUserIds: state.allowedUserIds,
            owner: { userId: state.ownerUserId, chatId: state.ownerChatId },
            security: { groupsEnabled: state.security?.groupsEnabled === true },
            botProfile: {
              name: state.botProfile?.name ?? '',
              description: state.botProfile?.description ?? '',
              shortDescription: state.botProfile?.shortDescription ?? '',
              at: Number(state.botProfile?.at) || 0,
              version: state.botProfile?.version ?? '',
              ok: state.botProfile?.ok === true && state.botProfile?.version === PROFILE_VERSION,
              commands: COMMANDS_MENU.map(item => `/${item.command}`),
            },
            webhook: state.webhook ?? { url: '', checkedAt: 0 },
            answersPending: answers.size(),
            project: await projectCwd().catch(() => process.cwd()),
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
          const list = Array.isArray(body.userIds) ? body.userIds : (Array.isArray(body.chatIds) ? body.chatIds : undefined)
          if (Array.isArray(list)) {
            const invalid = []
            const valid = []
            for (const item of list) {
              const id = normalizeChatId(item)
              if (id === '') invalid.push(String(item))
              else if (!valid.includes(id)) valid.push(id)
            }
            if (invalid.length > 0) {
              return json({
                ok: false,
                message: `Неверные id: ${invalid.join(', ')}. Нужны числа — Telegram user id из личного чата.`,
              })
            }
            const allowedUserIds = normalizeChatIds(valid)
            const next = { allowedUserIds, allowedChatIds: [...allowedUserIds] }
            if (!state.ownerUserId && allowedUserIds.length > 0) {
              next.ownerUserId = allowedUserIds[0]
              next.ownerChatId = allowedUserIds[0]
            }
            update(next)
            await persist()
            return json({
              ok: true,
              allowedUserIds,
              allowedChatIds: state.allowedChatIds,
              owner: { userId: state.ownerUserId, chatId: state.ownerChatId },
              message: allowedUserIds.length === 0
                ? 'Белый список пуст: управлять DSH из Telegram нельзя никому.'
                : `Пользователей в белом списке: ${allowedUserIds.length}.`,
            })
          }
          if (typeof body.add === 'string') {
            try {
              const result = await addAllowedChat(body.add)
              return json({
                ok: true,
                allowedUserIds: result.allowedUserIds,
                allowedChatIds: result.allowedChatIds,
                owner: { userId: state.ownerUserId, chatId: state.ownerChatId },
                message: result.changed
                  ? `Пользователь ${normalizeChatId(body.add)} добавлен в белый список.`
                  : 'Пользователь уже был в белом списке.',
              })
            } catch (error) {
              return json({ ok: false, message: error instanceof Error ? error.message : String(error) })
            }
          }
          if (typeof body.remove === 'string') {
            const removed = denySender(state, body.remove)
            const changed = removed.changed
            update({
              allowedUserIds: removed.state.allowedUserIds,
              allowedChatIds: removed.state.allowedChatIds,
              ownerUserId: removed.state.ownerUserId,
              ownerChatId: removed.state.ownerChatId,
            })
            await persist()
            return json({
              ok: true,
              allowedUserIds: state.allowedUserIds,
              allowedChatIds: state.allowedChatIds,
              owner: { userId: state.ownerUserId, chatId: state.ownerChatId },
              message: changed
                ? 'Пользователь удалён из белого списка.'
                : 'Этого пользователя не было в списке (владельца удалить нельзя).',
            })
          }
          return json({ ok: false, message: 'Укажите userIds, add или remove.' })
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
      ctx.connection.fetch.register({
        path: PROFILE_REFRESH_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const result = await refreshBotProfile(body.force !== false)
          return json({ ok: result.ok === true, ...result })
        },
      })

      ctx.connection.fetch.register({
        path: WEBHOOK_DELETE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          await ready
          const token = await resolveToken()
          if (token === '') return json({ ok: false, message: 'Токен Telegram не сохранён.' })
          telegram.setToken(token)
          try {
            await telegram.deleteWebhook()
          } catch (error) {
            return json({ ok: false, message: redact(describeTelegramError(error, token), token) })
          }
          let url = ''
          try {
            const info = await telegram.getWebhookInfo()
            url = typeof info?.url === 'string' ? info.url : ''
          } catch {
            url = ''
          }
          update({ webhook: { url, checkedAt: Date.now() }, lastError: url === '' ? '' : `Webhook всё ещё задан: ${url}` })
          await persist()
          if (state.enabled === true && canPoll()) await startPollingIfWanted()
          return json({
            ok: url === '',
            webhook: state.webhook,
            polling: poller.running,
            message: url === '' ? 'Webhook снят. Приём сообщений снова работает.' : `Webhook всё ещё задан: ${url}`,
          })
        },
      })

      ctx.connection.fetch.register({
        path: SECURITY_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          await ready
          const body = await readBody(request)
          const patch = {}
          if (typeof body.groupsEnabled === 'boolean') {
            patch.security = { groupsEnabled: body.groupsEnabled }
          }
          if (typeof body.ownerUserId === 'string') {
            const owner = normalizeChatId(body.ownerUserId)
            if (owner === '') return json({ ok: false, message: 'Неверный ownerUserId.' })
            patch.ownerUserId = owner
            if (!state.allowedUserIds.includes(owner)) {
              patch.allowedUserIds = normalizeChatIds([...state.allowedUserIds, owner])
              patch.allowedChatIds = [...patch.allowedUserIds]
            }
            if (typeof body.ownerChatId === 'string' && normalizeChatId(body.ownerChatId) !== '') {
              patch.ownerChatId = normalizeChatId(body.ownerChatId)
            }
          }
          update(patch)
          await persist()
          return json({
            ok: true,
            security: state.security,
            owner: { userId: state.ownerUserId, chatId: state.ownerChatId },
            allowedUserIds: state.allowedUserIds,
            message: 'Настройки безопасности сохранены.',
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
          // A new token may belong to another bot, which needs its own menu and profile.
          update({
            botUsername: '',
            commandsMenu: { version: '', at: 0, ok: false },
            botProfile: { ...state.botProfile, version: '', ok: false },
          }, { persist: true })
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
        // The daily-cached command list and bot profile are checked on every start.
        void refreshCommands()
        void refreshBotProfile()
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
      answers.clear()
    }
  }, 'dsh-inbox: polling lifecycle')

  // Answers from DSH: remember assistant text and finish on turn/end.
  try {
    ctx.effect(
      () =>
        ctx.on('session/event', (session, event) => {
          void answers.handleEvent(session, event)
        }),
      'dsh-inbox: answers',
    )
  } catch (error) {
    console.error('[dsh-inbox] ответы из DSH недоступны:', error)
  }

  // A lost turn/end must not leave «⏳ Думаю…» forever.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void answers.sweep()
    }, ANSWER_SWEEP_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-inbox: answer timeout')
}
