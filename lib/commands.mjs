/**
 * Bot commands.
 *
 * Every allowed incoming message is either a command or plain text that means
 * `/ask`. The parser is pure; the executor talks to DSH only through the
 * injected session gateway, so the whole surface is testable with a mock
 * `sessionController`. Results are `{ summary, details? }`: the polling loop
 * wraps them into the Telegram acknowledgement.
 */

import {
  MENU_TEXTS,
  REPLIES,
  formatSessionLine,
  helpText,
  lastMessagesText,
  sessionLabel,
  statusText,
} from './replies.mjs'
import {
  helpInlineKeyboard,
  sessionsInlineKeyboard,
  statusInlineKeyboard,
} from './menu.mjs'

/** Commands the bot understands; anything else gets a hint. */
export const COMMANDS = ['help', 'status', 'sessions', 'use', 'ask', 'steer', 'new', 'cancel', 'last', 'menu', 'start']

/**
 * Split one incoming message into a command and its text.
 * @param value - message text.
 * @returns `{ command, args, explicit }`; plain text becomes `ask`.
 */
export function parseIncoming(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || !text.startsWith('/')) {
    return { command: 'ask', args: text, explicit: false }
  }
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null) return { command: 'unknown', args: text, explicit: true }
  const name = match[1].toLowerCase()
  const args = (match[2] ?? '').trim()
  if (!COMMANDS.includes(name)) return { command: 'unknown', args: name, explicit: true }
  return { command: name, args, explicit: true }
}

/** The session selected for the chat, or one readable error. */
function currentSessionId(state, chatId) {
  const id = state?.currentChatSession?.[chatId]
  if (typeof id !== 'string' || id === '') throw new Error(REPLIES.sessionNotChosen)
  return id
}

/** The title of a session, with a silent fallback to the id. */
async function titleOf(deps, sessionId) {
  try {
    return await deps.sessions.titleFor(sessionId)
  } catch {
    return ''
  }
}

/** `/sessions`: remember the numbered list, answer with titles. */
async function commandSessions({ chatId, deps }) {
  const rows = await deps.sessions.list({ limit: deps.maxSessions ?? 10 })
  if (rows.length === 0) return { summary: 'сессий нет', details: REPLIES.emptySessions }
  const state = deps.getState()
  await deps.save({
    pendingLists: {
      ...state.pendingLists,
      [chatId]: rows.map(row => row.sessionId),
    },
  })
  const lines = rows.map((row, index) =>
    formatSessionLine(index + 1, row.title === '' ? row.sessionId.slice(0, 8) : row.title, row.running),
  )
  return {
    summary: `сессий: ${rows.length}`,
    details: `${lines.join('\n')}\n\nВыберите сессию кнопкой ниже или командой /use N.`,
    inlineKeyboard: sessionsInlineKeyboard(rows),
  }
}

/** `/use N`: bind the chat to one session from the last list. */
async function commandUse({ chatId, args, deps }) {
  const state = deps.getState()
  const list = state.pendingLists?.[chatId]
  if (!Array.isArray(list) || list.length === 0) throw new Error(REPLIES.useNeedsList)
  if (!/^\d{1,3}$/.test(args)) throw new Error(REPLIES.useIndexRange(list.length))
  const number = Number(args)
  if (number < 1 || number > list.length) throw new Error(REPLIES.useIndexRange(list.length))
  const sessionId = list[number - 1]
  await deps.save({
    currentChatSession: { ...state.currentChatSession, [chatId]: sessionId },
  })
  const title = await titleOf(deps, sessionId)
  return { summary: `текущая сессия: ${sessionLabel(title, sessionId)}` }
}

/** `/ask` and `/steer`: feed text to the current session. */
async function commandPrompt({ chatId, args, mode, command, deps }) {
  const text = args.trim()
  if (text === '') throw new Error(REPLIES.textRequired(command))
  const sessionId = currentSessionId(deps.getState(), chatId)
  await deps.sessions.prompt({ sessionId, mode, text })
  const title = await titleOf(deps, sessionId)
  return {
    summary: mode === 'steer'
      ? `сообщение вклинино в текущий ход сессии ${sessionLabel(title, sessionId)}`
      : `сообщение поставлено в очередь сессии ${sessionLabel(title, sessionId)}`,
  }
}

/** `/new`: create a session, route the chat to it, send the text. */
async function commandNew({ chatId, args, deps }) {
  const text = args.trim()
  if (text === '') throw new Error(REPLIES.textRequired('new'))
  const created = await deps.sessions.create({})
  await deps.sessions.prompt({ sessionId: created.sessionId, mode: 'queue', text })
  const state = deps.getState()
  await deps.save({
    currentChatSession: { ...state.currentChatSession, [chatId]: created.sessionId },
  })
  return {
    summary: `создана сессия ${sessionLabel('', created.sessionId)}, сообщение поставлено в очередь`,
  }
}

/** `/cancel`: cancel the active turn of the current session. */
async function commandCancel({ chatId, deps }) {
  const sessionId = currentSessionId(deps.getState(), chatId)
  await deps.sessions.cancel(sessionId)
  const title = await titleOf(deps, sessionId)
  return { summary: `отмена запрошена для сессии ${sessionLabel(title, sessionId)}` }
}

/** `/status`: bot, allow-list and current session in one answer. */
async function commandStatus({ chatId, deps }) {
  const state = deps.getState()
  const info = typeof deps.statusInfo === 'function' ? deps.statusInfo() : {}
  const sessionId = state.currentChatSession?.[chatId] ?? ''
  let current = null
  if (sessionId !== '') {
    let described
    try {
      described = await deps.sessions.describe(sessionId)
    } catch {
      described = null
    }
    current = {
      sessionId,
      title: described?.title ?? '',
      running: described?.running === true,
    }
  }
  return {
    summary: 'состояние бота',
    details: statusText({
      polling: info.polling === true,
      lastError: typeof info.lastError === 'string' ? info.lastError : '',
      totalMessages: state.messages.length,
      allowedCount: state.allowedChatIds.length,
      current,
      sessionsAvailable: deps.sessions.available(),
    }),
    inlineKeyboard: statusInlineKeyboard(sessionId),
  }
}

/**
 * `/menu` and `/start`: the greeting with the persistent keyboard.
 * @returns the acknowledgement payload with the reply-keyboard flag.
 */
function commandMenu() {
  return {
    summary: 'меню открыто',
    details: MENU_TEXTS.greeting,
    replyKeyboard: true,
  }
}

/** `/help`: the command cheat sheet. */
function commandHelp() {
  return {
    summary: 'справка по командам',
    details: helpText(),
    inlineKeyboard: helpInlineKeyboard(),
  }
}

/** `/last`: the tail of the Inbox history. */
function commandLast({ deps }) {
  return lastMessagesText(deps.getState().messages, 5)
}

/**
 * Execute one parsed command.
 * @param request - `{ command, args, chatId, deps }`; `deps` carries
 *   `getState`, `save`, `sessions`, `statusInfo`, `maxSessions`.
 * @returns `{ summary, details? }` for the acknowledgement.
 * @throws Error with a Russian message when the command cannot be done.
 */
export async function executeCommand({ command, args, chatId, deps }) {
  switch (command) {
    case 'help':
      return commandHelp()
    case 'menu':
    case 'start':
      return commandMenu()
    case 'status':
      return commandStatus({ chatId, deps })
    case 'sessions':
      return commandSessions({ chatId, deps })
    case 'use':
      return commandUse({ chatId, args, deps })
    case 'ask':
      return commandPrompt({ chatId, args, mode: 'queue', command: 'ask', deps })
    case 'steer':
      return commandPrompt({ chatId, args, mode: 'steer', command: 'steer', deps })
    case 'new':
      return commandNew({ chatId, args, deps })
    case 'cancel':
      return commandCancel({ chatId, deps })
    case 'last':
      return commandLast({ deps })
    default:
      throw new Error(REPLIES.unknownCommand(typeof args === 'string' && args !== '' ? args : command))
  }
}
