/**
 * Temporary git world for the shared-queue tests: one bare remote and as many
 * queue clones as a test needs. Everything lives under one temporary directory
 * that the caller removes.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitQueue } from '../lib/queue.mjs'

const run = promisify(execFile)

/** Run git in one directory and throw on a non-zero exit. */
export async function git(args, cwd) {
  return await run('git', args, { cwd, windowsHide: true })
}

/**
 * Run a test body with a fresh bare remote and a factory for queue clones.
 * @param body - async callback receiving `{ root, remote, make(device, options) }`.
 * @returns whatever the callback returns.
 */
export async function withQueueWorld(body) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inbox-queue-'))
  const remote = join(root, 'remote.git')
  await git(['init', '--bare', '-q', remote], root)
  const make = (device, options = {}) => createGitQueue({
    dir: join(root, `clone-${device.id}`),
    remoteUrl: remote,
    device: { id: device.id, name: device.name ?? device.id },
    botId: '123456',
    claimWaitMs: 25,
    ...options,
  })
  try {
    return await body({ root, remote, make })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 })
  }
}

/** One Telegram-style command item. */
export function commandItem(updateId, text, extra = {}) {
  return {
    chatId: '555',
    chatTitle: 'Иван',
    updateId,
    text,
    ...extra,
  }
}
