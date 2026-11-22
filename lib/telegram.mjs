/**
 * Minimal Telegram Bot API client.
 *
 * Only what the MVP needs: `getMe` for the token check, `getUpdates` for long
 * polling and `sendMessage` for replies. The token is passed as an argument,
 * never stored in this module, and is scrubbed from every error message that
 * leaves it — the token must not appear in a route response, a log or the state
 * file.
 */

/** The only network origin this plugin talks to. */
export const API_ORIGIN = 'https://api.telegram.org'

/** Default request timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 20_000

/** Telegram bot tokens look like `123456789:AA...`; scrub them from text. */
const TOKEN_SHAPE = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g

/** An error raised by this client; `status` mirrors Telegram's `error_code`. */
export class TelegramError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'TelegramError'
    this.code = options.code ?? 'telegram'
    this.status = options.status
    this.retryAfter = options.retryAfter
  }
}

/**
 * Remove the bot token from a string.
 * @param value - any value to clean.
 * @param token - the live token, when known.
 * @returns text safe to show and to log.
 */
export function redact(value, token) {
  let text = String(value ?? '')
  if (typeof token === 'string' && token !== '') text = text.split(token).join('<токен скрыт>')
  return text.replace(TOKEN_SHAPE, '<токен скрыт>')
}

/**
 * A short Russian explanation of a Telegram error for the UI and the agent.
 * @param error - thrown value.
 * @param token - live token, scrubbed from the text.
 * @returns one sentence.
 */
export function describeTelegramError(error, token = '') {
  if (error instanceof TelegramError) {
    if (error.code === 'no-token') return 'Токен Telegram не сохранён.'
    if (error.code === 'aborted') return 'Операция отменена.'
    if (error.status === 401) return 'Telegram отклонил токен (401): проверьте значение от @BotFather.'
    if (error.status === 403) return 'Telegram запретил действие (403): бот заблокирован или исключён из чата.'
    if (error.status === 404) return 'Telegram не нашёл бота (404): проверьте токен.'
    if (error.status === 409) return 'Конфликт (409): этого бота уже опрашивает другая программа или включён webhook.'
    if (error.status === 429) {
      const wait = Number.isFinite(error.retryAfter) ? ` Повторите через ${error.retryAfter} с.` : ''
      return `Telegram ограничил частоту запросов (429).${wait}`
    }
    if (error.code === 'timeout') return 'Telegram не ответил за отведённое время: проверьте интернет.'
    if (error.code === 'network') return 'Не удалось связаться с Telegram: проверьте интернет.'
    return redact(error.message, token)
  }
  return `Не удалось связаться с Telegram: ${redact(error?.message ?? error, token) || 'неизвестная ошибка'}.`
}

/**
 * Build a Telegram client.
 * @param options - `{ token?, fetchImpl?, timeoutMs? }`; `fetchImpl` defaults to
 *   the global `fetch` looked up per call, which keeps tests easy to stub.
 * @returns the client with `getMe`, `getUpdates`, `sendMessage` and `setToken`.
 */
export function createTelegram(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (input, init) => globalThis.fetch(input, init)
  const defaultTimeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  let token = typeof options.token === 'string' ? options.token : ''

  /**
   * Send one Bot API method and return its `result`.
   * @param method - Bot API method name.
   * @param payload - JSON body.
   * @param options - `{ signal?, timeoutMs? }`.
   * @returns the `result` field.
   */
  async function call(method, payload = {}, callOptions = {}) {
    if (token === '') throw new TelegramError('Токен Telegram не сохранён.', { code: 'no-token' })
    const signal = callOptions.signal
    const timeoutMs = Number.isFinite(callOptions.timeoutMs) ? callOptions.timeoutMs : defaultTimeout
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) throw new TelegramError('Операция отменена.', { code: 'aborted' })
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${API_ORIGIN}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      })
      const raw = await response.text()
      let body
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        throw new TelegramError(`Telegram ответил ${response.status} нечитаемым ответом.`, {
          code: 'api',
          status: response.status,
        })
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        const description = body !== null && typeof body === 'object' ? body.description : undefined
        const errorCode = body !== null && typeof body === 'object' && Number.isFinite(body.error_code)
          ? body.error_code
          : response.status
        const parameters = body !== null && typeof body === 'object' ? body.parameters : undefined
        const clean = redact(description, token)
        throw new TelegramError(clean === '' ? `Telegram ответил ошибкой ${errorCode}.` : `Telegram: ${clean}`, {
          code: 'api',
          status: errorCode,
          retryAfter: parameters?.retry_after,
        })
      }
      return body.result
    } catch (error) {
      if (error instanceof TelegramError) throw error
      if (error?.name === 'AbortError') {
        throw new TelegramError(
          signal !== undefined && signal !== null && signal.aborted
            ? 'Операция отменена.'
            : 'Telegram не ответил за отведённое время.',
          { code: signal !== undefined && signal !== null && signal.aborted ? 'aborted' : 'timeout' },
        )
      }
      throw new TelegramError(`Не удалось связаться с Telegram: ${redact(error?.message, token)}`, { code: 'network' })
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forwardAbort)
    }
  }

  return {
    /** Replace the token used by the following calls. */
    setToken(next) {
      token = typeof next === 'string' ? next : ''
    },
    /** Which bot this token belongs to. */
    async getMe(callOptions) {
      return call('getMe', {}, callOptions)
    },
    /**
     * Long polling for new messages.
     * @param options - `{ offset?, timeout? }`; `timeout` is Telegram's long-poll
     *   window in seconds. The request itself waits longer than that window.
     */
    async getUpdates(options = {}, callOptions = {}) {
      const longPoll = Number.isFinite(options.timeout) ? options.timeout : 25
      return call('getUpdates', {
        offset: Number.isFinite(options.offset) ? options.offset : 0,
        timeout: longPoll,
        allowed_updates: ['message'],
      }, { ...callOptions, timeoutMs: (longPoll + 15) * 1000 })
    },
    /** Send a text message to a chat. */
    async sendMessage({ chatId, text }, callOptions) {
      return call('sendMessage', { chat_id: chatId, text }, callOptions)
    },
  }
}
