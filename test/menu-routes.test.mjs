import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
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
const PROJECT = process.cwd()
const STATE_PATH = '/api/dsh-inbox/state'
const VERIFY_PATH = '/api/dsh-inbox/verify'
const POLLING_PATH = '/api/dsh-inbox/polling'
const MENU_REFRESH_PATH = '/api/dsh-inbox/menu/refresh'
const PROFILE_REFRESH_PATH = '/api/dsh-inbox/profile/refresh'

/** Fresh menu/profile caches, so tests only call Telegram when they mean to. */
const FRESH_MENU = { version: '0.5.0', at: Date.now(), ok: true }
const FRESH_PROFILE = {
  name: '📥 DSH Входящие',
  description: 'описание',
  shortDescription: 'коротко',
  at: Date.now(),
  version: '0.5.0',
  ok: true,
}

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
      return {
        items: options.items ?? [
          { sessionId: 's-new', updatedAt: 2000, running: true, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Новая сессия' } } },
          { sessionId: 's-old', updatedAt: 1000, running: false, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Старая сессия' } } },
          { sessionId: 's-sub', updatedAt: 3000, running: false, agentAvailable: true, origin: 'subagent', cwd: PROJECT },
        ],
      }
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
      return [{ header: { id: 's-cold', createdAt: 500, cwd: PROJECT } }]
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: `Заголовок ${id}` } } }))
    },
  }
}

/** Seed the state file; the menu/profile caches are fresh by default. */
async function seedState(dir, overrides = {}) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 5,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedUserIds: [CHAT],
    allowedChatIds: [CHAT],
    currentChatSession: {},
    pendingLists: {},
    commandsMenu: FRESH_MENU,
    botProfile: FRESH_PROFILE,
    security: { groupsEnabled: false },
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

/** Enable polling, feed one batch of updates and wait for `until`. */
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
      const done = await waitFor(() => options.until({ mock, readState, ctx }), options.waitMs ?? 3000)
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
    assert.equal(first.state.menu.publishedVersion, '0.5.0')
  })
  await withTempInbox(async dir => {
    await seedState(dir)
    const second = await runVerify(dir)
    assert.equal(second.mock.myCommands.length, 0, 'кэш на сутки подавляет повторный вызов')
    assert.equal(second.state.menu.ok, true)
  })
})

test('verify публикует профиль бота: имя, описания и кнопку меню', async () => {
  await withTempInbox(async dir => {
    await seedState(dir, { botProfile: { ...FRESH_PROFILE, version: '', ok: false } })
    const { mock, state } = await runVerify(dir)
    const methods = mock.profile.map(call => call.method)
    assert.deepEqual(methods, ['setMyName', 'setMyDescription', 'setMyShortDescription', 'setChatMenuButton'])
    const name = mock.profile.find(call => call.method === 'setMyName').body.name
    assert.ok(name.length <= 64)
    const description = mock.profile.find(call => call.method === 'setMyDescription').body.description
    assert.ok(description.length <= 512)
    const short = mock.profile.find(call => call.method === 'setMyShortDescription').body.short_description
    assert.ok(short.length <= 120)
    const menuButton = mock.profile.find(call => call.method === 'setChatMenuButton').body.menu_button
    assert.deepEqual(menuButton, { type: 'commands' })
    assert.equal(state.botProfile.ok, true)
    assert.equal(state.botProfile.version, '0.5.0')
  })
})

test('ошибка setMyCommands не ломает проверку токена', async () => {
  await withTempInbox(async dir => {
    const failed = await runVerify(dir, {
      telegramOverrides: { setMyCommands: () => telegramError(500, 'Internal Server Error', 500) },
    })
    assert.equal(failed.payload.ok, true, 'токен проверен несмотря на ошибку меню')
    assert.equal(failed.state.menu.ok, false)
  })
})

test('ошибка setMyName не ломает проверку и помечается в кэше', async () => {
  await withTempInbox(async dir => {
    await seedState(dir, { botProfile: { ...FRESH_PROFILE, version: '', ok: false } })
    const { mock, payload, state } = await runVerify(dir, {
      telegramOverrides: { setMyName: () => telegramError(500, 'Internal Server Error', 500) },
    })
    assert.equal(payload.ok, true, 'токен всё равно проверен')
    assert.equal(state.botProfile.ok, false)
    assert.ok(mock.profile.some(call => call.method === 'setMyName'))
  })
})

test('кнопка «Обновить профиль» публикует профиль принудительно', async () => {
  await withTempInbox(async dir => {
    await seedState(dir)
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, PROFILE_REFRESH_PATH, { force: true })
      assert.equal(payload.ok, true)
      assert.equal(mock.profile.length, 4)
      const cached = await callRoute(ctx, PROFILE_REFRESH_PATH, { force: false })
      assert.equal(cached.cached, true)
      assert.equal(mock.profile.length, 4)
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})

test('/menu и /start присылают главное inline-меню с «🏠 Меню»', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/menu'), messageUpdate(2, '/start')],
      until: ({ mock }) => mock.sent.length >= 2,
    })
    const main = mock.sent[0]
    const buttons = main.reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.deepEqual(buttons, ['sessions:1', 'newhint', 'status', 'settings', 'help'])
    assert.match(main.text, /✅ Принято/)
    assert.match(main.text, /Меню «Входящих»/)
    assert.match(mock.sent[1].text, /Меню «Входящих»/)
  })
})

test('callback menu: редактирует сообщение в главное меню', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'menu')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.equal(mock.answers[0].text, 'Меню отправлено ниже.')
    assert.match(mock.edits[0].text, /Меню «Входящих»/)
    const buttons = mock.edits[0].reply_markup.inline_keyboard.flat().map(button => button.callback_data)
    assert.ok(buttons.includes('sessions:1'))
  })
})

test('/sessions: короткие callback use:<index>, «💬 Писать» и «⏹ Стоп»', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/sessions')],
      until: ({ mock }) => mock.sent.some(message => message.reply_markup?.inline_keyboard !== undefined),
    })
    const reply = mock.sent.find(message => message.reply_markup?.inline_keyboard !== undefined)
    const buttons = reply.reply_markup.inline_keyboard.flat()
    assert.deepEqual(buttons.filter(button => button.callback_data.startsWith('use:')).map(button => button.callback_data), ['use:1', 'use:2', 'use:3'])
    assert.ok(buttons.some(button => button.callback_data === 'refresh:1'))
    assert.ok(buttons.some(button => button.callback_data === 'menu'))
  })
})

test('callback use:<index> выбирает сессию и показывает «Писать»/«Стоп»', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      seed: { pendingLists: { [CHAT]: ['s-new', 's-old'] } },
      updates: [callbackUpdate(1, 'use:1')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.equal(mock.answers[0].text, 'Сессия выбрана')
    assert.match(mock.edits[0].text, /Сессия выбрана/)
    const buttons = mock.edits[0].reply_markup.inline_keyboard.flat()
    const ask = buttons.find(button => button.callback_data === 'askhint')
    const stop = buttons.find(button => button.callback_data === 'stop')
    assert.equal(ask.style, 'primary')
    assert.equal(stop.style, 'danger')
    assert.ok(buttons.some(button => button.callback_data === 'menu'))
  })
})

test('callback sessions:<page> и refresh:<page> листают список', async () => {
  await withTempInbox(async dir => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      sessionId: `s-${index}`,
      updatedAt: 1000 + index,
      running: false,
      agentAvailable: true,
      blank: false,
      cwd: PROJECT,
      projections: { values: { title: `Сессия ${index}` } },
    }))
    const { mock } = await runUpdates(dir, {
      controller: mockController({ items }),
      query: { async listSessions() { return [] }, async readTitleSnapshots() { return [] } },
      updates: [callbackUpdate(1, 'sessions:2'), callbackUpdate(2, 'refresh:2')],
      until: ({ mock }) => mock.edits.length >= 2,
    })
    assert.match(mock.edits[0].text, /страница 2 из 2/)
    assert.match(mock.edits[1].text, /страница 2 из 2/)
  })
})

test('callback stop: отменяет текущую сессию', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      seed: { currentChatSession: { [CHAT]: 's-new' } },
      updates: [callbackUpdate(1, 'stop')],
      until: ({ mock }) => mock.edits.length > 0,
    })
    assert.deepEqual(controller.calls.cancel[0], { sessionId: 's-new' })
    assert.equal(mock.answers[0].text, 'Отмена запрошена')
    assert.match(mock.edits[0].text, /отменён/)
    const buttons = mock.edits[0].reply_markup.inline_keyboard.flat()
    assert.ok(buttons.some(button => button.callback_data === 'menu'))
  })
})

test('callback status/help/settings: экраны с домашней кнопкой', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      seed: { currentChatSession: { [CHAT]: 's-new' } },
      updates: [callbackUpdate(1, 'status'), callbackUpdate(2, 'help'), callbackUpdate(3, 'settings')],
      until: ({ mock }) => mock.edits.length >= 3,
    })
    assert.match(mock.edits[0].text, /Входящие: приём/)
    assert.match(mock.edits[1].text, /Команды бота/)
    assert.match(mock.edits[2].text, /Настройки «Входящих»/)
    for (const edit of mock.edits) {
      const buttons = edit.reply_markup.inline_keyboard.flat()
      assert.ok(buttons.some(button => button.callback_data === 'menu'), '🏠 Меню на экране')
    }
    assert.equal(mock.answers.length, 3)
  })
})

test('callback askhint/newhint/noop: подсказки без действий', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'askhint'), callbackUpdate(2, 'newhint'), callbackUpdate(3, 'noop')],
      until: ({ mock }) => mock.answers.length >= 3,
    })
    assert.match(mock.answers[0].text, /Отправьте \/ask/)
    assert.match(mock.answers[1].text, /Отправьте \/new/)
    assert.match(mock.answers[2].text, /Обновите/)
  })
})

test('чужой пользователь: callback получает отказ, действие не выполняется', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { mock, state } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      seed: { allowedUserIds: ['999'], allowedChatIds: ['999'] },
      updates: [callbackUpdate(1, 'use:1')],
      until: ({ mock }) => mock.answers.length > 0,
    })
    assert.match(mock.answers[0].text, /⛔ Нет доступа/)
    assert.equal(mock.edits.length, 0)
    assert.equal(controller.calls.list.length, 0)
    assert.equal(state.currentSession, null)
  })
})

test('группа: сообщение и callback отклоняются по умолчанию', async () => {
  await withTempInbox(async dir => {
    const group = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1763800000,
        from: { id: 555, first_name: 'Иван' },
        chat: { id: -100123, type: 'group', title: 'Группа' },
        text: '/help',
      },
    }
    const controller = mockController()
    const { mock, state } = await runUpdates(dir, {
      controller,
      query: mockQuery(),
      seed: { allowedUserIds: ['555'], allowedChatIds: ['555'] },
      updates: [group],
      until: ({ mock }) => mock.sent.length > 0,
    })
    assert.match(mock.sent[0].text, /Группы запрещены/)
    assert.equal(controller.calls.list.length, 0)
    assert.equal(state.messages.every(message => message.blocked === true), true)
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
      seed: { pendingLists: { [CHAT]: ['s-new'] } },
      updates: [callbackUpdate(1, 'use:1'), messageUpdate(2, '/help')],
      telegramOverrides: {
        answerCallbackQuery: () => telegramError(400, 'Bad Request: query is too old', 400),
      },
      until: ({ mock }) => mock.edits.length > 0 && mock.sent.some(message => /✅ Принято/.test(message.text)),
    })
    assert.match(mock.edits[0].text, /Сессия выбрана/)
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
    assert.ok(mock.sent.some(message => /Входящие: приём/.test(message.text)), 'резервное сообщение отправлено')
  })
})

test('400 message is not modified игнорируется без дубля', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [callbackUpdate(1, 'menu')],
      telegramOverrides: {
        editMessageText: () => telegramError(400, 'Bad Request: message is not modified', 400),
      },
      until: ({ mock }) => mock.edits.length > 0,
      waitMs: 2000,
    })
    await sleep(150)
    assert.equal(mock.edits.length, 1)
    assert.equal(mock.sent.length, 0, 'дубля сообщения нет')
  })
})

test('deep link /start <id> выбирает сессию', async () => {
  await withTempInbox(async dir => {
    const { mock } = await runUpdates(dir, {
      controller: mockController(),
      query: mockQuery(),
      updates: [messageUpdate(1, '/start s-old')],
      until: ({ mock }) => mock.sent.length > 0,
    })
    assert.match(mock.sent[0].text, /Сессия выбрана/)
  })
})

test('menu refresh route: принудительный setMyCommands', async () => {
  await withTempInbox(async dir => {
    await seedState(dir)
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, MENU_REFRESH_PATH, { force: true })
      assert.equal(payload.ok, true)
      assert.equal(mock.myCommands.length, 1)
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})
