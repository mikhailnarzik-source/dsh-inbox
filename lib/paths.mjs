/**
 * Where the plugin keeps its own data.
 *
 * `~/.dsh/dsh-inbox/state.json` by default; `DSH_INBOX_DIR` overrides the
 * directory (tests use a temporary one, a portable install may too). The path is
 * resolved on every call, so an environment change applies without reloading.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory holding the history and the polling offset. */
export function inboxDir() {
  const override = process.env.DSH_INBOX_DIR
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh', 'dsh-inbox')
}

/** Absolute path of the state file. */
export function stateFile() {
  return join(inboxDir(), 'state.json')
}
