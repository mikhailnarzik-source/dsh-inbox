import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COMMANDS, executeCommand, parseIncoming } from '../lib/commands.mjs'
import { createSessionsGateway } from '../lib/sessions.mjs'
import { emptyState } from '../lib/storage.mjs'

/** A mock `sessionController`. */
function mockController(options = {}) {
  const calls = { list: [], resolveAgent: [], prompt: [], cancel: [], create: [] }
  return {
    calls,
    async list() {
      calls.list.push(true)
      return { items: options.items ?? [
        { sessionId: 's-1', updatedAt: 2000, running: true, agentAvailable: true, blank: false, projections: { values: { title: 'Первая' } } },
        { sessionId: 's-2', updatedAt: 1000, running: false, agentAvailable: true, blank: false, projections: { values: { title: 'Вторая' } } },
        { sessionId: 's-sub', updatedAt: 3000, running: false, agentAvailable: true, origin: 'subagent' },
      ] }
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId)
      if (options.resolveError !== undefined) return { error: options.resolveError }
      return { agent: { status: 'idle' } }
    },
    async prompt(request) {
      calls.prompt.push(request)
      if (options.promptAccepted === false) return { accepted: false }
      return { accepted: true }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    async create(request) {
      calls.create.push(request)
      return { sessionId: options.newSessionId ?? 's-new' }
    },
  }
}

/** A mock `sessionQuery`. */
function mockQuery() {
  return {
    async listSessions() {
      return [
        { header: { id: 's-cold', createdAt: 500 } },
        { header: { id: 's-sub-cold', createdAt: 400, origin: 'subagent' } },
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

/** Build the gateway and a deps object over one mutable state. */
function setup(options = {}) {
  const hasController = 'controller' in options
  const controller = hasController ? options.controller : mockController(options.controllerOptions)
  const query = options.query === undefined ? mockQuery() : options.query
  const sessions = createSessionsGateway({
    getController: () => controller,
    getQuery: () => query,
    newRequestId: () => 'request-1',
  })
  let state = options.state ?? emptyState()
  const deps = {
    getState: () => state,
    save: async patch => {
      state = { ...state, ...patch }
    },
    sessions,
    statusInfo: () => ({ polling: true, lastError: '' }),
    maxSessions: 10,
  }
  return { controller, sessions, deps, state: () => state }
}

/** Execute one command through the public entry point. */

test('parseIncoming: команды, @упоминание бота, обычный текст и мусор', () => {
  assert.deepEqual(parseIncoming('/help'), { command: 'help', args: '', explicit: true })
  assert.deepEqual(parseIncoming('/HELP'), { command: 'help', args: '', explicit: true })
  assert.deepEqual(parseIncoming('/help@my_bot'), { command: 'help', args: '', explicit: true })
  assert.deepEqual(parseIncoming('/use 2'), { command: 'use', args: '2', explicit: true })
  assert.deepEqual(parseIncoming('/ask@my_bot  привет  мир '), { command: 'ask', args: 'привет  мир', explicit: true })
  assert.deepEqual(parseIncoming('привет'), { command: 'ask', args: 'привет', explicit: false })
  assert.deepEqual(parseIncoming('  '), { command: 'ask', args: '', explicit: false })
  assert.deepEqual(parseIncoming('/wat'), { command: 'unknown', args: 'wat', explicit: true })
  assert.deepEqual(parseIncoming('/'), { command: 'unknown', args: '/', explicit: true })
  assert.deepEqual(COMMANDS.includes('sessions'), true)
})

test('/help: возвращает шпаргалку', async () => {
  const { deps } = setup()
  const result = await executeCommand({ command: 'help', args: '', chatId: '555', deps })
  assert.match(result.summary, /справка/)
  assert.match(result.details, /\/sessions/)
  assert.match(result.details, /\/use N/)
  assert.match(result.details, /\/ask <текст>/)
})

test('/status: состояние бота и текущей сессии', async () => {
  const { deps, state } = setup({ state: { ...emptyState(), allowedChatIds: ['555'], currentChatSession: { 555: 's-1' } } })
  assert.equal(state().currentChatSession['555'], 's-1')
  const result = await executeCommand({ command: 'status', args: '', chatId: '555', deps })
  assert.match(result.details, /приём включён/)
  assert.match(result.details, /Белый список: 1 чатов/)
  assert.match(result.details, /«Первая»/)
  assert.match(result.details, /управление сессиями доступно/)
})

test('/sessions: сохраняет пронумерованный список без субагентов', async () => {
  const { deps, state } = setup({ state: { ...emptyState(), allowedChatIds: ['555'] } })
  const result = await executeCommand({ command: 'sessions', args: '', chatId: '555', deps })
  assert.match(result.summary, /сессий: 3/)
  assert.match(result.details, /1\) Первая — выполняется/)
  assert.match(result.details, /2\) Вторая — ожидает/)
  assert.match(result.details, /3\) Заголовок s-cold — ожидает/)
  assert.deepEqual(state().pendingLists['555'], ['s-1', 's-2', 's-cold'])
})

test('/use: выбирает сессию из последнего списка', async () => {
  const { deps, state } = setup({
    state: { ...emptyState(), allowedChatIds: ['555'], pendingLists: { 555: ['s-1', 's-2'] } },
  })
  const result = await executeCommand({ command: 'use', args: '2', chatId: '555', deps })
  assert.match(result.summary, /текущая сессия/)
  assert.match(result.summary, /Заголовок s-2/)
  assert.equal(state().currentChatSession['555'], 's-2')
})

test('/use: ошибки пустого списка, номера и нечислового аргумента', async () => {
  const empty = setup({ state: { ...emptyState(), allowedChatIds: ['555'] } })
  await assert.rejects(
    () => executeCommand({ command: 'use', args: '1', chatId: '555', deps: empty.deps }),
    /Список сессий ещё не загружен/,
  )
  const withList = setup({ state: { ...emptyState(), pendingLists: { 555: ['s-1'] } } })
  await assert.rejects(
    () => executeCommand({ command: 'use', args: '2', chatId: '555', deps: withList.deps }),
    /от 1 до 1/,
  )
  await assert.rejects(
    () => executeCommand({ command: 'use', args: 'abc', chatId: '555', deps: withList.deps }),
    /от 1 до 1/,
  )
})

test('/ask, /steer и обычный текст: prompt в текущую сессию', async () => {
  const { controller, deps } = setup({ state: { ...emptyState(), currentChatSession: { 555: 's-1' } } })
  const ask = await executeCommand({ command: 'ask', args: 'текст', chatId: '555', deps })
  assert.match(ask.summary, /очередь/)
  const steer = await executeCommand({ command: 'steer', args: 'быстро', chatId: '555', deps })
  assert.match(steer.summary, /вклинино/)
  assert.deepEqual(controller.calls.prompt[0], {
    requestId: 'request-1',
    sessionId: 's-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'текст' }],
  })
  assert.equal(controller.calls.prompt[1].mode, 'steer')
})

test('/ask: пустой текст и отсутствие сессии — понятные ошибки', async () => {
  const { deps } = setup({ state: { ...emptyState() } })
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: '   ', chatId: '555', deps }),
    /Укажите текст/,
  )
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: 'привет', chatId: '555', deps }),
    /Сессия не выбрана/,
  )
})

test('/new: создаёт сессию, привязывает чат и ставит сообщение в очередь', async () => {
  const { controller, deps, state } = setup({ controllerOptions: { newSessionId: 's-created' } })
  const result = await executeCommand({ command: 'new', args: 'сделай', chatId: '555', deps })
  assert.match(result.summary, /создана сессия/)
  assert.match(result.summary, /s-create/)
  assert.equal(controller.calls.create.length, 1)
  assert.equal(controller.calls.prompt[0].sessionId, 's-created')
  assert.equal(state().currentChatSession['555'], 's-created')
  await assert.rejects(
    () => executeCommand({ command: 'new', args: '', chatId: '555', deps }),
    /Укажите текст/,
  )
})

test('/cancel: отменяет текущую сессию', async () => {
  const { controller, deps } = setup({ state: { ...emptyState(), currentChatSession: { 555: 's-2' } } })
  const result = await executeCommand({ command: 'cancel', args: '', chatId: '555', deps })
  assert.match(result.summary, /отмена запрошена/)
  assert.deepEqual(controller.calls.cancel[0], { sessionId: 's-2' })
  await assert.rejects(
    () => executeCommand({ command: 'cancel', args: '', chatId: '555', deps: setup().deps }),
    /Сессия не выбрана/,
  )
})

test('/last: последние 5 сообщений истории', async () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({
    chatId: '555',
    chatTitle: 'Иван',
    from: 'Иван',
    text: `сообщение ${index}`,
    at: '2026-11-22T10:00:00.000Z',
    direction: index % 2 === 0 ? 'in' : 'out',
  }))
  const { deps } = setup({ state: { ...emptyState(), messages } })
  const result = await executeCommand({ command: 'last', args: '', chatId: '555', deps })
  assert.match(result.summary, /5 из 7/)
  assert.match(result.details, /сообщение 6/)
  assert.ok(!result.details.includes('сообщение 0'))
  const empty = await executeCommand({ command: 'last', args: '', chatId: '555', deps: setup().deps })
  assert.match(empty.summary, /История «Входящих» пуста/)
})

test('resolveAgent: ошибки превращаются в русские причины', async () => {
  const notFound = setup({
    controllerOptions: { resolveError: { code: 'session/not-found', message: 'not found' } },
    state: { ...emptyState(), currentChatSession: { 555: 's-x' } },
  })
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: 'привет', chatId: '555', deps: notFound.deps }),
    /Сессия не найдена/,
  )
  const busy = setup({
    controllerOptions: { resolveError: { code: 'session/agent-busy', message: 'busy' } },
    state: { ...emptyState(), currentChatSession: { 555: 's-x' } },
  })
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: 'привет', chatId: '555', deps: busy.deps }),
    /субагент/,
  )
  const held = setup({
    controllerOptions: { resolveError: { code: 'session/writer-held', message: 'held' } },
    state: { ...emptyState(), currentChatSession: { 555: 's-x' } },
  })
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: 'привет', chatId: '555', deps: held.deps }),
    /другой писатель/,
  )
})

test('prompt: DSH не принял сообщение — понятная ошибка', async () => {
  const { deps } = setup({
    controllerOptions: { promptAccepted: false },
    state: { ...emptyState(), currentChatSession: { 555: 's-1' } },
  })
  await assert.rejects(
    () => executeCommand({ command: 'ask', args: 'привет', chatId: '555', deps }),
    /не принял сообщение/,
  )
})

test('без sessionController: /sessions и /new дают понятную причину', async () => {
  const { deps } = setup({ controller: undefined })
  await assert.rejects(
    () => executeCommand({ command: 'sessions', args: '', chatId: '555', deps }),
    /sessionController не найден/,
  )
  await assert.rejects(
    () => executeCommand({ command: 'new', args: 'текст', chatId: '555', deps }),
    /sessionController не найден/,
  )
  const status = await executeCommand({ command: 'status', args: '', chatId: '555', deps })
  assert.match(status.details, /sessionController не найден/)
  const help = await executeCommand({ command: 'help', args: '', chatId: '555', deps })
  assert.match(help.details, /Команды бота/)
})

test('неизвестная команда: ошибка с подсказкой', async () => {
  const { deps } = setup()
  await assert.rejects(
    () => executeCommand({ command: 'unknown', args: 'wat', chatId: '555', deps }),
    /Неизвестная команда «\/wat»/,
  )
})

test('createSessionsGateway: list/describe/resolve/prompt/cancel/create', async () => {
  const { controller, sessions } = setup()
  const rows = await sessions.list({ limit: 10 })
  assert.deepEqual(rows.map(row => row.sessionId), ['s-1', 's-2', 's-cold'])
  assert.equal(rows[0].title, 'Первая')
  assert.equal(rows[2].title, 'Заголовок s-cold')
  const described = await sessions.describe('s-1')
  assert.deepEqual(described, { sessionId: 's-1', title: 'Первая', running: true })
  assert.equal(sessions.available(), true)
  const resolved = await sessions.resolve('s-1')
  assert.equal(resolved.status, 'idle')
  const prompted = await sessions.prompt({ sessionId: 's-1', mode: 'queue', text: 'привет' })
  assert.deepEqual(prompted, { accepted: true })
  assert.equal(controller.calls.prompt.at(-1).requestId, 'request-1')
  const cancelled = await sessions.cancel('s-1')
  assert.deepEqual(cancelled, { accepted: true })
  const created = await sessions.create({})
  assert.deepEqual(created, { sessionId: 's-new' })
})
