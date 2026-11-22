/**
 * Shared test helpers: a temporary inbox directory, a minimal plugin context
 * and an in-memory Telegram API.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Run a test body with `DSH_INBOX_DIR` pointing at a fresh temporary directory.
 * @param body - async callback receiving the directory path.
 * @returns whatever the callback returns.
 */
export async function withTempInbox(body) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-inbox-test-'))
  const previous = process.env.DSH_INBOX_DIR
  const previousSync = process.env.DSH_INBOX_SYNC_CONFIG
  const previousRemote = process.env.DSH_INBOX_QUEUE_REMOTE
  const previousQueueDir = process.env.DSH_INBOX_QUEUE_DIR
  process.env.DSH_INBOX_DIR = dir
  // Never touch the real dsh-sync settings or remote from a test.
  process.env.DSH_INBOX_SYNC_CONFIG = join(dir, 'no-sync-config.json')
  delete process.env.DSH_INBOX_QUEUE_REMOTE
  delete process.env.DSH_INBOX_QUEUE_DIR
  try {
    return await body(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_INBOX_DIR
    else process.env.DSH_INBOX_DIR = previous
    if (previousSync === undefined) delete process.env.DSH_INBOX_SYNC_CONFIG
    else process.env.DSH_INBOX_SYNC_CONFIG = previousSync
    if (previousRemote === undefined) delete process.env.DSH_INBOX_QUEUE_REMOTE
    else process.env.DSH_INBOX_QUEUE_REMOTE = previousRemote
    if (previousQueueDir === undefined) delete process.env.DSH_INBOX_QUEUE_DIR
    else process.env.DSH_INBOX_QUEUE_DIR = previousQueueDir
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 })
  }
}

/**
 * Minimal plugin context that records tools, routes and effect disposers.
 * @param options - `{ token?, writable?, controller?, query? }`: credential
 *   store stub and optional DSH session services.
 * @returns the fake context.
 */
export function fakeContext(options = {}) {
  const token = typeof options.token === 'string' ? options.token : ''
  const writable = options.writable !== false
  const tools = []
  const routes = []
  const effects = []
  const ctx = {
    tools: { register: definition => tools.push(definition) },
    connection: { fetch: { register: route => routes.push(route) } },
    credentials: {
      resolve: async () => (token === '' ? undefined : { value: token, source: 'stored' }),
      describe: async () => ({ configured: token !== '', writable }),
    },
    sessionPersistence: {},
    sessionQuery: options.query,
    get: name => {
      if (name === 'sessionController') return options.controller
      if (name === 'sessionQuery') return options.query
      return undefined
    },
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    on: () => () => {},
  }
  ctx.toolsList = tools
  ctx.routesList = routes
  ctx.disposeAll = async () => {
    while (effects.length > 0) {
      const dispose = effects.pop()
      try {
        await dispose()
      } catch {
        // a disposer must not mask the test result
      }
    }
  }
  return ctx
}

/**
 * Call one registered POST route.
 * @param ctx - fake context after `apply`.
 * @param path - route path.
 * @param payload - JSON body.
 * @returns the parsed response body.
 */
export async function callRoute(ctx, path, payload) {
  const route = ctx.routesList.find(item => item.path === path)
  if (route === undefined) throw new Error(`маршрут ${path} не зарегистрирован`)
  const response = await route.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }))
  return await response.json()
}

/** One Telegram-style JSON response. */
export function telegramResponse(result, status = 200) {
  return new Response(JSON.stringify({ ok: status === 200, result }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** One Telegram-style error response. */
export function telegramError(errorCode, description, status) {
  return new Response(JSON.stringify({ ok: false, error_code: errorCode, description }), {
    status: status ?? errorCode,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Replace the global `fetch` for the duration of one test.
 * @param handler - `({ url, method, body }) => Response`.
 * @returns `{ calls, restore }`.
 */
export function installFetch(handler) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    let body
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    } catch {
      body = undefined
    }
    const method = url.slice(url.lastIndexOf('/') + 1)
    calls.push({ url, method, body })
    return await handler({ url, method, body, calls })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

/**
 * A Telegram Bot API double: `getMe`, `getUpdates`, `sendMessage`,
 * `setMyCommands`, `editMessageText` and `answerCallbackQuery` with built-in
 * defaults; outgoing text and call data are remembered.
 * @param options - overrides per method.
 * @returns `{ calls, sent, myCommands, edits, answers, restore }`.
 */
export function telegramMock(options = {}) {
  const sent = []
  const myCommands = []
  const edits = []
  const answers = []
  const mock = installFetch(({ method, body }) => {
    if (method === 'getMe') {
      return options.getMe !== undefined
        ? options.getMe(body)
        : telegramResponse({ id: 1, is_bot: true, username: 'dsh_inbox_test_bot' })
    }
    if (method === 'getUpdates') {
      return options.getUpdates !== undefined ? options.getUpdates(body) : telegramResponse([])
    }
    if (method === 'sendMessage') {
      sent.push(body)
      return options.sendMessage !== undefined
        ? options.sendMessage(body)
        : telegramResponse({ message_id: sent.length })
    }
    if (method === 'setMyCommands') {
      myCommands.push(body)
      return options.setMyCommands !== undefined
        ? options.setMyCommands(body)
        : telegramResponse(true)
    }
    if (method === 'editMessageText') {
      edits.push(body)
      return options.editMessageText !== undefined
        ? options.editMessageText(body)
        : telegramResponse({ message_id: body.message_id })
    }
    if (method === 'answerCallbackQuery') {
      answers.push(body)
      return options.answerCallbackQuery !== undefined
        ? options.answerCallbackQuery(body)
        : telegramResponse(true)
    }
    return telegramError(404, 'Not Found', 404)
  })
  return { calls: mock.calls, sent, myCommands, edits, answers, restore: mock.restore }
}

/**
 * Poll a predicate until it is true or the timeout expires.
 * @param predicate - async check.
 * @param timeoutMs - how long to wait.
 * @returns true when the predicate became true.
 */
export async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

/** Pause for a test. */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
