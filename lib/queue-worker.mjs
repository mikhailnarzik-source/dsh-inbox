/**
 * The queue worker: every few seconds it pulls the shared queue, claims one
 * unprocessed command at a time, executes it through the Inbox command surface
 * and records the result plus a `done` marker.
 *
 * The executor is the one place a command runs. Other devices only append to the
 * queue; the first device that wins the claim executes, sends the Telegram reply
 * with its own token and pushes the result. A lost claim is silent; an expired
 * lease lets the next attempt run.
 */

/** Default loop interval, in milliseconds. */
export const WORKER_INTERVAL_MS = 4000

/**
 * Build the worker.
 *
 * @param options - `{ queue, execute, send?, intervalMs?, now?, isListener?, log? }`:
 *   `execute(command)` returns `{ status: 'ok'|'error', output, delivered?,
 *   chatId?, chatTitle?, text? }`; when `delivered` is not true the worker calls
 *   `send(result)` to publish the Telegram reply exactly once;
 *   `isListener()` reports the receive-flag for the device status file.
 * @returns `{ start, stop, runNow, status }`.
 */
export function createQueueWorker(options = {}) {
  const queue = options.queue
  const execute = typeof options.execute === 'function' ? options.execute : async () => ({ status: 'ok', output: '' })
  const send = typeof options.send === 'function' ? options.send : undefined
  const isListener = typeof options.isListener === 'function' ? options.isListener : () => false
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : WORKER_INTERVAL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}

  let timer
  let running = false
  let busy = false
  let lastSyncAt = 0
  let lastError = ''
  let lastResult = undefined
  let ticks = 0
  /** The pass that is currently running, so "sync now" can wait for it. */
  let activePass

  /** One processing pass. */
  async function runNow() {
    if (busy) {
      if (activePass !== undefined) await activePass
      return { ok: true, skipped: true, waited: true }
    }
    busy = true
    ticks += 1
    activePass = (async () => {
      try {
        const pulled = await queue.sync()
        if (!pulled.ok) {
          lastError = pulled.message || 'синхронизация не удалась'
          return { ok: false, skipped: false, message: lastError }
        }
        lastSyncAt = now()
        lastError = ''
        const snapshot = await queue.snapshot()
        const executed = []
        for (const item of snapshot.items) {
          if (item.done || item.result !== undefined) continue
          // A live claim belongs to someone (possibly this device in a previous
          // pass); the lease expiring is what allows the next attempt.
          if (item.winner !== undefined) continue
          const claim = await queue.claimCommand(item.command.commandId)
          if (claim.acquired !== true) continue
          let outcome
          try {
            outcome = await execute(item.command)
          } catch (error) {
            outcome = { status: 'error', output: error instanceof Error ? error.message : String(error) }
          }
          let status = outcome?.status === 'error' ? 'error' : 'ok'
          let output = typeof outcome?.output === 'string' ? outcome.output : ''
          // The executor sends the Telegram reply exactly once, unless the
          // executor already answered (a callback needs its own answer/edit).
          if (outcome?.delivered !== true && send !== undefined) {
            try {
              await send(outcome)
            } catch (error) {
              status = 'error'
              output = `${output}${output === '' ? '' : '\n'}не удалось ответить в Telegram: ${error instanceof Error ? error.message : String(error)}`
            }
          }
          await queue.finishCommand(item.command.commandId, {
            status,
            output,
            attempt: claim.claim?.attempt,
          })
          executed.push({ commandId: item.command.commandId, status })
        }
        lastResult = { ok: true, executed, at: now() }
        await queue.updateStatus({
          listener: isListener(),
          lastSyncAt,
          lastError: '',
        }).catch(() => undefined)
        return lastResult
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        log(`[dsh-inbox] очередь: ${lastError}`)
        return { ok: false, skipped: false, message: lastError }
      } finally {
        busy = false
        activePass = undefined
      }
    })()
    return activePass
  }

  /** Status for the plugin page and the tool. */
  function status() {
    return {
      running,
      busy,
      ticks,
      lastSyncAt,
      lastError,
      intervalMs,
      lastResult,
    }
  }

  return {
    /** Run one pass immediately (also used by the "sync now" button). */
    runNow,
    /** Start the periodic loop. */
    start() {
      if (running) return
      running = true
      void runNow()
      timer = setInterval(() => {
        void runNow()
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    /** Stop the loop; a pass in flight finishes. */
    stop() {
      running = false
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
    status,
  }
}
