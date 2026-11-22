import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  callRoute,
  fakeContext,
  telegramMock,
  waitFor,
  withTempInbox,
} from './helpers.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'
const CHAT = '555'
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
          { sessionId: 's-old', updatedAt: 1000, running: false, agentAvailable: true, blank: false, projections: { values: { title: 'Старая сессия' } } },
          { sessionId: 's-new', updatedAt: 2000, running: true, agentAvailable: true, blank: false, projections: { values: { title: 'Новая сессия' } } },
          { sessionId: 's-sub', updatedAt: 3000, running: false, agentAvailable: true, origin: 'subagent', projections: { values: { title: 'Сабагент' } } },
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
        { header: { id: 's-cold', createdAt: 500 } },
        { header: { id: 's-sub-2', createdAt: 400, origin: 'subagent' } },
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

/**
 * Seed the state, enable polling, send one batch of texts and wait until the
 * Inbox has stored every incoming message and every acknowledgement.
 */
async function runBatch(dir, { controller, query, texts, chatSession = null, token = TOKEN }) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 2,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedChatIds: [CHAT],
    currentChatSession: chatSession === null ? {} : { [CHAT]: chatSession },
    pendingLists: {},
    messages: [],
  }), 'utf8')
  let calls = 0
  const updates = texts.map((text, index) => update(1000 + index, text))
  const mock = telegramMock({
    getUpdates: () => {
      calls += 1
      if (calls === 1) return Response.json({ ok: true, result: updates })
      return Response.json({ ok: true, result: [] })
    },
  })
  const module = await import('../index.js')
  const ctx = fakeContext({ token, controller, query })
  module.apply(ctx)
  try {
    await callRoute(ctx, POLLING_PATH, { enabled: true })
    const expected = texts.length * 2
    const done = await waitFor(async () => {
      const state = await callRoute(ctx, STATE_PATH, {})
      return state.totalMessages >= expected
    }, 5000)
    assert.equal(done, true, `история: ожидалось ${expected} сообщений`)
    const state = await callRoute(ctx, STATE_PATH, {})
    await callRoute(ctx, POLLING_PATH, { enabled: false })
    return { ctx, mock, state, sent: mock.sent }
  } finally {
    await ctx.disposeAll()
    mock.restore()
  }
}

test('/sessions: нумерует сессии без субагентов, сохраняет pendingLists, отвечает ✅', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const query = mockQuery()
    const { sent, state } = await runBatch(dir, { controller, query, texts: ['/sessions'] })
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /сессий: 3/)
    assert.match(sent[0].text, /1\) Новая сессия — выполняется/)
    assert.match(sent[0].text, /2\) Старая сессия — ожидает/)
    assert.match(sent[0].text, /3\) Заголовок s-cold — ожидает/)
    assert.ok(!sent[0].text.includes('Сабагент'), 'субагент исключён')
    assert.equal(controller.calls.list.length >= 1, true)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.deepEqual(file.pendingLists[CHAT], ['s-new', 's-old', 's-cold'])
    assert.equal(state.messages.at(-1).direction, 'out')
  })
})

test('/use 1: запоминает сессию для чата, отвечает названием', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const query = mockQuery()
    const { sent } = await runBatch(dir, { controller, query, texts: ['/sessions', '/use 1'] })
    assert.equal(sent.length, 2)
    assert.match(sent[1].text, /✅ Принято/)
    assert.match(sent[1].text, /текущая сессия/)
    assert.match(sent[1].text, /s-new/)
    const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(file.currentChatSession[CHAT], 's-new')
  })
})

test('/ask и обычный текст: prompt mode=queue в текущую сессию', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const query = mockQuery()
    const { sent } = await runBatch(dir, {
      controller,
      query,
      chatSession: 's-new',
      texts: ['/ask собери отчёт', 'просто текст'],
    })
    assert.equal(sent.length, 2)
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /очередь/)
    assert.equal(controller.calls.prompt.length, 2)
    assert.deepEqual(controller.calls.prompt[0], {
      requestId: controller.calls.prompt[0].requestId,
      sessionId: 's-new',
      mode: 'queue',
      content: [{ type: 'text', text: 'собери отчёт' }],
    })
    assert.equal(controller.calls.prompt[1].content[0].text, 'просто текст')
    assert.equal(controller.calls.prompt[1].mode, 'queue')
    assert.equal(typeof controller.calls.prompt[1].requestId, 'string')
    assert.equal(controller.calls.resolveAgent.length, 2)
  })
})

test('/steer: prompt mode=steer', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-old',
      texts: ['/steer быстрее'],
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /вклинино/)
    assert.equal(controller.calls.prompt[0].mode, 'steer')
    assert.equal(controller.calls.prompt[0].sessionId, 's-old')
  })
})

test('/new: создаёт сессию, отправляет текст и привязывает её к чату', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({ newSessionId: 's-created' })
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      texts: ['/new сделай задачу'],
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /создана сессия/)
    assert.equal(controller.calls.create.length, 1)
    assert.deepEqual(controller.calls.prompt[0], {
      requestId: controller.calls.prompt[0].requestId,
      sessionId: 's-created',
      mode: 'queue',
      content: [{ type: 'text', text: 'сделай задачу' }],
    })
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

test('/status и /help: отдают понятный текст с ✅', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-new',
      texts: ['/status', '/help'],
    })
    assert.match(sent[0].text, /✅ Принято/)
    assert.match(sent[0].text, /Текущая сессия для чата/)
    assert.match(sent[0].text, /Новая сессия/)
    assert.match(sent[0].text, /Белый список: 1 чатов/)
    assert.match(sent[0].text, /управление сессиями доступно/)
    assert.match(sent[1].text, /✅ Принято/)
    assert.match(sent[1].text, /\/use N/)
    assert.match(sent[1].text, /\/new <текст>/)
  })
})

test('/last: печатает последние сообщения истории «Входящих»', async () => {
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

test('ошибка resolveAgent: ⚠️ Не выполнено с причиной, prompt не вызван', async () => {
  await withTempInbox(async dir => {
    const controller = mockController({
      resolveError: { code: 'session/not-found', message: 'session not found' },
    })
    const { sent } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      chatSession: 's-missing',
      texts: ['/ask привет'],
    })
    assert.match(sent[0].text, /⚠️ Не выполнено/)
    assert.match(sent[0].text, /Сессия не найдена/)
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

test('/sessions без sessionController: ⚠️ с понятной причиной, бот остаётся жив', async () => {
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

test('изменения белого списка и сессии видны странице плагина', async () => {
  await withTempInbox(async dir => {
    const controller = mockController()
    const { state } = await runBatch(dir, {
      controller,
      query: mockQuery(),
      texts: ['/sessions', '/use 2'],
    })
    assert.deepEqual(state.pendingLists, undefined, 'state route не раскрывает pendingLists')
    assert.equal(state.currentSession.sessionId, 's-old')
    assert.match(state.currentSession.title, /Старая сессия/)
    assert.equal(state.chats[0].chatId, CHAT)
    assert.equal(state.chats[0].sessionId, 's-old')
    assert.match(state.chats[0].sessionTitle, /s-old/)
  })
})
