/**
 * Identity of this DSH installation for the shared command queue.
 *
 * The device id is a stable UUID kept in `~/.dsh/dsh-inbox/device.json`; the
 * name is the host name, used only for display and as a commit-message label.
 * The bot id (the numeric prefix of the token) is derived from the token and is
 * never persisted next to the queue: the token itself must not reach git.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { inboxDir } from './paths.mjs'

/** Path of the local device descriptor. */
export function deviceFile() {
  return join(inboxDir(), 'device.json')
}

/**
 * The numeric bot id: the part of the token before the colon.
 * @param token - bot token, may be ''.
 * @returns digits, or '' when the token does not look like a token.
 */
export function botIdFromToken(token) {
  const match = /^(\d{3,})/.exec(String(token ?? '').trim())
  return match === null ? '' : match[1]
}

/** A safe display name: never empty, bounded, one line. */
function safeName(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  return text === '' ? 'device' : text.slice(0, 64)
}

/**
 * Read or create the local device identity.
 * @returns `{ id, name, createdAt }`.
 */
export async function loadOrCreateDevice() {
  const file = deviceFile()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const id = typeof parsed?.id === 'string' ? parsed.id.trim() : ''
    if (id !== '') {
      return {
        id,
        name: safeName(parsed?.name),
        createdAt: typeof parsed?.createdAt === 'string' ? parsed.createdAt : '',
      }
    }
  } catch {
    // create below
  }
  const device = { id: randomUUID(), name: safeName(hostname()), createdAt: new Date().toISOString() }
  await mkdir(inboxDir(), { recursive: true })
  await writeFile(file, `${JSON.stringify(device, null, 2)}\n`, 'utf8')
  return device
}
