/**
 * Agent-facing tools of the Inbox plugin.
 *
 * Three tools, all about the bot that belongs to this DSH installation:
 * `telegram_status` reports the connection, `telegram_messages` prints the
 * stored history, `telegram_send` answers a chat through the bot. The tools
 * share the runtime with the plugin page, so a reply sent by the agent appears
 * in the same history and the token never leaves the Host.
 */

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
    lines.push(`${index + 1}) ${direction.mark} ${direction.label} · ${formatTime(message.at)} · ${from} · чат «${title}»: ${message.text}`)
  })
  return lines.join('\n')
}

/**
 * Render the connection status as text.
 * @param info - `{ configured, writable }` from the credential store.
 * @param state - current state.
 * @param running - whether the long-polling loop is active.
 * @returns a multi-line report.
 */
export function formatStatus(info, state, running) {
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
  return lines.join('\n')
}

/**
 * Build every tool definition.
 * @param deps - runtime bridge:
 *   `ready`, `tokenInfo()`, `snapshot()`, `polling()`, `sendReply({chatId,text})`.
 * @returns the definitions to register.
 */
export function createTools(deps) {
  return [
    {
      name: 'telegram_status',
      description: 'Показать состояние «Входящих»: сохранён ли токен Telegram-бота, имя бота, включён ли приём сообщений, последнюю ошибку и размер истории. Только чтение, в сеть не ходит.',
      parameters: { type: 'object', properties: {} },
      output: TEXT_OUTPUT,
      async execute() {
        await deps.ready
        const info = await deps.tokenInfo()
        return formatStatus(info, deps.snapshot(), deps.polling())
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
      description: 'Отправить текстовое сообщение в Telegram от имени вашего бота и записать его в историю «Входящих». chatId можно не указывать или передать "last" — тогда ответ уйдёт в последний чат, из которого писали боту. Максимум 4096 символов.',
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
  ]
}
