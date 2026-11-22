/**
 * Agent-facing tools of the Inbox plugin.
 *
 * Five tools, all about the bot that belongs to this DSH installation:
 * `telegram_status` reports the connection and the allow-list,
 * `telegram_messages` prints the stored history, `telegram_send` answers a
 * chat, `telegram_allowed` shows which chats may control DSH, and
 * `telegram_allow` adds one chat to that list. The tools share the runtime with
 * the plugin page, so a reply sent by the agent appears in the same history and
 * the token never leaves the Host.
 */

import { BLOCKED_MARK } from './replies.mjs'

/** Canonical text output shared by every tool. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** Default number of messages `telegram_messages` prints. */
const DEFAULT_LIMIT = 10

/** Upper bound for `telegram_messages`. */
const MAX_LIMIT = 50

/** Arrow and word for one direction. */
const DIRECTION = {
  in: { mark: '⬅', label: 'входящее' },
  out: { mark: '➡', label: 'исходящее' },
}

/**
 * Format a stored timestamp for the agent: date, then time, in UTC.
 * @param at - ISO string from the history.
 * @returns `YYYY-MM-DD HH:MM` or an em dash.
 */
export function formatTime(at) {
  const value = String(at ?? '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : '—'
}

/**
 * Render the last messages of the history as text.
 * @param state - current state.
 * @param limit - how many messages to print.
 * @returns a multi-line report.
 */
export function formatMessages(state, limit = DEFAULT_LIMIT) {
  const messages = Array.isArray(state.messages) ? state.messages : []
  if (messages.length === 0) {
    return 'История пуста. Включите приём сообщений и напишите боту в Telegram — первые сообщения появятся здесь.'
  }
  const count = Math.min(Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)), MAX_LIMIT)
  const shown = messages.slice(-count)
  const lines = [`Последние сообщения (${shown.length} из ${messages.length}), время в UTC:`]
  shown.forEach((message, index) => {
    const direction = DIRECTION[message.direction] ?? DIRECTION.in
    const from = message.from === '' ? '—' : message.from
    const title = message.chatTitle === '' ? message.chatId : message.chatTitle
    const blocked = message.blocked === true ? ` · ${BLOCKED_MARK}` : ''
    lines.push(`${index + 1}) ${direction.mark} ${direction.label}${blocked} · ${formatTime(message.at)} · ${from} · чат «${title}»: ${message.text}`)
  })
  return lines.join('\n')
}

/**
 * Render the allow-list as text.
 * @param state - current state.
 * @returns a multi-line report.
 */
export function formatAllowList(state) {
  const ids = Array.isArray(state.allowedChatIds) ? state.allowedChatIds : []
  if (ids.length === 0) {
    return [
      'Белый список пуст: управлять DSH из Telegram нельзя никому.',
      'Добавьте свой чат на странице плагина «Входящие» (кнопка «Разрешить этот чат» или поле списка) либо этим инструментом: telegram_allow с chatId.',
    ].join('\n')
  }
  const lines = [`Белый список: ${ids.length} чатов.`]
  for (const id of ids) {
    const last = [...state.messages].reverse().find(message => message.chatId === id)
    lines.push(`- ${id}${last === undefined ? '' : ` · ${last.chatTitle === '' ? id : last.chatTitle}`}`)
  }
  lines.push('Управлять ботом могут только эти чаты; остальным он отвечает «⛔ Нет доступа».')
  return lines.join('\n')
}

/**
 * Render one tool-facing line about the shared queue.
 * @param queue - result of the runtime `queueStatus()`.
 * @returns a short sentence, or '' when no queue data is available.
 */
export function formatQueueLine(queue) {
  if (queue === null || queue === undefined) return ''
  const counts = queue.counts ?? {}
  const mode = queue.configured === true ? 'настроена' : 'inline, без remote'
  const role = queue.listener === true ? 'слушает Telegram' : 'исполнитель'
  return `Общая очередь: ${mode}; роль: ${role}; команды: новых ${counts.new ?? 0}, в работе ${counts.inProgress ?? 0}, готово ${counts.done ?? 0}.`
}

/**
 * Render the result of `telegram_listen` as text.
 * @param result - `{ ok, message, listener, queue }` from the listener switch.
 * @returns a multi-line report for the model.
 */
export function formatListenResult(result) {
  const queue = result?.queue ?? {}
  if (result?.ok !== true) {
    const reason = typeof result?.message === 'string' && result.message !== '' ? result.message : 'неизвестная ошибка'
    return `⚠️ Не удалось переключить роль слушателя: ${reason}`
  }
  const lines = [
    result.listener === true
      ? '✅ Это устройство слушает Telegram.'
      : '⏹ Приём Telegram на этом устройстве выключен.',
    formatQueueLine(queue),
  ]
  if (queue.otherListener !== undefined && queue.otherListener !== null) {
    lines.push(`Внимание: Telegram уже слушает «${queue.otherListener.deviceName}». Слушателем должно быть только одно устройство, иначе Telegram ответит 409 Conflict.`)
  } else if (result.listener === true) {
    lines.push('Другие устройства должны быть в роли исполнителя: второй слушатель получит 409 Conflict.')
  }
  if (typeof queue.lastError === 'string' && queue.lastError !== '') lines.push(`Последняя ошибка: ${queue.lastError}`)
  return lines.filter(line => line !== '').join('\n')
}

/**
 * Render the connection status as text.
 * @param info - `{ configured, writable }` from the credential store.
 * @param state - current state.
 * @param running - whether the long-polling loop is active.
 * @param currentSession - `{ chatTitle, sessionId, title, running }` for the last chat, or null.
 * @param queue - optional queue summary from `queueStatus()`.
 * @returns a multi-line report.
 */
export function formatStatus(info, state, running, currentSession = null, queue = null) {
  const lines = []
  if (info.configured !== true) {
    lines.push('Входящие (Telegram): токен не сохранён.')
    lines.push('Откройте «Плагины» → «Входящие», вставьте токен бота от @BotFather в поле «Токен бота» и нажмите «Сохранить».')
    lines.push('DSH хранит токен в хранилище секретов под именем refs.TELEGRAM_BOT_TOKEN — в браузер и в конфигурацию он не попадает.')
  } else {
    lines.push('Входящие (Telegram): токен сохранён.')
    lines.push(`Бот: ${state.botUsername === '' ? 'имя ещё не получено — нажмите «Проверить» на странице плагина' : `@${state.botUsername}`}`)
    lines.push(`Приём сообщений: ${state.enabled === true ? (running ? 'включён' : 'включён, но цикл ещё не запущен') : 'выключен'}`)
    if (typeof state.lastError === 'string' && state.lastError !== '') lines.push(`Последняя ошибка: ${state.lastError}`)
    else lines.push('Последняя ошибка: нет')
    lines.push(`История: ${state.messages.length} сообщений (максимум 200, время в UTC).`)
    const last = state.messages[state.messages.length - 1]
    if (last !== undefined) lines.push(`Последний чат: «${last.chatTitle}» (chatId ${last.chatId}).`)
    if (info.writable === false) lines.push('Хранилище секретов доступно только для чтения: удалить или заменить токен из интерфейса нельзя.')
  }
  const allowed = Array.isArray(state.allowedChatIds) ? state.allowedChatIds : []
  lines.push(`Белый список: ${allowed.length === 0 ? 'пуст — управлять DSH нельзя никому. Добавьте свой чат на странице плагина или через telegram_allow.' : `${allowed.length} чатов: ${allowed.join(', ')}.`}`)
  const queueLine = formatQueueLine(queue)
  if (queueLine !== '') lines.push(queueLine)
  if (queue !== null && queue !== undefined && queue.otherListener !== undefined && queue.otherListener !== null) {
    lines.push(`Внимание: Telegram слушает «${queue.otherListener.deviceName}» — на этом устройстве приём должен быть выключен (иначе 409).`)
  }
  if (queue !== null && queue !== undefined && typeof queue.lastError === 'string' && queue.lastError !== '') {
    lines.push(`Ошибка очереди: ${queue.lastError}`)
  }
  if (currentSession === null || currentSession === undefined) {
    lines.push('Текущая сессия для последнего чата: не выбрана (в Telegram: /sessions, затем /use N).')
  } else {
    const title = typeof currentSession.title === 'string' && currentSession.title !== ''
      ? `«${currentSession.title}»`
      : `сессия ${currentSession.sessionId}`
    lines.push(`Текущая сессия для последнего чата (${currentSession.chatTitle ?? currentSession.chatId}): ${title} — ${currentSession.running === true ? 'выполняется' : 'ожидает'}.`)
  }
  return lines.join('\n')
}

/**
 * Render the shared-queue status as text.
 * @param status - result of the runtime `queueStatus()`.
 * @returns a multi-line report.
 */
export function formatQueueStatus(status) {
  const lines = []
  const configured = status?.configured === true
  lines.push(`Общая очередь команд: ${configured ? 'настроена' : 'не настроена'}.`)
  if (!configured) {
    lines.push('Команды выполняются на этом же устройстве сразу после получения (режим inline).')
    lines.push('Чтобы включить общую очередь между устройствами, заполните поле remote в ~/.dsh/dsh-sync.json — плагин заведёт ветку inbox в том же репозитории.')
    return lines.join('\n')
  }
  const device = status.device ?? {}
  lines.push(`Ветка: ${status.branch ?? 'inbox'}; устройство: ${device.name ?? '?'} (${device.id ?? '?'}).`)
  lines.push(`Роль: ${status.listener === true ? 'слушает Telegram' : 'исполнитель (Telegram слушает другое устройство)'}.`)
  const counts = status.counts ?? {}
  lines.push(`Команды: новых ${counts.new ?? 0}, в работе ${counts.inProgress ?? 0}, готово ${counts.done ?? 0} (всего ${counts.total ?? 0}).`)
  if (Array.isArray(status.inProgress) && status.inProgress.length > 0) {
    for (const item of status.inProgress) {
      lines.push(`- выполняет ${item.deviceName}: ${item.text === '' ? item.commandId : item.text}`)
    }
  }
  if (Array.isArray(status.devices) && status.devices.length > 0) {
    lines.push('Устройства очереди:')
    for (const entry of status.devices) {
      lines.push(`- ${entry.deviceName ?? entry.deviceId} (${new Date(Number(entry.lastSyncAt) || 0).toISOString()}): ${entry.listener === true ? 'слушает Telegram' : 'исполнитель'}${entry.lastError === '' || entry.lastError === undefined ? '' : `, ошибка: ${entry.lastError}`}`)
    }
  }
  if (status.otherListener !== undefined && status.otherListener !== null) {
    lines.push(`Внимание: Telegram слушает «${status.otherListener.deviceName}» — на этом устройстве приём должен быть выключен, иначе Telegram ответит 409.`)
  }
  lines.push(`Последняя синхронизация: ${Number(status.lastSyncAt) > 0 ? formatTime(new Date(Number(status.lastSyncAt)).toISOString()) : 'ещё не было'}.`)
  lines.push(`Последняя ошибка: ${typeof status.lastError === 'string' && status.lastError !== '' ? status.lastError : 'нет'}.`)
  return lines.join('\n')
}

/**
 * Build every tool definition.
 * @param deps - runtime bridge:
 *   `ready`, `tokenInfo()`, `snapshot()`, `polling()`, `sendReply({chatId,text})`,
 *   `addAllowedChat(chatId)`, `currentSessionInfo()`, `queueStatus()`,
 *   `setListener(enabled)`.
 * @returns the definitions to register.
 */
export function createTools(deps) {
  return [
    {
      name: 'telegram_status',
      description: 'Показать состояние «Входящих»: токен, имя бота, приём, историю, белый список, текущую сессию и общую очередь. Только чтение.',
      parameters: { type: 'object', properties: {} },
      output: TEXT_OUTPUT,
      async execute() {
        await deps.ready
        const info = await deps.tokenInfo()
        const currentSession = typeof deps.currentSessionInfo === 'function'
          ? await deps.currentSessionInfo().catch(() => null)
          : null
        const queue = typeof deps.queueStatus === 'function' ? await deps.queueStatus().catch(() => null) : null
        return formatStatus(info, deps.snapshot(), deps.polling(), currentSession, queue)
      },
    },
    {
      name: 'telegram_messages',
      description: 'Показать последние сообщения из истории «Входящих»: направление, чат, отправитель, время (UTC) и текст. История хранится в DSH локально и не заменяет чат Telegram.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: `Сколько последних сообщений показать, по умолчанию ${DEFAULT_LIMIT}, максимум ${MAX_LIMIT}.`,
          },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await deps.ready
        return formatMessages(deps.snapshot(), args?.limit)
      },
    },
    {
      name: 'telegram_send',
      description: 'Отправить текст в Telegram от имени бота и записать в историю. chatId можно не указывать или передать "last" — уйдёт в последний чат. Максимум 4096 символов.',
      parameters: {
        type: 'object',
        properties: {
          chatId: {
            type: 'string',
            description: 'Идентификатор чата Telegram или "last" (последний чат). Без параметра — тоже последний чат.',
          },
          text: { type: 'string', description: 'Текст сообщения, до 4096 символов.' },
        },
        required: ['text'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await deps.ready
        const result = await deps.sendReply({ chatId: args?.chatId, text: args?.text })
        return `Отправлено в «${result.chatTitle}» (chatId ${result.chatId})${result.messageId === undefined ? '' : `, message_id ${result.messageId}`}.`
      },
    },
    {
      name: 'telegram_allowed',
      description: 'Показать белый список чатов, которым разрешено управлять DSH из Telegram. Пустой список означает, что управлять нельзя никому. Только чтение.',
      parameters: { type: 'object', properties: {} },
      output: TEXT_OUTPUT,
      async execute() {
        await deps.ready
        return formatAllowList(deps.snapshot())
      },
    },
    {
      name: 'telegram_allow',
      description: 'Добавить чат в белый список «Входящих», чтобы из него можно было управлять DSH. Бот получает полный доступ: только доверенные чаты. chatId — число.',
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Идентификатор чата Telegram, например 123456789 или -1001234567890.' },
        },
        required: ['chatId'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await deps.ready
        const result = await deps.addAllowedChat(args?.chatId)
        const state = deps.snapshot()
        const note = result.changed ? 'Чат добавлен в белый список.' : 'Чат уже был в белом списке.'
        return `${note} Всего чатов: ${state.allowedChatIds.length}: ${state.allowedChatIds.join(', ')}.`
      },
    },
    {
      name: 'telegram_queue_status',
      description: 'Состояние общей очереди между устройствами: роль, счётчики, кто выполняет, синхронизация и ошибка. Только чтение.',
      parameters: { type: 'object', properties: {} },
      output: TEXT_OUTPUT,
      async execute() {
        await deps.ready
        const status = typeof deps.queueStatus === 'function' ? await deps.queueStatus() : null
        return formatQueueStatus(status)
      },
    },
    {
      name: 'telegram_listen',
      description: 'Включить или выключить роль «Слушать Telegram здесь». Слушать может только одно устройство, иначе Telegram ответит 409.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true — слушать Telegram здесь, false — выключить приём.' },
        },
        required: ['enabled'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        await deps.ready
        if (typeof deps.setListener !== 'function') throw new Error('Переключение роли слушателя недоступно в этом профиле.')
        const result = await deps.setListener(args?.enabled === true)
        return formatListenResult(result)
      },
    },
  ]
}
