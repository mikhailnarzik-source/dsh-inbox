import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  callRoute,
  fakeContext,
  sleep,
  telegramMock,
  waitFor,
  withTempInbox,
} from './helpers.mjs'
import { git } from './git-helpers.mjs'
import { createGitQueue } from '../lib/queue.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'
const CHAT = '555'
const STATE_PATH = '/api/dsh-inbox/state'
const POLLING_PATH = '/api/dsh-inbox/polling'
const LISTENER_PATH = '/api/dsh-inbox/queue/listener'
const SYNC_PATH = '/api/dsh-inbox/queue/sync'

/** Create a bare remote for one test and prepare the environment overrides. */
async function setupQueueEnv() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inbox-qroute-'))
  const remote = join(root, 'remote.git')
  await git(['init', '--bare', '-q', remote], root)
  process.env.DSH_INBOX_QUEUE_REMOTE = remote
  process.env.DSH_INBOX_QUEUE_CLAIM_WAIT_MS = '20'
  process.env.DSH_INBOX_QUEUE_INTERVAL_MS = '80'
  return {
    root,
    remote,
    async cleanup() {
      delete process.env.DSH_INBOX_QUEUE_REMOTE
      delete process.env.DSH_INBOX_QUEUE_CLAIM_WAIT_MS
      delete process.env.DSH_INBOX_QUEUE_INTERVAL_MS
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 })
    },
  }
}

/** One text update. */
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

/** One inline-button update. */
function callbackUpdate(updateId, data, chatId = CHAT) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(chatId), first_name: 'Иван' },
      message: {
        message_id: 50,
        date: 1763800000,
        chat: { id: Number(chatId), type: 'private', first_name: 'Иван' },
      },
      data,
    },
  }
}

/** A mock `sessionController` for callback/session commands. */
function mockController() {
  return {
    async list() {
      return { items: [{ sessionId: 's-new', updatedAt: 2, running: true, agentAvailable: true, blank: false, projections: { values: { title: 'Новая сессия' } } }] }
    },
    async resolveAgent() {
      return { agent: { status: 'idle' } }
    },
    async prompt() {
      return { accepted: true }
    },
    async cancel() {
      return { accepted: true }
    },
    async create() {
      return { sessionId: 's-created' }
    },
  }
}

/** Seed the plugin state file. */
async function seedState(dir, overrides = {}) {
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 4,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedChatIds: [CHAT],
    currentChatSession: {},
    pendingLists: {},
    commandsMenu: { version: '', at: 0, ok: false },
    deviceId: '',
    queue: { listener: false },
    messages: [],
    ...overrides,
  }), 'utf8')
}

/** Wait for one file inside the queue clone. */
async function queueFiles(dir, ...parts) {
  try {
    return await readdir(join(dir, 'queue', 'inbox', ...parts))
  } catch {
    return []
  }
}

/** Read one JSON file of the queue clone. */
async function queueJson(dir, ...parts) {
  try {
    return JSON.parse(await readFile(join(dir, 'queue', 'inbox', ...parts), 'utf8'))
  } catch {
    return undefined
  }
}

test('не-слушатель не опрашивает Telegram, статус показывает очередь', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    const mock = telegramMock()
    await seedState(dir, { enabled: true })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await sleep(250)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.queue.configured, true)
      assert.equal(state.queue.listener, false)
      assert.equal(state.polling, false)
      assert.equal(mock.calls.filter(call => call.method === 'getUpdates').length, 0, 'getUpdates не вызывается')
      assert.match(state.lastError, /другое устройство|Слушать/)
      const enabled = await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(enabled.polling, false)
      assert.equal(enabled.listenerActive, false)
      await sleep(150)
      assert.equal(mock.calls.filter(call => call.method === 'getUpdates').length, 0)
      const listener = await callRoute(ctx, LISTENER_PATH, { enabled: true })
      assert.equal(listener.ok, true)
      assert.equal(listener.listener, true)
      assert.equal(listener.queue.listener, true)
      assert.equal(await waitFor(() => mock.calls.some(call => call.method === 'getUpdates')), true)
      const stateAfter = await callRoute(ctx, STATE_PATH, {})
      assert.equal(stateAfter.polling, true)
      assert.equal(stateAfter.queue.device.id.length > 0, true)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('слушатель: сообщение попадает в очередь, worker отвечает один раз', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    let calls = 0
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        return Response.json({ ok: true, result: calls === 1 ? [messageUpdate(100, '/help')] : [] })
      },
    })
    await seedState(dir, { enabled: true, queue: { listener: true } })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const done = await waitFor(async () => {
        const doneFiles = await queueFiles(dir, 'done')
        return doneFiles.length === 1 && mock.sent.some(message => /✅ Принято/.test(message.text))
      }, 8000)
      assert.equal(done, true, 'команда выполнена воркером и подтверждена')
      const commands = await queueFiles(dir, 'commands')
      assert.equal(commands.length, 1)
      const command = await queueJson(dir, 'commands', commands[0])
      assert.equal(command.text, '/help')
      assert.equal(command.chatId, CHAT)
      assert.equal(command.botId, '123456789')
      const offsets = await queueFiles(dir, 'offset')
      assert.equal(offsets.length, 1)
      const offset = await queueJson(dir, 'offset', offsets[0])
      assert.equal(offset.offset, 101)
      await sleep(300)
      assert.equal(mock.sent.filter(message => /✅ Принято/.test(message.text)).length, 1, 'ответ один')
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('слушатель: callback попадает в очередь, выполняется и редактирует сообщение', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    let calls = 0
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        return Response.json({ ok: true, result: calls === 1 ? [callbackUpdate(200, 'use:s-new')] : [] })
      },
    })
    await seedState(dir, { enabled: true, queue: { listener: true } })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN, controller: mockController() })
    module.apply(ctx)
    try {
      const done = await waitFor(async () => {
        const doneFiles = await queueFiles(dir, 'done')
        return doneFiles.length === 1 && mock.edits.length > 0
      }, 8000)
      assert.equal(done, true, 'callback выполнен')
      const commands = await queueFiles(dir, 'commands')
      const command = await queueJson(dir, 'commands', commands[0])
      assert.equal(command.callback.data, 'use:s-new')
      assert.equal(command.callback.callbackId, 'cb-200')
      assert.equal(mock.answers.length >= 2, true, 'ответ на callback и от исполнителя')
      assert.match(mock.edits[0].text, /Сессия выбрана/)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('queue/sync и state показывают счётчики; инструмент описывает очередь', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    const mock = telegramMock()
    await seedState(dir)
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const sync = await callRoute(ctx, SYNC_PATH, {})
      assert.equal(sync.ok, true, sync.message)
      assert.equal(sync.queue.configured, true)
      assert.deepEqual(sync.queue.counts, { total: 0, new: 0, inProgress: 0, done: 0 })
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.queue.mode, 'queue')
      assert.equal(state.queue.branch, 'inbox')
      assert.equal(state.device.id, state.queue.device.id)
      const tool = ctx.toolsList.find(item => item.name === 'telegram_queue_status')
      const text = await tool.execute({})
      assert.match(text, /Общая очередь команд: настроена/)
      assert.match(text, /Ветка: inbox/)
      assert.match(text, /Роль: исполнитель/)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('telegram_listen: включает и выключает слушателя, polling стартует и останавливается', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    const mock = telegramMock()
    await seedState(dir)
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_listen')
      const enabled = await tool.execute({ enabled: true })
      assert.match(enabled, /✅ Это устройство слушает Telegram/)
      assert.match(enabled, /Общая очередь: настроена; роль: слушает Telegram/)
      assert.equal(await waitFor(() => mock.calls.some(call => call.method === 'getUpdates'), 3000), true)
      const stateOn = await callRoute(ctx, STATE_PATH, {})
      assert.equal(stateOn.queue.listener, true)
      assert.equal(stateOn.polling, true)
      const disabled = await tool.execute({ enabled: false })
      assert.match(disabled, /⏹ Приём Telegram на этом устройстве выключен/)
      await sleep(300)
      const before = mock.calls.filter(call => call.method === 'getUpdates').length
      await sleep(400)
      const after = mock.calls.filter(call => call.method === 'getUpdates').length
      assert.equal(after, before, 'после выключения getUpdates больше не вызывается')
      const stateOff = await callRoute(ctx, STATE_PATH, {})
      assert.equal(stateOff.queue.listener, false)
      assert.equal(stateOff.polling, false)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('telegram_listen: предупреждает про 409, если слушает другое устройство', async () => {
  await withTempInbox(async dir => {
    const env = await setupQueueEnv()
    const mock = telegramMock()
    await seedState(dir)
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      // Another device publishes itself as the listener.
      const other = createGitQueue({
        dir: join(env.root, 'clone-other'),
        remoteUrl: env.remote,
        device: { id: 'device-other', name: 'Другой ПК' },
        claimWaitMs: 20,
      })
      await other.updateStatus({ listener: true, lastSyncAt: Date.now(), lastError: '', version: '0.5.0' })
      const sync = await callRoute(ctx, SYNC_PATH, {})
      assert.equal(sync.ok, true)
      const tool = ctx.toolsList.find(item => item.name === 'telegram_listen')
      const text = await tool.execute({ enabled: true })
      assert.match(text, /Другой ПК/)
      assert.match(text, /409/)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      await env.cleanup()
    }
  })
})

test('без remote команды выполняются inline (совместимость 0.3)', async () => {
  await withTempInbox(async dir => {
    const mock = telegramMock({
      getUpdates: (() => {
        let calls = 0
        return () => {
          calls += 1
          return Response.json({ ok: true, result: calls === 1 ? [messageUpdate(300, '/help')] : [] })
        }
      })(),
    })
    await seedState(dir, { enabled: true, queue: { listener: true } })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const ack = await waitFor(() => mock.sent.some(message => /✅ Принято/.test(message.text)), 5000)
      assert.equal(ack, true)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.queue.configured, false)
      assert.equal(state.queue.mode, 'inline')
      assert.equal(state.queue.listener, true)
      assert.equal(await queueFiles(dir, 'commands').then(files => files.length), 0, 'git-очередь не создаётся')
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})
