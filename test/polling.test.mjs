import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_PAUSE_MS,
  FIRST_ERROR_DELAY_MS,
  MAX_ERROR_DELAY_MS,
  NO_TOKEN_DELAY_MS,
  createPoller,
  nextBackoff,
  wait,
} from '../lib/polling.mjs'
import { TelegramError } from '../lib/telegram.mjs'
import { emptyState } from '../lib/storage.mjs'
import { sleep, waitFor } from './helpers.mjs'

test('nextBackoff: 1 с, удвоение и потолок 30 с', () => {
  assert.equal(FIRST_ERROR_DELAY_MS, 1000)
  assert.equal(MAX_ERROR_DELAY_MS, 30000)
  assert.equal(nextBackoff(undefined), 1000)
  assert.equal(nextBackoff(0), 1000)
  assert.equal(nextBackoff(1000), 2000)
  assert.equal(nextBackoff(2000), 4000)
  assert.equal(nextBackoff(8000), 16000)
  assert.equal(nextBackoff(16000), 30000)
  assert.equal(nextBackoff(30000), 30000)
})

test('wait: завершается по таймауту и по отмене', async () => {
  const started = Date.now()
  await wait(40)
  assert.ok(Date.now() - started >= 25, 'пауза выдержана')

  const controller = new AbortController()
  const early = Date.now()
  const pending = wait(5000, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await pending
  assert.ok(Date.now() - early < 1000, 'отмена прерывает паузу')

  const aborted = new AbortController()
  aborted.abort()
  await wait(5000, aborted.signal)
})

test('createPoller: принимает updates, сохраняет offset и останавливается на 401', async () => {
  let state = emptyState()
  const updates = [
    {
      update_id: 7,
      message: { message_id: 1, date: 1763800000, from: { id: 555, first_name: 'Иван' }, chat: { id: 555, type: 'private', first_name: 'Иван' }, text: 'Привет' },
    },
    {
      update_id: 8,
      message: { message_id: 2, date: 1763800001, from: { id: 555, first_name: 'Иван' }, chat: { id: 555, type: 'private', first_name: 'Иван' }, text: 'Второе' },
    },
  ]
  let calls = 0
  const tokens = []
  const telegram = {
    setToken(next) {
      tokens.push(next)
    },
    async getUpdates(options) {
      calls += 1
      assert.ok(Number.isFinite(options.offset))
      if (calls === 1) return updates
      throw new TelegramError('Telegram: Unauthorized', { status: 401, code: 'api' })
    },
  }
  const persisted = []
  const poller = createPoller({
    getToken: async () => '123456789:AAfake',
    getState: () => state,
    update: (patch, options) => {
      state = { ...state, ...patch }
      if (options?.persist === true) persisted.push({ ...patch })
    },
    getTelegram: () => telegram,
  })
  try {
    poller.start()
    assert.equal(poller.running, true)
    const stopped = await waitFor(() => poller.running === false, 2000)
    assert.equal(stopped, true, 'опрос остановился после 401')
    assert.equal(state.offset, 9)
    assert.equal(state.messages.length, 2)
    assert.equal(state.messages[1].text, 'Второе')
    assert.equal(state.enabled, false)
    assert.equal(state.lastError, 'токен не принят')
    assert.equal(tokens.length >= 1, true, 'клиент получил токен')
    assert.equal(tokens.every(token => token === '123456789:AAfake'), true)
    assert.ok(persisted.some(patch => patch.offset === 9), 'offset сохранён')
    assert.ok(persisted.some(patch => patch.enabled === false), 'выключение сохранено')
  } finally {
    await poller.stop()
  }
})

test('createPoller: после 401 попыток больше нет', async () => {
  let state = emptyState()
  let calls = 0
  let unauthorized = 0
  const telegram = {
    setToken() {},
    async getUpdates() {
      calls += 1
      throw new TelegramError('Telegram: Unauthorized', { status: 401, code: 'api' })
    },
  }
  const poller = createPoller({
    getToken: async () => '123456789:AAfake',
    getState: () => state,
    update: patch => {
      state = { ...state, ...patch }
    },
    getTelegram: () => telegram,
    onUnauthorized: () => {
      unauthorized += 1
    },
  })
  try {
    poller.start()
    const stopped = await waitFor(() => poller.running === false, 2000)
    assert.equal(stopped, true)
    assert.equal(calls, 1)
    assert.equal(unauthorized, 1)
    await sleep(100)
    assert.equal(calls, 1, 'лишних запросов нет')
  } finally {
    await poller.stop()
  }
})

test('createPoller: без токена ждёт и пишет подсказку, а не падает', async () => {
  let state = emptyState()
  const delays = []
  const poller = createPoller({
    getToken: async () => '',
    getState: () => state,
    update: patch => {
      state = { ...state, ...patch }
    },
    getTelegram: () => {
      throw new Error('клиент не должен вызываться без токена')
    },
    sleep: async ms => {
      delays.push(ms)
      void poller.stop()
    },
  })
  try {
    poller.start()
    const stopped = await waitFor(() => poller.running === false, 2000)
    assert.equal(stopped, true)
    assert.deepEqual(delays, [NO_TOKEN_DELAY_MS])
    assert.equal(state.lastError, 'токен не сохранён')
  } finally {
    await poller.stop()
  }
})

test('createPoller: после ошибки пауза растёт по backoff', async () => {
  let state = emptyState()
  const delays = []
  let calls = 0
  const telegram = {
    setToken() {},
    async getUpdates() {
      calls += 1
      if (calls > 3) throw new TelegramError('Telegram: Unauthorized', { status: 401, code: 'api' })
      throw new TelegramError('Не удалось связаться с Telegram', { code: 'network' })
    },
  }
  const poller = createPoller({
    getToken: async () => '123456789:AAfake',
    getState: () => state,
    update: patch => {
      state = { ...state, ...patch }
    },
    getTelegram: () => telegram,
    sleep: async ms => {
      delays.push(ms)
    },
  })
  try {
    poller.start()
    const stopped = await waitFor(() => poller.running === false, 2000)
    assert.equal(stopped, true)
    assert.deepEqual(delays.slice(0, 3), [1000, 2000, 4000])
    assert.equal(EMPTY_PAUSE_MS > 0, true)
  } finally {
    await poller.stop()
  }
})

test('createPoller: stop завершает цикл, start после stop снова работает', async () => {
  let state = emptyState()
  let released = false
  const telegram = {
    setToken() {},
    async getUpdates() {
      await new Promise(resolve => {
        released = true
        resolve()
      })
      return []
    },
  }
  const poller = createPoller({
    getToken: async () => '123456789:AAfake',
    getState: () => state,
    update: patch => {
      state = { ...state, ...patch }
    },
    getTelegram: () => telegram,
  })
  poller.start()
  await waitFor(() => released, 1000)
  await poller.stop()
  assert.equal(poller.running, false)
  poller.start()
  assert.equal(poller.running, true)
  await poller.stop()
  assert.equal(poller.running, false)
})
