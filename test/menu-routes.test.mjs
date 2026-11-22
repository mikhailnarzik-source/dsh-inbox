import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  callRoute,
  fakeContext,
  sleep,
  telegramError,
  telegramMock,
  waitFor,
  withTempInbox,
} from './helpers.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'
const CHAT = '555'
const STATE_PATH = '/api/dsh-inbox/state'
const VERIFY_PATH = '/api/dsh-inbox/verify'
const POLLING_PATH = '/api/dsh-inbox/polling'
const MENU_REFRESH_PATH = '/api/dsh-inbox/menu/refresh'

/** Fresh menu cache, so tests do not call setMyCommands unless they mean to. */
const FRESH_MENU = { version: '0.4.0', at: Date.now(), ok: true }

/** One Telegram text update. */
function messageUpdate(updateId, text, chatId = CHAT) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1763800000,
      from: { id: Number(chatId), first_name: 'Иван' },
      chat: { id: Number(chatId), type: 'private', first_name: 'Иван' },
      text,
    },
  }
}

/** One pressed inline button update. */
function callbackUpdate(updateId, data, chatId = CHAT, messageId = 50) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(chatId), first_name: 'Иван' },
      message: {
        message_id: messageId,
        date: 1763800000,
        chat: { id: Number(chatId), type: 'private', first_name: 'Иван' },
      },
      data,
    },
  }
}

/** A mock `sessionController`. */
function mockController(options = {}) {
  const calls = { list: [], resolveAgent: [], prompt: [], cancel: [], create: [] }
  return {
    calls,
    async list() {
      calls.list.push(true)
      return { items: options.items ?? [
        { sessionId: 's-new', updatedAt: 2000, running: true, agentAvailable: true, blank: false, projections: { values: { title: 'Новая сессия' } } },
        { sessionId: 's-old', updatedAt: 1000, running: false, agentAvailable: true, blank: false, projections: { values: { title: 'Старая сессия' } } },
        { sessionId: 's-sub', updatedAt: 3000, running: false, agentAvailable: true, origin: 'subagent' },
      ] }
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId)
      return { agent: { status: 'idle' } }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    async create() {
      return { sessionId: 's-created' }
    },
  }
}

/** A mock `sessionQuery`. */
function mockQuery() {
  return {
    async listSessions() {
      return [{ header: { id: 's-cold', createdAt: 500 } }]
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: `Заголовок ${id}` } } }))
    },
  }
}

/** Seed the state file; the menu cache is fresh by default. */
async function seedState(dir, overrides = {}) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 3,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedChatIds: [CHAT],
    currentChatSession: {},
    pendingLists: {},
    commandsMenu: FRESH_MENU,
    messages: [],
    ...overrides,
  }), 'utf8')
}

/** Verify the token and return the mock, the payload and the page state. */
async function runVerify(dir, options = {}) {
  const mock = telegramMock(options.telegramOverrides)
  const module = await import('../index.js')
  const ctx = fakeContext({ token: TOKEN, controller: options.controller, query: options.query })
  module.apply(ctx)
  try {
    const payload = await callRoute(ctx, VERIFY_PATH, {})
    const state = await callRoute(ctx, STATE_PATH, {})
    return { payload, state, mock }
  } finally {
    await ctx.disposeAll()
    mock.restore()
  }
}

/**
 * Enable polling, feed one batch of updates and wait for `until`.
 * `until` receives `{ mock, readState }`.
 * @returns `{ state, mock }`.
 */
async function runUpdates(dir, options = {}) {
  await seedState(dir, options.seed)
  let calls = 0
  const updates = options.updates ?? []
  const mock = telegramMock({
    ...options.telegramOverrides,
    getUpdates: () => {
      calls += 1
      if (calls === 1) return Response.json({ ok: true, result: updates })
      return Response.json({ ok: true, result: [] })
    },
  })
  const module = await import('../index.js')
  const ctx = fakeContext({ token: TOKEN, controller: options.controller, query: options.query })
  module.apply(ctx)
  try {
    const readState = () => callRoute(ctx, STATE_PATH, {})
    await callRoute(ctx, POLLING_PATH, { enabled: true })
    if (typeof options.until === 'function') {
      const done = await waitFor(() => options.until({ mock, readState }), options.waitMs ?? 3000)
      assert.equal(done, true, 'ожидаемое действие выполнилось')
    } else {
      await sleep(100)
    }
    const state = await readState()
    await callRoute(ctx, POLLING_PATH, { enabled: false })
    return { state, mock }
  } finally {
    await ctx.disposeAll()
    mock.restore()
  }
}

test('verify публикует меню команд один раз и запоминает версию', async () => {
  await withTempInbox(async dir => {
    await seedState(dir, { commandsMenu: { version: '', at: 0, ok: false } })
    const first = await runVerify(dir)
    assert.equal(first.payload.ok, true)
    assert.equal(first.mock.myCommands.length, 1)
    assert.deepEqual(first.mock.myCommands[0].scope, { type: 'default' })
    assert.equal(first.mock.myCommands[0].commands.length, 10)
    assert.deepEqual(first.mock.myCommands[0].commands[0], { command: 'help', description: 'Помощь' })
    assert.equal(first.state.menu.ok, true)
    assert.equal(first.state.menu.publishedVersion, '0.4.0')
  })
  await withTempInbox(async dir => {
    await seedState(dir, { commandsMenu: FRESH_MENU })
    const second = await runVerify(dir)
    assert.equal(second.mock.myCommands.length, 0, 'кэш на сутки подавляет повторный вызов')
    assert.equal(second.state.menu.ok, true)
  })
})

test('verify обновляет меню после смены версии или истечения суток', async () => {
  await withTempInbox(async dir => {
    await seedState(dir, { commandsMenu: { version: '0.3.0', at: Date.now(), ok: true } })
    const changed = await runVerify(dir)
    assert.equal(changed.mock.myCommands.length, 1)
    assert.equal(changed.state.menu.publishedVersion, '0.4.0')
  })
  await withTempInbox(async dir => {
    await seedState(dir, { commandsMenu: { version: '0.4.0', at: Date.now() - 25 * 60 * 60 * 1000, ok: true } })
    const expired = await runVerify(dir)
    assert.equal(expired.mock.myCommands.length, 1)
  })
})

test('ошибка setMyCommands не ломает проверку токена', async () => {
  await withTempInbox(async dir => {
    const failed = await runVerify(dir, {
      telegramOverrides: { setMyCommands: () => telegramError(500, 'Internal Server Error', 500) },
    })
    assert.equal(failed.payload.ok, true, 'токен проверен несмотря на ошибку меню')
    assert.equal(failed.mock.myCommands.length, 1)
    assert.equal(failed.state.menu.ok, false)
  })
})

test('ошибка setMyCommands не ломает приём сообщений', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/help')],
      telegramOverrides: { setMyCommands: () => telegramError(500, 'Internal Server Error', 500) },
      until: ({ mock }) => mock.sent.some(message => /✅ Принято/.test(message.text)),
    })
    assert.match(mock.sent[0].text, /✅ Принято/)
  })
})

test('кнопка «Обновить меню команд» вызывает setMyCommands принудительно', async () => {
  await withTempInbox(async dir => {
    await seedState(dir)
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, MENU_REFRESH_PATH, { force: true })
      assert.equal(payload.ok, true)
      assert.equal(payload.cached, false)
      assert.equal(mock.myCommands.length, 1)
      assert.equal(payload.commands, 10)
      const second = await callRoute(ctx, MENU_REFRESH_PATH, { force: false })
      assert.equal(second.ok, true)
      assert.equal(second.cached, true)
      assert.equal(mock.myCommands.length, 1)
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})

test('/menu и /start присылают reply-клавиатуру с пятью кнопками', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/menu'), messageUpdate(2, '/start')],
      until: ({ mock }) => mock.sent.filter(message => message.reply_markup?.keyboard !== undefined).length === 2,
    })
    const replies = mock.sent.filter(message => message.reply_markup?.keyboard !== undefined)
    assert.equal(replies.length, 2)
    const buttons = replies[0].reply_markup.keyboard.flat().map(button => button.text)
    assert.deepEqual(buttons, ['📋 Сессии', '➕ Новая сессия', '⏹ Прервать', 'ℹ️ Состояние', '❓ Помощь'])
    for (const reply of replies) {
      assert.match(reply.text, /✅ Принято/)
      assert.match(reply.text, /Меню «Входящих»/)
    }
  })
})

test('кнопка «📋 Сессии» в reply-клавиатуре открывает список сессий', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      updates: [messageUpdate(1, '📋 Сессии')],
      until: ({ mock }) => mock.sent.some(message => message.reply_markup?.inline_keyboard !== undefined),
    })
    const reply = mock.sent.find(message => message.reply_markup?.inline_keyboard !== undefined)
    const data = reply.reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(data.includes('use:s-new'))
    assert.ok(data.includes('sessions:refresh'))
    assert.match(reply.text, /✅ Принято/)
    assert.equal(controller.calls.list.length >= 1, true)
  })
})

test('кнопка «➕ Новая сессия» присылает подсказку /new', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '➕ Новая сессия')],
      until: ({ mock }) => mock.sent.length > 0,
    })
    assert.match(mock.sent[0].text, /Отправьте \/new/)
    assert.ok(mock.sent[0].reply_markup?.keyboard !== undefined)
  })
})

test('/sessions присылает inline-кнопки выбора сессий', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/sessions')],
      until: ({ mock }) => mock.sent.some(message => message.reply_markup?.inline_keyboard !== undefined),
    })
    const reply = mock.sent.find(message => message.reply_markup?.inline_keyboard !== undefined)
    const buttons = reply.reply_markup.inline_keyboard.flat()
    assert.equal(buttons.filter(button => button.callback_data.startsWith('use:')).length, 3)
    assert.ok(buttons.some(button => button.callback_data === 'use:s-new'))
    assert.match(buttons[0].text, /1\. Новая сессия — выполняется/)
    assert.ok(buttons.some(button => button.callback_data === 'sessions:refresh'))
  })
})

test('callback use:<id>: выбирает сессию, отвечает и редактирует сообщение', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { state, mock } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      updates: [callbackUpdate(1, 'use:s-new')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.equal(mock.answers.length, 1)
    assert.deepEqual(mock.answers[0], { callback_query_id: 'cb-1', text: 'Сессия выбрана', show_alert: false })
    assert.match(mock.edits[0].text, /Сессия выбрана/)
    const data = mock.edits[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(data.includes('cancel:s-new'))
    assert.equal(mock.edits[0].message_id, 50)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(file.currentChatSession[CHAT], 's-new')
    assert.equal(state.messages.length, 0, 'callback не пишется в историю как сообщение')
  })
})

test('callback cancel:<id>: отменяет сессию и подтверждает', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      seed: { currentChatSession: { [CHAT]: 's-new' } },
      updates: [callbackUpdate(1, 'cancel:s-new')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.deepEqual(controller.calls.cancel[0], { sessionId: 's-new' })
    assert.equal(mock.answers[0].text, 'Отмена запрошена')
    assert.match(mock.edits[0].text, /Отмена запрошена/)
    const data = mock.edits[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(data.includes('cancel:s-new'))
  })
})

test('callback sessions:refresh: обновляет список и запоминает его для /use', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'sessions:refresh')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.equal(mock.answers[0].text, 'Список обновлён')
    assert.match(mock.edits[0].text, /сессий: 3/)
    const data = mock.edits[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(data.includes('use:s-old'))
  })
})

test('callback status и help: редактируют сообщение и дают inline-кнопки', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      seed: { currentChatSession: { [CHAT]: 's-new' } },
      updates: [callbackUpdate(1, 'status'), callbackUpdate(2, 'help')],
      until: ({ mock }) => mock.edits.length === 2,
    })
    assert.match(mock.edits[0].text, /Входящие: приём/)
    const statusButtons = mock.edits[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.deepEqual(statusButtons, ['cancel:s-new', 'menu', 'help'])
    assert.match(mock.edits[1].text, /Команды бота/)
    const helpButtons = mock.edits[1].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(helpButtons.includes('menu'))
    assert.equal(mock.answers.length, 2)
  })
})

test('callback menu и ask: присылают клавиатуру и подсказку', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'menu'), callbackUpdate(2, 'ask')],
      until: ({ mock }) => mock.sent.length >= 2,
    })
    const menuMessage = mock.sent.find(message => message.reply_markup?.keyboard !== undefined)
    assert.ok(menuMessage, 'меню отправлено новой клавиатурой')
    assert.match(menuMessage.text, /Меню «Входящих»/)
    assert.match(mock.sent.at(-1).text, /Отправьте \/ask/)
    assert.ok(mock.answers.some(answer => /Меню отправлено/.test(answer.text)))
  })
})

test('чужой чат: callback получает отказ, действие не выполняется', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock, state } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      updates: [callbackUpdate(1, 'use:s-new', '999')],
      until: ({ mock }) => mock.answers.length > 0,
    })
    assert.deepEqual(mock.answers[0], { callback_query_id: 'cb-1', text: '⛔ Нет доступа.', show_alert: false })
    assert.equal(mock.edits.length, 0, 'сообщение не редактировалось')
    assert.equal(controller.calls.list.length, 0, 'сессии не запрашивались')
    assert.equal(state.currentSession, null)
    assert.ok(mock.sent.some(message => /⛔ Нет доступа/.test(message.text)), 'бот пояснил отказ в чате')
  })
})

test('пустой белый список: callback отклоняется, action не выполняется', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock, state } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      seed: { allowedChatIds: [] },
      updates: [callbackUpdate(1, 'sessions:refresh')],
      until: ({ mock }) => mock.answers.length > 0,
    })
    assert.equal(mock.answers[0].text, '⛔ Нет доступа.')
    assert.equal(mock.edits.length, 0)
    assert.equal(controller.calls.list.length, 0)
    assert.equal(state.allowedChatIds.length, 0)
  })
})

test('неизвестный callback всегда получает answerCallbackQuery', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'wat')],
      until: ({ mock }) => mock.answers.length > 0,
    })
    assert.equal(mock.answers.length, 1)
    assert.match(mock.answers[0].text, /Неизвестная кнопка/)
  })
})

test('ошибка answerCallbackQuery не ломает приём и следующие кнопки', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      updates: [callbackUpdate(1, 'use:s-new'), messageUpdate(2, '/help')],
      telegramOverrides: {
        answerCallbackQuery: () => telegramError(400, 'Bad Request: query is too old', 400),
      },
      until: ({ mock }) => mock.edits.length > 0 && mock.sent.some(message => /✅ Принято/.test(message.text)),
    })
    assert.equal(mock.answers.length >= 1, true)
    assert.match(mock.edits[0].text, /Сессия выбрана/)
    assert.match(mock.sent.at(-1).text, /Команды бота/)
  })
})

test('устаревшее сообщение: editMessageText падает — бот присылает новое', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      seed: { currentChatSession: { [CHAT]: 's-new' } },
      updates: [callbackUpdate(1, 'status')],
      telegramOverrides: {
        editMessageText: () => telegramError(400, 'Bad Request: message to edit not found', 400),
      },
      until: ({ mock }) => mock.sent.some(message => /Входящие: приём/.test(message.text)),
    })
    assert.equal(mock.edits.length >= 1, true, 'попытка редактирования была')
    assert.ok(mock.sent.some(message => /Входящие: приём/.test(message.text)), 'резервное сообщение отправлено')
  })
})
