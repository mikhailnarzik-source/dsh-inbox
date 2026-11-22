/**
 * The shared command queue: a dedicated `inbox` branch in the same git remote
 * that `dsh-sync` uses.
 *
 * Every command is an immutable JSON file, so two devices may append
 * concurrently and a merge never rewrites history. Delivery is coordinated with
 * claim files: a device writes its claim, pushes, waits, pulls, and the smallest
 * `(attempt, claimedAt, deviceId)` wins. The winner executes once and writes a
 * result plus a `done` marker; losers keep their claim as history.
 *
 * The token never enters this repository: command records carry only chat ids
 * and text, while replies are sent by the executing device with its own token.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { inboxDir } from './paths.mjs'

/** Branch of the queue in the shared remote. */
export const QUEUE_BRANCH = 'inbox'

/** How long one claim keeps other devices away, in milliseconds. */
export const CLAIM_TTL_MS = 120_000

/** How many attempts one device may make on one command. */
export const MAX_ATTEMPTS = 3

/** How long a device waits after pushing a claim before deciding the winner. */
export const CLAIM_WAIT_MS = 3000

/** Directory name of the queue clone inside the inbox directory. */
export const QUEUE_DIR_NAME = 'queue'

/** A queue failure with a human-readable message. */
export class QueueError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'QueueError'
    this.code = options.code ?? 'queue'
  }
}

/** Absolute directory of the local clone; `DSH_INBOX_QUEUE_DIR` overrides it. */
export function queueDir() {
  const override = process.env.DSH_INBOX_QUEUE_DIR
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(inboxDir(), QUEUE_DIR_NAME)
}

/**
 * Remote URL configured by `dsh-sync` (`~/.dsh/dsh-sync.json`). Only the URL and
 * the queue branch are used; dsh-sync's own `main` mirror is never touched.
 * `DSH_INBOX_QUEUE_REMOTE` overrides it (tests, a manual setup).
 * @returns the URL, or '' when no git remote is configured.
 */
export async function resolveSyncRemote() {
  const override = process.env.DSH_INBOX_QUEUE_REMOTE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const configPath = process.env.DSH_INBOX_SYNC_CONFIG
    || join(homedir(), '.dsh', 'dsh-sync.json')
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const remote = typeof config?.remote === 'string' ? config.remote.trim() : ''
    return remote
  } catch {
    return ''
  }
}

/** One-safe path segment for ids that appear in file names. */
export function safeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'item'
}

/**
 * Deterministic command identity: a Telegram update is the source of truth, so
 * the same update always maps to the same file and the second enqueue is a
 * no-op.
 * @param botId - numeric bot id (avoids collisions between bots).
 * @param updateId - Telegram update id.
 * @returns the command id.
 */
export function commandIdFor(botId, updateId) {
  const bot = /^\d+$/.test(String(botId ?? '')) ? String(botId) : 'bot'
  const update = /^\d+$/.test(String(updateId ?? '')) ? String(updateId) : ''
  return update === '' ? `${bot}-${Date.now()}` : `${bot}-${update}`
}

/**
 * Pick the claim that owns the command.
 * @param claims - claim records.
 * @returns the winner, or `undefined`.
 */
export function pickClaimWinner(claims) {
  const list = Array.isArray(claims) ? claims.filter(claim => claim !== null && typeof claim === 'object') : []
  if (list.length === 0) return undefined
  return [...list].sort((left, right) => {
    const attempt = Number(left.attempt) - Number(right.attempt)
    if (attempt !== 0) return attempt
    const claimed = Number(left.claimedAt) - Number(right.claimedAt)
    if (claimed !== 0) return claimed
    return String(left.deviceId ?? '').localeCompare(String(right.deviceId ?? ''))
  })[0]
}

/**
 * Whether a claim still holds its lease.
 * @param claim - claim record.
 * @param now - current epoch milliseconds.
 * @param ttlMs - lease duration.
 * @returns true while the claim is alive.
 */
export function isClaimLive(claim, now, ttlMs = CLAIM_TTL_MS) {
  if (claim === null || typeof claim !== 'object') return false
  const claimedAt = Number(claim.claimedAt)
  if (!Number.isFinite(claimedAt)) return false
  return now - claimedAt < ttlMs
}

/** Run git and capture the result without throwing for exit codes. */
function runGit(args, cwd, timeoutMs = 60_000) {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        message: error === null ? '' : String(stderr ?? '').trim() || String(error.message ?? ''),
      })
    })
  })
}

/** Read one JSON file, returning `undefined` for a missing or broken file. */
async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** List one directory, returning `[]` when it is absent. */
async function readDirSafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Read every `.json` file of one directory. */
async function readJsonDir(directory) {
  const entries = await readDirSafe(directory)
  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const record = await readJsonFile(join(directory, entry.name))
    if (record !== undefined && record !== null && typeof record === 'object') records.push(record)
  }
  return records
}

/** Overwrite one file atomically. */
async function writeFileAtomic(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, file)
}

/**
 * Build the git-backed queue.
 *
 * @param options - `{ dir?, remoteUrl?, branch?, device, botId?, claimWaitMs?,
 *   ttlMs?, maxAttempts?, now?, sleep?, git? }`. `device` is
 *   `{ id, name }`; the rest is injectable for tests.
 * @returns the queue API.
 */
export function createGitQueue(options = {}) {
  const settings = {
    dir: typeof options.dir === 'string' && options.dir !== '' ? options.dir : queueDir(),
    remoteUrl: typeof options.remoteUrl === 'string' ? options.remoteUrl : '',
    branch: typeof options.branch === 'string' && options.branch !== '' ? options.branch : QUEUE_BRANCH,
    device: {
      id: safeId(options.device?.id ?? 'device'),
      name: String(options.device?.name ?? 'device').slice(0, 64),
    },
    botId: typeof options.botId === 'string' ? options.botId : '',
    getBotId: typeof options.getBotId === 'function' ? options.getBotId : undefined,
    claimWaitMs: Number.isFinite(options.claimWaitMs)
      ? options.claimWaitMs
      : (Number.isFinite(Number(process.env.DSH_INBOX_QUEUE_CLAIM_WAIT_MS)) && process.env.DSH_INBOX_QUEUE_CLAIM_WAIT_MS !== ''
          ? Number(process.env.DSH_INBOX_QUEUE_CLAIM_WAIT_MS)
          : CLAIM_WAIT_MS),
    ttlMs: Number.isFinite(options.ttlMs) ? options.ttlMs : CLAIM_TTL_MS,
    maxAttempts: Number.isFinite(options.maxAttempts) ? options.maxAttempts : MAX_ATTEMPTS,
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
    sleep: typeof options.sleep === 'function' ? options.sleep : ms => new Promise(resolve => setTimeout(resolve, ms)),
    git: typeof options.git === 'function' ? options.git : runGit,
  }

  /** Serialises every filesystem/git operation of this queue instance. */
  let chain = Promise.resolve()
  const serial = work => {
    const run = chain.then(work, work)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Whether the clone already has the local git identity configured. */
  let identityConfigured = false

  /** Whether the last status push reached the remote. */
  let statusPushOk = false

  /** Current numeric bot id; derived from the token lazily so a token change is seen. */
  const resolveBotId = () => {
    if (settings.getBotId !== undefined) {
      const value = settings.getBotId()
      return typeof value === 'string' ? value : ''
    }
    return settings.botId
  }

  /** Absolute path inside the clone. */
  const repoPath = (...parts) => join(settings.dir, ...parts)
  /** Absolute path inside the `inbox` tree. */
  const inboxPath = (...parts) => join(settings.dir, 'inbox', ...parts)
  /** Path for one command file. */
  const commandFile = commandId => inboxPath('commands', `${safeId(commandId)}.json`)

  /** Run one git command and throw a readable error on failure. */
  async function gitOrThrow(args, timeoutMs) {
    const result = await settings.git(args, settings.dir, timeoutMs)
    if (!result.ok) throw new QueueError(`git ${args[0]}: ${result.message || 'ошибка'}`, { code: 'git' })
    return result
  }

  /** Create the clone or repair its remote, on demand. */
  async function ensureClone() {
    if (settings.remoteUrl === '') {
      throw new QueueError('Не задан git-remote синхронизации: заполните ~/.dsh/dsh-sync.json (поле remote).', { code: 'no-remote' })
    }
    await mkdir(settings.dir, { recursive: true })
    if (!existsSync(repoPath('.git'))) {
      await gitOrThrow(['init', '-q'])
      await gitOrThrow(['remote', 'add', 'origin', settings.remoteUrl])
    } else {
      const current = await settings.git(['remote', 'get-url', 'origin'], settings.dir)
      if (!current.ok) await gitOrThrow(['remote', 'add', 'origin', settings.remoteUrl])
      else if (current.stdout.trim() !== settings.remoteUrl) await gitOrThrow(['remote', 'set-url', 'origin', settings.remoteUrl])
    }
    if (!identityConfigured) {
      await settings.git(['config', 'user.name', 'dsh-inbox'], settings.dir)
      await settings.git(['config', 'user.email', 'dsh-inbox@local'], settings.dir)
      identityConfigured = true
    }
    return true
  }

  /** Pull the queue branch into the clone; `reset --hard` is safe for this clone. */
  async function sync() {
    return serial(async () => {
      try {
        await ensureClone()
      } catch (error) {
        return { ok: false, message: error.message }
      }
      const fetch = await settings.git([
        'fetch', '-q', 'origin', `+refs/heads/${settings.branch}:refs/remotes/origin/${settings.branch}`,
      ], settings.dir)
      if (!fetch.ok) {
        // No branch yet is a normal first start; any other failure is reported.
        const heads = await settings.git(['ls-remote', '--heads', 'origin'], settings.dir, 60_000)
        if (heads.ok && !heads.stdout.includes(`refs/heads/${settings.branch}`)) return { ok: true, empty: true }
        return { ok: false, message: fetch.message || 'git fetch не удался' }
      }
      const reset = await settings.git(['reset', '--hard', `origin/${settings.branch}`], settings.dir)
      if (!reset.ok) return { ok: false, message: reset.message || 'git reset не удался' }
      return { ok: true, empty: false }
    })
  }

  /** Commit and push the working tree; integrates remote changes on a rejected push. */
  async function pushInternal(message) {
    try {
      await ensureClone()
    } catch (error) {
      return { ok: false, message: error.message }
    }
    await gitOrThrow(['add', '-A'])
    const clean = await settings.git(['diff', '--cached', '--quiet'], settings.dir)
    if (clean.ok) return { ok: true, pushed: false, committed: false }
    const commitMessage = message || `queue: ${settings.device.name} ${settings.now()}`
    await gitOrThrow(['commit', '-q', '-m', commitMessage])
    let lastMessage = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pushed = await settings.git(['push', '-q', 'origin', `HEAD:${settings.branch}`], settings.dir)
      if (pushed.ok) return { ok: true, pushed: true, committed: true }
      lastMessage = pushed.message || 'git push отклонён'
      const fetched = await settings.git([
        'fetch', '-q', 'origin', `+refs/heads/${settings.branch}:refs/remotes/origin/${settings.branch}`,
      ], settings.dir)
      if (!fetched.ok) break
      const merge = await settings.git(['merge', '--no-edit', '-X', 'ours', `origin/${settings.branch}`], settings.dir)
      if (merge.ok) continue
      await settings.git(['merge', '--abort'], settings.dir)
      const rebase = await settings.git(['rebase', `origin/${settings.branch}`], settings.dir)
      if (!rebase.ok) {
        await settings.git(['rebase', '--abort'], settings.dir)
        break
      }
    }
    return { ok: false, message: lastMessage }
  }

  /** Serialised public push. */
  async function push(message) {
    return serial(() => pushInternal(message))
  }

  /** Create an immutable file; `{ created: false }` when it already exists. */
  async function writeImmutable(parts, value) {
    const file = repoPath(...parts)
    await mkdir(dirname(file), { recursive: true })
    let handle
    try {
      handle = await open(file, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') return { created: false, file }
      throw error
    }
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return { created: true, file }
  }

  /** Normalise one update into a command record. */
  function buildCommand(item) {
    const botId = resolveBotId()
    const commandId = item.commandId || commandIdFor(botId, item.updateId)
    const callback = item.callback !== null && typeof item.callback === 'object'
      ? {
          callbackId: String(item.callback.callbackId ?? ''),
          data: String(item.callback.data ?? ''),
          messageId: Number.isFinite(item.callback.messageId) ? item.callback.messageId : undefined,
        }
      : undefined
    return {
      kind: 'command',
      commandId,
      botId,
      chatId: String(item.chatId ?? ''),
      chatTitle: String(item.chatTitle ?? ''),
      updateId: Number.isFinite(item.updateId) ? item.updateId : undefined,
      text: typeof item.text === 'string' ? item.text : '',
      ...(typeof item.fromId === 'string' && item.fromId !== '' ? { fromId: item.fromId } : {}),
      ...(typeof item.chatType === 'string' && item.chatType !== '' ? { chatType: item.chatType } : {}),
      ...(typeof item.fromName === 'string' && item.fromName !== '' ? { fromName: item.fromName } : {}),
      ...(callback === undefined ? {} : { callback }),
      enqueuedAt: new Date(settings.now()).toISOString(),
      deviceId: settings.device.id,
      deviceName: settings.device.name,
    }
  }

  /** Read the immutable claims of one command. */
  async function claimsFor(commandId) {
    return readJsonDir(inboxPath('claims', safeId(commandId)))
  }

  /** Read the results of one command. */
  async function resultsFor(commandId) {
    return readJsonDir(inboxPath('results', safeId(commandId)))
  }

  /** Whether the command is finished. */
  async function isDone(commandId) {
    return (await readJsonFile(inboxPath('done', `${safeId(commandId)}.json`))) !== undefined
  }

  /**
   * Enqueue one command and push it.
   * @param item - `{ chatId, chatTitle, updateId, text, callback? }`.
   * @returns `{ ok, created, commandId, message? }`.
   */
  async function enqueueCommand(item) {
    const result = await commitBatch({ commands: [item] })
    const first = result.commands[0]
    return { ...result, created: first?.created === true, commandId: first?.commandId }
  }

  /**
   * Write a batch of commands and the device offset, then push once.
   * @param batch - `{ commands?, offset? }`; the offset is written only when the
   *   push succeeded, so a failed batch is retried from the same offset.
   * @returns `{ ok, commands, message? }`.
   */
  async function commitBatch(batch = {}) {
    return serial(async () => {
      try {
        await ensureClone()
      } catch (error) {
        return { ok: false, commands: [], message: error.message }
      }
      const pulled = await pullUnsafe()
      if (!pulled.ok) return { ok: false, commands: [], message: pulled.message }
      const written = []
      for (const item of Array.isArray(batch.commands) ? batch.commands : []) {
        try {
          const command = buildCommand(item)
          const result = await writeImmutable(['inbox', 'commands', `${safeId(command.commandId)}.json`], command)
          written.push({ created: result.created, commandId: command.commandId, command })
        } catch (error) {
          written.push({ created: false, commandId: '', error: error.message })
        }
      }
      if (Number.isFinite(batch.offset) && batch.offset >= 0) {
        await writeFileAtomic(inboxPath('offset', `${settings.device.id}.json`), `${JSON.stringify({
          deviceId: settings.device.id,
          deviceName: settings.device.name,
          offset: Math.floor(batch.offset),
          updatedAt: new Date(settings.now()).toISOString(),
        }, null, 2)}\n`)
      }
      const pushed = await pushInternal(`queue: ${settings.device.name} batch`)
      if (!pushed.ok) return { ok: false, commands: written, message: pushed.message }
      return { ok: true, commands: written }
    })
  }

  /** Pull without taking the serial lock: used from inside a locked operation. */
  async function pullUnsafe() {
    await ensureClone()
    const fetch = await settings.git([
      'fetch', '-q', 'origin', `+refs/heads/${settings.branch}:refs/remotes/origin/${settings.branch}`,
    ], settings.dir)
    if (!fetch.ok) {
      const heads = await settings.git(['ls-remote', '--heads', 'origin'], settings.dir)
      if (heads.ok && !heads.stdout.includes(`refs/heads/${settings.branch}`)) return { ok: true, empty: true }
      return { ok: false, message: fetch.message || 'git fetch не удался' }
    }
    const reset = await settings.git(['reset', '--hard', `origin/${settings.branch}`], settings.dir)
    if (!reset.ok) return { ok: false, message: reset.message || 'git reset не удался' }
    return { ok: true, empty: false }
  }

  /**
   * Try to claim one command: write an immutable claim, push, wait, pull, then
   * elect the winner. Only the winner executes.
   * @param commandId - command to claim.
   * @param options - `{ claimWaitMs? }` override for the single-device fast path.
   * @returns `{ acquired, reason, claim?, winner? }`.
   */
  async function claimCommand(commandId, options = {}) {
    const waitMs = Number.isFinite(options.claimWaitMs) ? options.claimWaitMs : settings.claimWaitMs
    return serial(async () => {
      try {
        await ensureClone()
      } catch (error) {
        return { acquired: false, reason: 'no-remote', message: error.message }
      }
      const pulled = await pullUnsafe()
      if (!pulled.ok) return { acquired: false, reason: 'sync', message: pulled.message }
      if (await isDone(commandId)) return { acquired: false, reason: 'done' }
      if ((await resultsFor(commandId)).length > 0) return { acquired: false, reason: 'result' }
      const existing = await claimsFor(commandId)
      const now = settings.now()
      const live = existing.filter(claim => isClaimLive(claim, now, settings.ttlMs))
      const winnerBefore = pickClaimWinner(live)
      if (winnerBefore !== undefined) {
        if (winnerBefore.deviceId === settings.device.id) return { acquired: false, reason: 'running', winner: winnerBefore }
        return { acquired: false, reason: 'claimed', winner: winnerBefore }
      }
      const own = existing.filter(claim => claim.deviceId === settings.device.id)
      const attempt = own.length + 1
      if (attempt > settings.maxAttempts) return { acquired: false, reason: 'attempts' }
      const claim = {
        commandId,
        deviceId: settings.device.id,
        deviceName: settings.device.name,
        attempt,
        claimedAt: now,
        leaseUntil: now + settings.ttlMs,
      }
      const written = await writeImmutable(
        ['inbox', 'claims', safeId(commandId), `${settings.device.id}-a${attempt}-${now}.json`],
        claim,
      )
      if (!written.created) return { acquired: false, reason: 'claim-exists' }
      const pushed = await pushInternal(`queue: ${settings.device.name} claim ${commandId}`)
      if (!pushed.ok) return { acquired: false, reason: 'push', message: pushed.message }
      await settings.sleep(waitMs)
      const after = await pullUnsafe()
      if (!after.ok) return { acquired: false, reason: 'sync', message: after.message }
      const finalClaims = (await claimsFor(commandId)).filter(item => isClaimLive(item, settings.now(), settings.ttlMs))
      const winner = pickClaimWinner(finalClaims)
      const owned = winner !== undefined && winner.deviceId === settings.device.id && Number(winner.attempt) === attempt
      if (!owned) return { acquired: false, reason: 'lost', winner }
      // A second quiet period closes the race where a competitor's push was
      // still in flight during the first pull: confirming the win against the
      // latest remote state is what keeps a single executor.
      await settings.sleep(waitMs)
      const confirmedPull = await pullUnsafe()
      if (!confirmedPull.ok) return { acquired: false, reason: 'sync', message: confirmedPull.message }
      const confirmedClaims = (await claimsFor(commandId)).filter(item => isClaimLive(item, settings.now(), settings.ttlMs))
      const confirmed = pickClaimWinner(confirmedClaims)
      if (
        confirmed !== undefined
        && confirmed.deviceId === settings.device.id
        && Number(confirmed.attempt) === attempt
      ) {
        return { acquired: true, claim, winner: confirmed }
      }
      return { acquired: false, reason: 'lost', winner: confirmed }
    })
  }

  /**
   * Record the result and the `done` marker, then push once.
   * @param commandId - finished command.
   * @param outcome - `{ status: 'ok'|'error', output, attempt? }`.
   * @returns `{ ok, pushed, message?, resultWritten }`.
   */
  async function finishCommand(commandId, outcome = {}) {
    return serial(async () => {
      try {
        await ensureClone()
      } catch (error) {
        return { ok: false, message: error.message }
      }
      const pulled = await pullUnsafe()
      if (!pulled.ok) return { ok: false, message: pulled.message }
      if (await isDone(commandId)) return { ok: true, pushed: false, alreadyDone: true, resultWritten: false }
      const now = settings.now()
      const result = {
        commandId,
        deviceId: settings.device.id,
        deviceName: settings.device.name,
        status: outcome.status === 'error' ? 'error' : 'ok',
        output: String(outcome.output ?? '').slice(0, 3900),
        attempt: Number.isFinite(outcome.attempt) ? outcome.attempt : undefined,
        executedAt: new Date(now).toISOString(),
      }
      const writtenResult = await writeImmutable(
        ['inbox', 'results', safeId(commandId), `${settings.device.id}-${now}.json`],
        result,
      )
      await writeImmutable(['inbox', 'done', `${safeId(commandId)}.json`], {
        commandId,
        deviceId: settings.device.id,
        deviceName: settings.device.name,
        completedAt: new Date(now).toISOString(),
        status: result.status,
      })
      const pushed = await pushInternal(`queue: ${settings.device.name} done ${commandId}`)
      return { ok: pushed.ok, pushed: pushed.ok, resultWritten: writtenResult.created, message: pushed.message }
    })
  }

  /**
   * Read the local clone and return every command with its claims, result and
   * done state. No network.
   * @returns `{ ok, items, counts }`.
   */
  async function snapshot() {
    const now = settings.now()
    const commands = await readJsonDir(inboxPath('commands'))
    const doneRecords = await readJsonDir(inboxPath('done'))
    const doneIds = new Set(doneRecords.map(record => String(record.commandId ?? '')))
    const items = []
    for (const command of commands) {
      const commandId = String(command.commandId ?? '')
      if (commandId === '') continue
      const claims = await claimsFor(commandId)
      const live = claims.filter(claim => isClaimLive(claim, now, settings.ttlMs))
      const results = await resultsFor(commandId)
      items.push({
        command,
        claims,
        liveClaims: live,
        winner: pickClaimWinner(live),
        result: results[0],
        done: doneIds.has(commandId),
      })
    }
    items.sort((left, right) => String(left.command.enqueuedAt ?? '').localeCompare(String(right.command.enqueuedAt ?? '')))
    return { ok: true, items, counts: countItems(items) }
  }

  /** Counters for the plugin page. */
  function countItems(items) {
    let fresh = 0
    let running = 0
    let finished = 0
    for (const item of items) {
      if (item.done || item.result !== undefined) finished += 1
      else if (item.winner !== undefined) running += 1
      else fresh += 1
    }
    return { total: items.length, new: fresh, inProgress: running, done: finished }
  }

  /** Device status files of every device that published one. */
  async function statuses() {
    return (await readJsonDir(inboxPath('status'))).sort((left, right) =>
      String(left.deviceName ?? '').localeCompare(String(right.deviceName ?? '')))
  }

  /**
   * Publish this device's status file (only the owner writes it) and push.
   * @param patch - `{ listener, lastSyncAt, lastError, version }`.
   * @returns `{ ok, pushed }`.
   */
  async function updateStatus(patch = {}) {
    const minute = Math.floor(settings.now() / 60_000) * 60_000
    const exactSync = Number.isFinite(patch.lastSyncAt) ? patch.lastSyncAt : minute
    const record = {
      deviceId: settings.device.id,
      deviceName: settings.device.name,
      botId: resolveBotId(),
      listener: patch.listener === true,
      // Minute precision keeps the status file from committing on every tick.
      lastSyncAt: Math.floor(exactSync / 60_000) * 60_000,
      lastError: typeof patch.lastError === 'string' ? patch.lastError.slice(0, 500) : '',
      version: String(patch.version ?? ''),
      updatedAt: new Date(minute).toISOString(),
    }
    const file = inboxPath('status', `${settings.device.id}.json`)
    let previous = ''
    try {
      previous = await readFile(file, 'utf8')
    } catch {
      previous = ''
    }
    const next = `${JSON.stringify(record, null, 2)}\n`
    if (next === previous && statusPushOk) return { ok: true, pushed: false, unchanged: true }
    if (next !== previous) await writeFileAtomic(file, next)
    const pushed = await push(`queue: ${settings.device.name} status`)
    statusPushOk = pushed.ok
    return { ok: pushed.ok, pushed: pushed.ok, message: pushed.message }
  }

  /** Read this device's saved Telegram offset. */
  async function readOffset() {
    const record = await readJsonFile(inboxPath('offset', `${settings.device.id}.json`))
    return Number.isFinite(record?.offset) ? Math.floor(record.offset) : undefined
  }

  return {
    device: settings.device,
    branch: settings.branch,
    dir: settings.dir,
    configured: () => settings.remoteUrl !== '',
    remoteUrl: settings.remoteUrl,
    ensureClone,
    sync,
    pull: pullUnsafe,
    push,
    enqueueCommand,
    commitBatch,
    claimCommand,
    finishCommand,
    snapshot,
    counts: countItems,
    statuses,
    updateStatus,
    readOffset,
    claimsFor,
    resultsFor,
    isDone,
  }
}
