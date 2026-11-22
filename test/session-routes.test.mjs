import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  callRoute,
  fakeContext,
  sleep,
  telegramMock,
  waitFor,
  withTempInbox,
} from './helpers.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'
const CHAT = '555'
const PROJECT = process.cwd()
const STATE_PATH = '/api/dsh-inbox/state'
const POLLING_PATH = '/api/dsh-inbox/polling'

/** One Telegram update with a text message from the allowed chat. */
function update(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1763800000,
      from: { id: Number(CHAT), first_name: 'Иван', username: 'ivan' },
      chat: { id: Number(CHAT), type: 'private', first_name: 'Иван', username: 'ivan' },
      text,
    },
  }
}

/** A mock `sessionController` with just the methods the bot uses. */
function mockController(options = {}) {
  const calls = { list: [], resolveAgent: [], prompt: [], cancel: [], create: [] }
  return {
    calls,
    async list(request, signal) {
      calls.list.push(request)
      return {
        items: options.items ?? [
          { sessionId: 's-old', updatedAt: 1000, running: false, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Старая сессия' } } },
          { sessionId: 's-new', updatedAt: 2000, running: true, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Новая сессия' } } },
          { sessionId: 's-sub', updatedAt: 3000, running: false, agentAvailable: true, origin: 'subagent', cwd: PROJECT, projections: { values: { title: 'Сабагент' } } },
        ],
      }
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId)
      if (options.resolveError !== undefined) return { error: options.resolveError }
      return { agent: { status: options.status ?? 'idle', session: { header: { id: sessionId } } } }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    async create(request) {
      calls.create.push(request)
      return { sessionId: options.newSessionId ?? 's-created' }
    },
  }
}

/** A mock `sessionQuery` with one cold session and titles. */
function mockQuery() {
  return {
    async listSessions() {
      return [
        { header: { id: 's-cold', createdAt: 500, cwd: PROJECT } },
        { header: { id: 's-sub-2', createdAt: 400, origin: 'subagent', cwd: PROJECT } },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: { title: `Заголовок ${id}` } },
      }))
    },
  }
}

/** Seed the state file. */
async function seed(dir, options = {}) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 5,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedUserIds: [CHAT],
    allowedChatIds: [CHAT],
    currentChatSession: options.chatSession === undefined ? {} : { [CHAT]: options.chatSession },
    pendingLists: options.pendingLists ?? {},
    security: { groupsEnabled: false },
    messages: [],
  }), 'utf8')
}

/**
 * Enable polling, feed one batch and wait for `expected` stored messages.
 * `onReady` runs before disposal and can emit session events.
 */
async function runBatch(dir, options = {}) {
  await seed(dir, options)
  let calls = 0
  const updates = (options.texts ?? []).map((text, index) => update(1000 + index, text))
  const mock = telegramMock({
    getUpdates: () => {
      calls += 1
      if (calls === 1) return Response.json({ ok: true, result: updates })
      return Response.json({ ok: true, result: [] })
    },
    ...options.telegramOverrides,
  })
  const module = await import('../index.js')
  const ctx = fakeContext({ token: options.token ?? TOKEN, controller: options.controller, query: options.query })
  module.apply(ctx)
  try {
    await callRoute(ctx, POLLING_PATH, { enabled: true })
    const expected = Number.isFinite(options.expected) ? options.expected : (options.texts ?? []).length * 2
    if (expected > 0) {
      const done = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return state.totalMessages >= expected
      }, 6000)
      assert.equal(done, true, `история: ожидалось ${expected} сообщений`)
    } else {
      await sleep(80)
    }
    if (typeof options.onReady === 'function') await options.onReady({ ctx, mock })
    await sleep(150)
    const state = await callRoute(ctx, STATE_PATH, {})
    await callRoute(ctx, POLLING_PATH, { enabled: false })
    return { ctx, mock, state, sent: mock.sent, edits: mock.edits }
  } finally {
    await ctx.disposeAll()
    mock.restore()
  }
}

test('/sessions: только проект, без субагентов, пагинация и короткие callback', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const query = mockQuery()
    const { sent } = await runBatch(dir, { controller, query, texts: ['/sessions'] })
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /сессий: 3/)
    assert.match(sent[0].text, /1\. Новая сессия — выполняется/)
    assert.match(sent[0].text, /2\. Старая сессия — ожидает/)
    assert.match(sent[0].text, /3\. Заголовок s-cold — ожидает/)
    assert.ok(!sent[0].text.includes('Сабагент'), 'субагент исключён')
    const buttons = sent[0].reply_markup.inline_keyboard.flat()
    assert.deepEqual(
      buttons.filter(button => button.callback_data.startsWith('use:')).map(button => button.callback_data),
      ['use:1', 'use:2', 'use:3'],
    )
    assert.ok(buttons.some(button => button.callback_data === 'sessions:1') === false)
    assert.ok(buttons.some(button => button.callback_data === 'refresh:1'))
    assert.ok(buttons.some(button => button.callback_data === 'menu'))
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.deepEqual(file.pendingLists[CHAT], ['s-new', 's-old', 's-cold'])
  })
})

test('/sessions фильтрует сессии других проектов и пустые', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({
      items: [
        { sessionId: 's-here', updatedAt: 3000, running: false, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Наш проект' } } },
        { sessionId: 's-other', updatedAt: 2000, running: false, agentAvailable: true, blank: false, cwd: 'D:/OtherProject', projections: { values: { title: 'Чужой проект' } } },
        { sessionId: 's-blank', updatedAt: 1000, running: false, agentAvailable: true, blank: true, cwd: PROJECT, projections: { values: { title: 'Пустая' } } },
      ],
    })
    const { sent } = await runBatch(dir, { controller, query: { async listSessions() { return [] }, async readTitleSnapshots() { return [] } }, texts: ['/sessions'] })
    assert.match(sent[0].text, /Наш проект/)
    assert.ok(!sent[0].text.includes('Чужой проект'))
    assert.ok(!sent[0].text.includes('Пустая'))
    assert.match(sent[0].text, /сессий: 1/)
  })
})

test('/sessions all: показывает все не-subagent сессии', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({
      items: [
        { sessionId: 's-here', updatedAt: 3000, running: false, agentAvailable: true, blank: false, cwd: PROJECT, projections: { values: { title: 'Наш проект' } } },
        { sessionId: 's-other', updatedAt: 2000, running: false, agentAvailable: true, blank: false, cwd: 'D:/OtherProject', projections: { values: { title: 'Чужой проект' } } },
      ],
    })
    const { sent } = await runBatch(dir, { controller, query: { async listSessions() { return [] }, async readTitleSnapshots() { return [] } }, texts: ['/sessions all'] })
    assert.match(sent[0].text, /Все сессии DSH/)
    assert.match(sent[0].text, /Чужой проект/)
    assert.match(sent[0].text, /сессий: 2/)
  })
})

test('пагинация: 5 на страницу и ◀/▶', async () => {
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
    const controller = mockController({ items })
    const { sent } = await runBatch(dir, { controller, query: { async listSessions() { return [] }, async readTitleSnapshots() { return [] } }, texts: ['/sessions'] })
    assert.equal(sent[0].reply_markup.inline_keyboard.filter(row => row.length === 1 && row[0].callback_data.startsWith('use:')).length, 5)
    const nav = sent[0].reply_markup.inline_keyboard.find(row => row.some(button => button.callback_data === 'sessions:2'))
    assert.ok(nav, 'кнопка следующей страницы')
  })
})

test('/use N: запоминает сессию для чата', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, { controller, query: mockQuery(), texts: ['/sessions', '/use 1'] })
    assert.equal(sent.length, 2)
    assert.match(sent[1].text, /✅ Принято/)
    assert.match(sent[1].text, /текущая сессия/)
    assert.match(sent[1].text, /s-new/)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(file.currentChatSession[CHAT], 's-new')
  })
})

test('/ask: «⏳ Думаю…», prompt mode=queue и ответ по turn/end', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent, edits, mock } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-new',
      texts: ['/ask собери отчёт'],
      expected: 1,
      onReady: async ({ ctx, mock }) => {
        await waitFor(() => mock.sent.some(message => message.text === '⏳ Думаю…'), 4000)
        assert.equal(mock.actions.length >= 1, true, 'sendChatAction typing')
        ctx.emit('session/event', { id: 's-new' }, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'Готово: отчёт собран.' }] } },
        })
        ctx.emit('session/event', { id: 's-new' }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } })
        await waitFor(() => mock.edits.length > 0, 3000)
      },
    })
    assert.equal(sent[0].text, '⏳ Думаю…')
    assert.equal(controller.calls.prompt.length, 1)
    assert.deepEqual(controller.calls.prompt[0], {
      requestId: controller.calls.prompt[0].requestId,
      sessionId: 's-new',
      mode: 'queue',
      content: [{ type: 'text', text: 'собери отчёт' }],
    })
    assert.equal(edits.length, 1)
    assert.match(edits[0].text, /Готово: отчёт собран/)
  })
})

test('обычный текст без команды: тот же путь /ask', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-new',
      texts: ['просто текст'],
      expected: 1,
    })
    assert.equal(sent[0].text, '⏳ Думаю…')
    assert.equal(controller.calls.prompt[0].content[0].text, 'просто текст')
    assert.equal(controller.calls.prompt[0].mode, 'queue')
  })
})

test('/steer: prompt mode=steer и «⏳ Думаю…»', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-old',
      texts: ['/steer быстрее'],
      expected: 1,
    })
    assert.equal(sent[0].text, '⏳ Думаю…')
    assert.equal(controller.calls.prompt[0].mode, 'steer')
    assert.equal(controller.calls.prompt[0].sessionId, 's-old')
  })
})

test('/new: создаёт сессию, «Думаю…» и ответ приходит из новой сессии', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({ newSessionId: 's-created' })
    const { sent, edits } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      texts: ['/new сделай задачу'],
      expected: 1,
      onReady: async ({ ctx, mock }) => {
        await waitFor(() => mock.sent.some(message => message.text === '⏳ Думаю…'), 4000)
        ctx.emit('session/event', { id: 's-created' }, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'Задача принята.' }] } },
        })
        ctx.emit('session/event', { id: 's-created' }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } })
        await waitFor(() => mock.edits.length > 0, 3000)
      },
    })
    assert.equal(sent[0].text, '⏳ Думаю…')
    assert.equal(controller.calls.create.length, 1)
    assert.equal(controller.calls.prompt[0].sessionId, 's-created')
    assert.match(edits.at(-1).text, /Задача принята/)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(file.currentChatSession[CHAT], 's-created')
  })
})

test('/cancel: отменяет текущую сессию', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-new',
      texts: ['/cancel'],
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /отмена запрошена/)
    assert.deepEqual(controller.calls.cancel[0], { sessionId: 's-new' })
  })
})

test('/status, /help и /settings: меню-экраны с «🏠 Меню»', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-new',
      texts: ['/status', '/help', '/settings'],
      expected: 6,
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /Текущая сессия для чата/)
    assert.match(sent[0].text, /Новая сессия/)
    assert.match(sent[0].text, /Белый список: 1 чатов/)
    assert.match(sent[1].text, /✅ Принято/)
    assert.match(sent[1].text, /\/use N/)
    assert.match(sent[1].text, /\/new <текст>/)
    assert.match(sent[2].text, /Настройки «Входящих»/)
    assert.match(sent[2].text, /Владелец:/)
    for (const message of sent) {
      const buttons = message.reply_markup?.inline_keyboard?.flat() ?? []
      assert.ok(buttons.some(button => button.callback_data === 'menu'), 'кнопка «🏠 Меню»')
    }
  })
})

test('/last: печатает последние сообщения истории', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      texts: ['/last'],
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /сообщений: 1 из 1/)
    assert.match(sent[0].text, /\/last/)
  })
})

test('ошибка resolveAgent: «⏳ Думаю…» становится ошибкой', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({
      resolveError: { code: 'session/not-found', message: 'session not found' },
    })
    const { sent, edits } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-missing',
      texts: ['/ask привет'],
      expected: 1,
    })
    assert.equal(sent[0].text, '⏳ Думаю…')
    assert.equal(edits.length, 1)
    assert.match(edits[0].text, /⚠️ Не выполнено/)
    assert.match(edits[0].text, /Сессия не найдена/)
    assert.equal(controller.calls.prompt.length, 0)
  })
})

test('/ask без выбранной сессии: ⚠️ с подсказкой /sessions', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, { controller, query: mockQuery(), texts: ['/ask привет'] })
    assert.match(sent[0].text, /⚠️ Не выполнено/)
    assert.match(sent[0].text, /Сессия не выбрана/)
    assert.equal(controller.calls.prompt.length, 0)
  })
})

test('/sessions без sessionController: ⚠️ с понятной причиной', async () => {
  await withTempInbox(async dir => {
    const { sent, state } = await runBatch(dir, { controller: undefined, query: mockQuery(), texts: ['/sessions', '/help'] })
    assert.match(sent[0].text, /⚠️ Не выполнено/)
    assert.match(sent[0].text, /sessionController не найден/)
    assert.match(sent[1].text, /✅ Принято/)
    assert.equal(state.totalMessages, 4)
  })
})

test('неизвестная команда: ⚠️ Не выполнено и подсказка /help', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, { controller, query: mockQuery(), texts: ['/wat'] })
    assert.match(sent[0].text, /⚠️ Не выполнено/)
    assert.match(sent[0].text, /Неизвестная команда/)
    assert.match(sent[0].text, /\/help/)
  })
})

test('deep link /start <sessionId> выбирает сессию', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, { controller, query: mockQuery(), texts: ['/start s-old'] })
    assert.match(sent[0].text, /Сессия выбрана/)
    assert.match(sent[0].text, /Старая сессия/)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(file.currentChatSession[CHAT], 's-old')
  })
})

test('deep link /start <нет такой> даёт ошибку', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, { controller, query: mockQuery(), texts: ['/start nope'] })
    assert.match(sent[0].text, /⚠️ Не выполнено/)
    assert.match(sent[0].text, /Сессия не найдена/)
  })
})

test('изменения сессии видны странице плагина', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { state } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      texts: ['/sessions', '/use 2'],
    })
    assert.equal(state.currentSession.sessionId, 's-old')
    assert.match(state.currentSession.title, /Старая сессия/)
    assert.equal(state.chats[0].chatId, CHAT)
    assert.equal(state.chats[0].sessionId, 's-old')
    assert.equal(state.chats[0].userId, CHAT)
  })
})
