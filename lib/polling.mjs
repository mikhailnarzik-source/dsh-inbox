/**
 * The long-polling loop.
 *
 * Telegram keeps updates for a limited time and hands them out through
 * `getUpdates` with an offset: after a batch is stored, the next request asks
 * for everything after the highest seen update id. The loop is deliberately
 * small and dependency-injected so tests drive it without the network:
 *
 * - an update batch is written to the history and the offset is persisted;
 * - after an error the loop waits 1 s, then doubles the pause up to 30 s;
 * - `401` means the token is not accepted: the loop stops and the receive
 *   switch is turned off so the page shows the real state;
 * - without a stored token the loop waits quietly and retries later, so saving
 *   the token starts working without a restart.
 */

import { describeTelegramError, redact, TelegramError } from './telegram.mjs'
import { messageFromUpdate, nextOffset } from './messages.mjs'
import { addMessages } from './storage.mjs'

/** Telegram long-poll window, in seconds. */
export const LONG_POLL_SECONDS = 25

/** First pause after an error, in milliseconds. */
export const FIRST_ERROR_DELAY_MS = 1000

/** Upper bound of the exponential backoff, in milliseconds. */
export const MAX_ERROR_DELAY_MS = 30_000

/** A short pause after an empty batch, so a misbehaving API cannot spin. */
export const EMPTY_PAUSE_MS = 300

/** How long the loop waits for a token that is not stored yet. */
export const NO_TOKEN_DELAY_MS = 5000

/**
 * The next backoff step: 1 s, 2 s, 4 s … capped at 30 s.
 * @param previous - the pause used last time.
 * @returns the next pause in milliseconds.
 */
export function nextBackoff(previous) {
  if (!Number.isFinite(previous) || previous < FIRST_ERROR_DELAY_MS) return FIRST_ERROR_DELAY_MS
  return Math.min(previous * 2, MAX_ERROR_DELAY_MS)
}

/**
 * A sleep that ends early when the loop is aborted.
 * @param ms - how long to wait.
 * @param signal - abort signal of the loop.
 * @returns a promise resolved after the pause or on abort.
 */
export function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal !== undefined && signal !== null && signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Build the poller.
 *
 * Dependencies:
 * - `getToken(): Promise<string>` — read the token from the credential store;
 * - `getState(): state` — the live state object;
 * - `update(patch, { persist? }): void` — apply a patch and optionally save it;
 * - `getTelegram(): client` — the Telegram client to drive;
 * - `handleBatch({ updates, offset, signal })` — hand one update batch to the
 *   inbox runtime, which decides what to store, what to answer and which chats
 *   are allowed. Without it the loop stores every message and advances the
 *   offset itself (the standalone behaviour);
 * - `onUnauthorized?(): void` — called once after a `401` stop;
 * - `sleep?(ms, signal)` — pause implementation, for tests.
 *
 * @param deps - the dependencies above.
 * @returns `{ start, stop, running }`.
 */
export function createPoller(deps) {
  const pause = typeof deps.sleep === 'function' ? deps.sleep : wait
  let controller
  let looping = false
  let loopPromise

  /** Store every text message and advance the offset; the standalone fallback. */
  async function defaultHandleBatch({ updates, offset }) {
    const records = (Array.isArray(updates) ? updates : [])
      .map(messageFromUpdate)
      .filter(record => record !== undefined)
    const next = addMessages({ ...deps.getState(), offset, lastError: '' }, records)
    deps.update({ offset: next.offset, messages: next.messages, lastError: '' }, { persist: true })
  }

  /** Hand one batch to the inbox runtime. */
  async function handleBatch(batch) {
    const handler = typeof deps.handleBatch === 'function' ? deps.handleBatch : defaultHandleBatch
    await handler(batch)
  }

  /** One pass of the loop; repeats until aborted or until a 401. */
  async function run(signal) {
    let backoff = FIRST_ERROR_DELAY_MS
    while (!signal.aborted) {
      let token = ''
      try {
        token = await deps.getToken()
      } catch {
        token = ''
      }
      if (signal.aborted) break
      if (token === '') {
        deps.update({ lastError: 'токен не сохранён' })
        await pause(NO_TOKEN_DELAY_MS, signal)
        continue
      }
      const telegram = deps.getTelegram()
      telegram.setToken(token)
      try {
        const current = deps.getState()
        const updates = await telegram.getUpdates(
          { offset: current.offset, timeout: LONG_POLL_SECONDS },
          { signal },
        )
        if (signal.aborted) break
        backoff = FIRST_ERROR_DELAY_MS
        const batch = Array.isArray(updates) ? updates : []
        if (batch.length === 0) {
          if (current.lastError !== '') deps.update({ lastError: '' })
          // A long poll already waited; this only guards against an API that
          // answers instantly without updates.
          await pause(EMPTY_PAUSE_MS, signal)
          continue
        }
        try {
          await handleBatch({ updates: batch, offset: nextOffset(current.offset, batch), signal })
        } catch (error) {
          if (signal.aborted) break
          deps.update({ lastError: `ошибка обработки сообщений: ${redact(error?.message ?? error, token)}` })
          await pause(backoff, signal)
          backoff = nextBackoff(backoff)
        }
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof TelegramError && error.status === 401) {
          deps.update({ enabled: false, lastError: 'токен не принят' }, { persist: true })
          deps.onUnauthorized?.()
          return
        }
        if (error instanceof TelegramError && error.status === 409) {
          // Another consumer (webhook or program) holds the bot: stop and let the
          // caller read the webhook info and explain it.
          if (typeof deps.onConflict === 'function') await deps.onConflict(error)
          return
        }
        deps.update({ lastError: describeTelegramError(error, token) })
        await pause(backoff, signal)
        backoff = nextBackoff(backoff)
      }
    }
  }

  return {
    /** Whether the loop is currently active. */
    get running() {
      return looping
    },
    /** Start the loop; a second call does nothing. */
    start() {
      if (looping) return
      looping = true
      controller = new AbortController()
      loopPromise = run(controller.signal).catch(error => {
        console.error('[dsh-inbox] опрос Telegram остановлен:', error?.message ?? error)
      }).finally(() => {
        looping = false
      })
    },
    /** Stop the loop and wait until it has exited. */
    async stop() {
      if (!looping && loopPromise === undefined) return
      looping = false
      if (controller !== undefined) controller.abort()
      try {
        await loopPromise
      } catch {
        // The loop never rejects: failures are reported through `update`.
      }
      loopPromise = undefined
    },
  }
}
