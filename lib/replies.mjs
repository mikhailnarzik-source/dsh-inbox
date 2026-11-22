/**
 * The Russian dictionary of host-side replies.
 *
 * Every message the bot publishes for itself — acknowledgements, the access
 * denial, command output — is built here, so the wording lives in one place and
 * the Telegram surface stays consistent. Telegram caps one message at 4096
 * characters; long command output is shortened instead of failing.
 */

import { MAX_MESSAGES } from './storage.mjs'

/** Telegram's message length limit. */
const MAX_TEXT = 4096

/** Marker used for messages from chats outside the allow-list. */
export const BLOCKED_MARK = '⛔ нет доступа'

/** Fixed replies. */
export const REPLIES = {
  accepted: '✅ Принято',
  failed: '⚠️ Не выполнено',
  denied: '⛔ Нет доступа. Попросите владельца DSH добавить этот чат в белый список.',
  noTitle: 'Без названия',
  running: 'выполняется',
  idle: 'ожидает',
  unknownCommand: command => `Неизвестная команда «/${command}». Отправьте /help.`,
  textRequired: command => `Укажите текст: /${command} <текст>.`,
  sessionNotChosen: 'Сессия не выбрана. Отправьте /sessions, затем /use N.',
  useNeedsList: 'Список сессий ещё не загружен. Отправьте /sessions, затем /use N.',
  useIndexRange: max => `Номер должен быть от 1 до ${max}.`,
  sessionsUnavailable: error => `Управление сессиями DSH недоступно: ${error}`,
  emptySessions: 'Сессий DSH пока нет. Отправьте /new <текст>, чтобы создать первую.',
  nothingToCancel: 'Нечего отменять: сессия не выбрана.',
  lastEmpty: 'История «Входящих» пуста.',
}

/**
 * Build the acknowledgement for one processed Telegram message.
 * @param ok - whether the command succeeded.
 * @param summary - one short line about what was done or what failed.
 * @param details - optional command output.
 * @returns the message text, at most 4096 characters.
 */
export function formatAck(ok, summary, details) {
  const head = `${ok ? REPLIES.accepted : REPLIES.failed}: ${summary}`
  const full = typeof details === 'string' && details !== '' ? `${head}\n\n${details}` : head
  if (full.length <= MAX_TEXT) return full
  return `${full.slice(0, MAX_TEXT - 20)}\n… (обрезано)`
}

/**
 * One session line: number, title, state.
 * @param index - 1-based position the user passes to `/use`.
 * @param title - session title.
 * @param running - whether the session is running now.
 * @returns one line.
 */
export function formatSessionLine(index, title, running) {
  return `${index}) ${title} — ${running ? REPLIES.running : REPLIES.idle}`
}

/**
 * Short human label of a session for summaries.
 * @param title - known title, may be empty.
 * @param sessionId - session identity.
 * @returns `«title» (abc12345)` or `abc12345`.
 */
export function sessionLabel(title, sessionId) {
  const id = String(sessionId ?? '')
  const short = id.length > 8 ? `${id.slice(0, 8)}…` : id
  const name = typeof title === 'string' ? title.trim() : ''
  return name === '' ? short : `«${name}» (${short})`
}

/**
 * The `/help` body.
 * @returns a multi-line cheat sheet.
 */
export function helpText() {
  return [
    'Команды бота:',
    '/help — эта справка',
    '/status — состояние бота, белого списка и текущей сессии',
    '/sessions — 10 последних сессий DSH: номер, название, состояние',
    '/use N — выбрать сессию номер N для этого чата',
    '/ask <текст> — поставить сообщение в очередь текущей сессии',
    '/steer <текст> — вклинить сообщение в текущий ход сессии',
    '/new <текст> — создать новую сессию и отправить в неё сообщение',
    '/cancel — отменить текущий ход сессии',
    '/last — последние 5 сообщений истории «Входящих»',
    '/menu — показать меню с кнопками',
    '',
    'Обычный текст без команды — это /ask в текущую сессию этого чата.',
    'Кнопки меню: «📋 Сессии», «➕ Новая сессия», «⏹ Прервать», «ℹ️ Состояние»,',
    '«❓ Помощь»; меню открывается командой /menu или /start и остаётся внизу',
    'чата. В списке сессий можно выбирать их кнопками под сообщением.',
    'Бот управляет всем DSH: добавляйте в белый список только доверенные чаты.',
  ].join('\n')
}

/**
 * Build the `/status` body.
 * @param info - `{ polling, lastError, totalMessages, allowedCount, current, sessionsAvailable }`.
 * @returns a multi-line report.
 */
export function statusText(info) {
  const lines = [
    `Входящие: приём ${info.polling ? 'включён' : 'выключен'}.`,
    `История: ${info.totalMessages} сообщений (максимум ${MAX_MESSAGES}).`,
    `Белый список: ${info.allowedCount === 0 ? 'пуст — управлять нельзя никому. Добавьте свой чат на странице плагина' : `${info.allowedCount} чатов`}.`,
    `DSH: ${info.sessionsAvailable ? 'управление сессиями доступно' : 'сервис sessionController не найден в этом профиле'}.`,
  ]
  if (info.current === null || info.current === undefined) {
    lines.push(`Текущая сессия для чата: ${REPLIES.sessionNotChosen}`)
  } else {
    lines.push(`Текущая сессия для чата: ${sessionLabel(info.current.title, info.current.sessionId)} — ${info.current.running ? REPLIES.running : REPLIES.idle}.`)
  }
  lines.push(`Последняя ошибка: ${typeof info.lastError === 'string' && info.lastError !== '' ? info.lastError : 'нет'}.`)
  return lines.join('\n')
}

/**
 * Build the `/last` body from the Inbox history.
 * @param messages - stored history records.
 * @param limit - how many messages to print.
 * @returns `{ summary, details }`.
 */
export function lastMessagesText(messages, limit = 5) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return { summary: REPLIES.lastEmpty, details: '' }
  const shown = list.slice(-limit)
  const lines = shown.map((message, index) => {
    const mark = message.direction === 'out' ? '➡' : '⬅'
    const blocked = message.blocked === true ? ` · ${BLOCKED_MARK}` : ''
    const who = message.chatTitle === '' ? message.chatId : message.chatTitle
    return `${index + 1}) ${mark} ${who}${blocked}: ${message.text}`
  })
  return { summary: `сообщений: ${shown.length} из ${list.length}`, details: lines.join('\n') }
}

/** Labels of the reply and inline buttons, shared by the keyboard builders. */
export const MENU_LABELS = {
  sessions: '📋 Сессии',
  newSession: '➕ Новая сессия',
  cancel: '⏹ Прервать',
  status: 'ℹ️ Состояние',
  help: '❓ Помощь',
  ask: '💬 Спросить',
  refresh: '🔄 Обновить список',
  menu: '🏠 Меню',
  write: '💬 Писать',
  stop: '⏹ Стоп',
  settings: '⚙️ Настройки',
  back: '◀',
  forward: '▶',
  allSessions: '📂 Все сессии',
  projectSessions: '📁 Проект',
  refreshShort: '🔄 Обновить',
}

/** Texts of the menu surface: greeting, hints and callback answers. */
export const MENU_TEXTS = {
  greeting: 'Меню «Входящих». Выберите действие кнопкой ниже или отправьте команду.',
  chooseSession: 'Выберите сессию кнопкой ниже; список обновляется кнопкой «🔄 Обновить список».',
  sessionChosen: label => `Сессия выбрана: ${label}. Отправьте /ask <текст> или напишите обычным текстом.`,
  hintNew: 'Отправьте /new <текст> — бот создаст новую сессию и отправит в неё сообщение.',
  hintAsk: 'Отправьте /ask <текст> — текст уйдёт в текущую сессию чата.',
  cancelRequested: label => `⏹ Отмена запрошена для ${label}.`,
  cancelFailed: 'Не удалось отменить сессию.',
  refreshFailed: 'Не удалось обновить список сессий.',
  unknownButton: 'Неизвестная кнопка.',
  menuSent: 'Меню отправлено ниже.',
  callbackDenied: '⛔ Нет доступа.',
  callbackDone: 'Готово.',
  sessionNotChosenForCallback: 'Сессия не выбрана: откройте /sessions и выберите кнопкой.',
  sessionsHeader: ({ all, page, pages, count }) =>
    `${all ? 'Все сессии DSH' : 'Сессии текущего проекта'} (${count}) — страница ${page} из ${pages}. Выберите кнопкой:`,
  sessionsEmpty: 'Сессий нет. Отправьте /new <текст>, чтобы создать первую.',
  pageStatus: ({ page, pages }) => `Страница ${page} из ${pages}.`,
  groupsDenied: '⛔ Группы запрещены. Управлять ботом можно только из личного чата владельца.',
  notListed: '⛔ Нет доступа. Попросите владельца DSH добавить этот аккаунт в белый список.',
  rateLimited: seconds => `⏳ Слишком часто: подождите ${seconds} с.`,
  hourLimited: '⏳ Лимит 30 команд в час исчерпан. Попробуйте позже.',
  askHintSent: 'Отправьте /ask <текст> — ответ придёт из DSH.',
  stopCancelled: label => `⏹ Ход сессии ${label} отменён.`,
  settingsTitle: 'Настройки «Входящих»',
}
