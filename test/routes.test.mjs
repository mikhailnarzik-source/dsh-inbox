import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  callRoute,
  fakeContext,
  installFetch,
  sleep,
  telegramError,
  telegramResponse,
  waitFor,
  withTempInbox,
} from './helpers.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'
const STATE_PATH = '/api/dsh-inbox/state'
const VERIFY_PATH = '/api/dsh-inbox/verify'
const SEND_PATH = '/api/dsh-inbox/send'
const POLLING_PATH = '/api/dsh-inbox/polling'
const CLEAR_PATH = '/api/dsh-inbox/messages/clear'

/** One stored incoming message. */
const SEED = {
  version: 1,
  offset: 42,
  enabled: false,
  botUsername: '',
  messages: [{
    chatId: '555',
    chatTitle: 'Иван',
    from: 'Иван',
    text: 'Привет из Telegram',
    at: '2026-11-22T10:00:00.000Z',
    direction: 'in',
  }],
}

/** Never let a test reach the real network by accident. */
function offlineFetch() {
  return async () => {
    throw new Error('тест не должен ходить в сеть')
  }
}

test('state: без токена — configured:false, writable:true и пустая история', async () => {
  await withTempInbox(async () => {
    const previous = globalThis.fetch
    globalThis.fetch = offlineFetch()
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, STATE_PATH, {})
      assert.equal(payload.ok, true)
      assert.equal(payload.configured, false)
      assert.equal(payload.writable, true)
      assert.equal(payload.botUsername, '')
      assert.equal(payload.enabled, false)
      assert.equal(payload.polling, false)
      assert.equal(payload.lastError, '')
      assert.deepEqual(payload.messages, [])
      assert.equal(payload.totalMessages, 0)
      assert.equal(payload.maxMessages, 200)
      assert.equal(payload.lastChat, null)
    } finally {
      await ctx.disposeAll()
      globalThis.fetch = previous
    }
  })
})

test('state: токен есть, describe возвращает write-only хранилище', async () => {
  await withTempInbox(async () => {
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN, writable: false })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, STATE_PATH, {})
      assert.equal(payload.configured, true)
      assert.equal(payload.writable, false)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ state')
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('verify: getMe принят, имя бота сохраняется, токен не утекает', async () => {
  await withTempInbox(async dir => {
    const mock = installFetch(({ method }) => {
      if (method === 'getMe') return telegramResponse({ id: 1, is_bot: true, username: 'dsh_inbox_test_bot' })
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, VERIFY_PATH, {})
      assert.equal(payload.ok, true)
      assert.equal(payload.code, 'accepted')
      assert.equal(payload.botUsername, 'dsh_inbox_test_bot')
      assert.match(payload.message, /dsh_inbox_test_bot/)
      const raw = JSON.stringify(payload)
      assert.ok(!raw.includes(TOKEN), 'токен не попадает в ответ verify')

      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.botUsername, 'dsh_inbox_test_bot')
      assert.ok(!JSON.stringify(file).includes(TOKEN), 'токен не пишется в state.json')
      assert.deepEqual(mock.calls.map(call => call.method), ['getMe'])
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('verify: 401 — код rejected и понятное сообщение без токена', async () => {
  await withTempInbox(async () => {
    const mock = installFetch(({ method }) => {
      if (method === 'getMe') return telegramError(401, 'Unauthorized', 401)
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, VERIFY_PATH, {})
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'rejected')
      assert.match(payload.message, /401/)
      assert.match(payload.message, /токен/i)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ verify')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('verify: без токена отвечает missing и не ходит в сеть', async () => {
  await withTempInbox(async () => {
    globalThis.fetch = offlineFetch()
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, VERIFY_PATH, {})
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'missing')
      assert.match(payload.message, /не сохранён/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('send: отправляет в последний чат, пишет исходящее в историю, токена в ответе нет', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const mock = installFetch(({ method }) => {
      if (method === 'sendMessage') return telegramResponse({ message_id: 77, date: 1763800100, chat: { id: 555 } })
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, SEND_PATH, { chatId: 'last', text: '  Привет!  ' })
      assert.equal(payload.ok, true)
      assert.equal(payload.chatId, '555')
      assert.equal(payload.chatTitle, 'Иван')
      assert.equal(payload.messageId, 77)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ send')
      assert.equal(mock.calls.length, 1)
      assert.deepEqual(mock.calls[0].body, { chat_id: '555', text: 'Привет!' })

      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.messages.length, 2)
      assert.equal(file.messages[1].direction, 'out')
      assert.equal(file.messages[1].text, 'Привет!')
      assert.equal(file.messages[1].chatId, '555')
      assert.ok(!JSON.stringify(file).includes(TOKEN), 'токен не пишется в state.json')

      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.totalMessages, 2)
      assert.deepEqual(state.lastChat, { chatId: '555', chatTitle: 'Иван' })
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('send: пустой текст, слишком длинный текст и отсутствие чата — понятные ошибки', async () => {
  await withTempInbox(async () => {
    globalThis.fetch = offlineFetch()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const empty = await callRoute(ctx, SEND_PATH, { text: '   ' })
      assert.equal(empty.ok, false)
      assert.match(empty.message, /пуст/)

      const long = await callRoute(ctx, SEND_PATH, { text: 'а'.repeat(4097) })
      assert.equal(long.ok, false)
      assert.match(long.message, /4096/)

      const noChat = await callRoute(ctx, SEND_PATH, { text: 'привет' })
      assert.equal(noChat.ok, false)
      assert.match(noChat.message, /Нет чата/)

      const noTokenModule = await import('../index.js')
      const noTokenCtx = fakeContext()
      noTokenModule.apply(noTokenCtx)
      try {
        const missing = await callRoute(noTokenCtx, SEND_PATH, { text: 'привет' })
        assert.equal(missing.ok, false)
        assert.match(missing.message, /Токен Telegram не сохранён/)
      } finally {
        await noTokenCtx.disposeAll()
      }
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('polling: включает приём, сохраняет сообщение и offset, выключается', async () => {
  await withTempInbox(async dir => {
    let updateCalls = 0
    const mock = installFetch(({ method, body }) => {
      if (method === 'getUpdates') {
        updateCalls += 1
        assert.deepEqual(body.allowed_updates, ['message'])
        if (updateCalls === 1) {
          return telegramResponse([{
            update_id: 100,
            message: {
              message_id: 1,
              date: 1763800000,
              from: { id: 555, first_name: 'Иван', username: 'ivan' },
              chat: { id: 555, type: 'private', first_name: 'Иван', username: 'ivan' },
              text: 'Привет из Telegram',
            },
          }])
        }
        return telegramResponse([])
      }
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const enabled = await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(enabled.ok, true)
      assert.equal(enabled.enabled, true)
      assert.equal(enabled.polling, true)

      const seen = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return state.totalMessages > 0
      })
      assert.equal(seen, true, 'сообщение из getUpdates попало в историю')
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.messages.at(-1).text, 'Привет из Telegram')
      assert.equal(state.messages.at(-1).direction, 'in')
      assert.equal(state.messages.at(-1).chatId, '555')

      const saved = await waitFor(async () => {
        try {
          const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          return file.offset === 101 && file.enabled === true && file.messages.length === 1
        } catch {
          return false
        }
      })
      assert.equal(saved, true, 'offset и история сохранены в state.json')

      const firstRequest = mock.calls.find(call => call.method === 'getUpdates')
      assert.equal(firstRequest.body.offset, 0)
      const disabled = await callRoute(ctx, POLLING_PATH, { enabled: false })
      assert.equal(disabled.ok, true)
      assert.equal(disabled.enabled, false)
      assert.equal(disabled.polling, false)
      await sleep(50)
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.enabled, false)
      assert.equal(file.offset, 101)
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('polling: 401 от getUpdates останавливает приём и пишет «токен не принят»', async () => {
  await withTempInbox(async dir => {
    const mock = installFetch(({ method }) => {
      if (method === 'getUpdates') return telegramError(401, 'Unauthorized', 401)
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const enabled = await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(enabled.polling, true)
      const stopped = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return state.lastError === 'токен не принят'
      })
      assert.equal(stopped, true)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.enabled, false)
      assert.equal(state.polling, false)
      assert.match(state.lastError, /токен не принят/)
      const persisted = await waitFor(async () => {
        try {
          const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          return file.enabled === false
        } catch {
          return false
        }
      })
      assert.equal(persisted, true, 'выключение приёма сохранено в state.json')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('polling: без токена приём включается, но сообщает об отсутствии токена', async () => {
  await withTempInbox(async () => {
    globalThis.fetch = offlineFetch()
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(payload.ok, true)
      assert.equal(payload.enabled, true)
      assert.equal(payload.lastError, 'токен не сохранён')
      assert.match(payload.message, /токен не сохранён/)
      const disabled = await callRoute(ctx, POLLING_PATH, { enabled: false })
      assert.equal(disabled.enabled, false)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('messages/clear: очищает историю, offset сохраняется', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, CLEAR_PATH, {})
      assert.equal(payload.ok, true)
      assert.equal(payload.cleared, 1)
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.deepEqual(file.messages, [])
      assert.equal(file.offset, 42)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.totalMessages, 0)
      const again = await callRoute(ctx, CLEAR_PATH, {})
      assert.equal(again.cleared, 0)
      assert.match(again.message, /пуста/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('ошибки Telegram не раскрывают токен в ответах роутов', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const mock = installFetch(({ method }) => {
      if (method === 'getMe') return telegramError(400, `Bad Request: token ${TOKEN} is invalid`, 400)
      if (method === 'sendMessage') return telegramError(400, `Bad Request: token ${TOKEN} is invalid`, 400)
      throw new Error(`неожиданный метод ${method}`)
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const verify = await callRoute(ctx, VERIFY_PATH, {})
      const sent = await callRoute(ctx, SEND_PATH, { text: 'привет' })
      const state = await callRoute(ctx, STATE_PATH, {})
      for (const [name, payload] of [['verify', verify], ['send', sent], ['state', state]]) {
        assert.ok(!JSON.stringify(payload).includes(TOKEN), `${name}: токен не попадает в ответ`)
      }
      assert.match(verify.message, /токен скрыт/)
      assert.match(sent.message, /токен скрыт/)
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.ok(!JSON.stringify(file).includes(TOKEN), 'токен не пишется в state.json')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})
