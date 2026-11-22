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
const STATE_PATH = '/api/dsh-inbox/state'
const VERIFY_PATH = '/api/dsh-inbox/verify'
const SEND_PATH = '/api/dsh-inbox/send'
const POLLING_PATH = '/api/dsh-inbox/polling'
const CLEAR_PATH = '/api/dsh-inbox/messages/clear'
const ALLOWLIST_PATH = '/api/dsh-inbox/allowlist'
const SESSION_RESET_PATH = '/api/dsh-inbox/session/reset'

/** One stored incoming message from an allowed chat. */
const SEED = {
  version: 2,
  offset: 42,
  enabled: false,
  botUsername: '',
  allowedChatIds: ['555'],
  currentChatSession: {},
  pendingLists: {},
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

/** One Telegram update with a text message. */
function update(updateId, chatId, text, extra = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1763800000,
      from: { id: chatId, first_name: 'Иван', username: 'ivan' },
      chat: { id: chatId, type: 'private', first_name: 'Иван', username: 'ivan', ...extra },
      text,
    },
  }
}

test('state: без токена — configured:false, пустой белый список и пустая история', async () => {
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
      assert.deepEqual(payload.allowedChatIds, [])
      assert.equal(payload.currentSession, null)
      assert.deepEqual(payload.chats, [])
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

test('state: чаты истории с белым списком и текущей сессией', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      ...SEED,
      currentChatSession: { 555: 'session-abc' },
    }), 'utf8')
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, STATE_PATH, {})
      assert.deepEqual(payload.allowedChatIds, ['555'])
      assert.equal(payload.chats.length, 1)
      assert.equal(payload.chats[0].chatId, '555')
      assert.equal(payload.chats[0].allowed, true)
      assert.equal(payload.chats[0].sessionId, 'session-abc')
      assert.equal(payload.currentSession.sessionId, 'session-abc')
      assert.equal(payload.currentSession.chatId, '555')
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('verify: getMe принят, имя бота сохраняется, токен не утекает', async () => {
  await withTempInbox(async dir => {
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, VERIFY_PATH, {})
      assert.equal(payload.ok, true)
      assert.equal(payload.code, 'accepted')
      assert.equal(payload.botUsername, 'dsh_inbox_test_bot')
      assert.match(payload.message, /dsh_inbox_test_bot/)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ verify')
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.botUsername, 'dsh_inbox_test_bot')
      assert.ok(!JSON.stringify(file).includes(TOKEN), 'токен не пишется в state.json')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('verify: 401 — код rejected и понятное сообщение без токена', async () => {
  await withTempInbox(async () => {
    const mock = telegramMock({ getMe: () => telegramError(401, 'Unauthorized', 401) })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, VERIFY_PATH, {})
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'rejected')
      assert.match(payload.message, /401/)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ verify')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('verify: без токена отвечает missing и не ходит в сеть', async () => {
  await withTempInbox(async () => {
    const previous = globalThis.fetch
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
      globalThis.fetch = previous
    }
  })
})

test('send: отправляет в последний чат, пишет исходящее в историю, токена в ответе нет', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, SEND_PATH, { chatId: 'last', text: '  Привет!  ' })
      assert.equal(payload.ok, true)
      assert.equal(payload.chatId, '555')
      assert.equal(payload.chatTitle, 'Иван')
      assert.equal(payload.messageId, 1)
      assert.ok(!JSON.stringify(payload).includes(TOKEN), 'токен не попадает в ответ send')
      assert.deepEqual(mock.sent[0], { chat_id: '555', text: 'Привет!' })
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.messages.length, 2)
      assert.equal(file.messages[1].direction, 'out')
      assert.ok(!JSON.stringify(file).includes(TOKEN), 'токен не пишется в state.json')
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
      const noTokenCtx = fakeContext()
      module.apply(noTokenCtx)
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

test('allowlist: замена списка, добавление, удаление и отказ на неверный id', async () => {
  await withTempInbox(async () => {
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const replaced = await callRoute(ctx, ALLOWLIST_PATH, { userIds: ['555', ' -100123 ', '555'] })
      assert.equal(replaced.ok, true)
      assert.deepEqual(replaced.allowedUserIds, ['555', '-100123'])
      assert.equal(replaced.owner.userId, '555')
      const bad = await callRoute(ctx, ALLOWLIST_PATH, { userIds: ['555', 'не id'] })
      assert.equal(bad.ok, false)
      assert.match(bad.message, /Неверные id/)
      assert.deepEqual((await callRoute(ctx, STATE_PATH, {})).allowedUserIds, ['555', '-100123'])
      const added = await callRoute(ctx, ALLOWLIST_PATH, { add: '777' })
      assert.equal(added.ok, true)
      assert.deepEqual(added.allowedUserIds, ['555', '-100123', '777'])
      const again = await callRoute(ctx, ALLOWLIST_PATH, { add: '777' })
      assert.equal(again.ok, true)
      assert.match(again.message, /уже/)
      const removed = await callRoute(ctx, ALLOWLIST_PATH, { remove: '777' })
      assert.equal(removed.ok, true)
      assert.deepEqual(removed.allowedUserIds, ['555', '-100123'])
      const owner = await callRoute(ctx, ALLOWLIST_PATH, { remove: '555' })
      assert.deepEqual(owner.allowedUserIds, ['555', '-100123'], 'владельца удалить нельзя')
      const cleared = await callRoute(ctx, ALLOWLIST_PATH, { userIds: [] })
      assert.equal(cleared.ok, true)
      assert.deepEqual(cleared.allowedUserIds, [])
      assert.match(cleared.message, /пуст/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('session/reset: отвязывает сессию от чата', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, currentChatSession: { 555: 'session-abc' } }), 'utf8')
    const module = await import('../index.js')
    const ctx = fakeContext()
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, SESSION_RESET_PATH, { chatId: '555' })
      assert.equal(payload.ok, true)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.currentSession, null)
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.deepEqual(file.currentChatSession, {})
      const bad = await callRoute(ctx, SESSION_RESET_PATH, { chatId: 'нет' })
      assert.equal(bad.ok, false)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('polling: разрешённый чат попадает в историю, команда /help получает ✅', async () => {
  await withTempInbox(async dir => {
    let calls = 0
    const mock = telegramMock({
      getUpdates: body => {
        calls += 1
        assert.deepEqual(body.allowed_updates, ['message', 'callback_query'])
        if (calls === 1) return Response.json({ ok: true, result: [update(100, 555, '/help')] })
        return Response.json({ ok: true, result: [] })
      },
    })
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, messages: [] }), 'utf8')
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const enabled = await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(enabled.polling, true)
      const seen = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return state.totalMessages >= 2
      })
      assert.equal(seen, true, 'входящее и ответ попали в историю')
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.messages.at(-2).direction, 'in')
      assert.equal(state.messages.at(-2).text, '/help')
      assert.equal(state.messages.at(-1).direction, 'out')
      assert.match(state.messages.at(-1).text, /✅ Принято/)
      assert.match(mock.sent[0].text, /✅ Принято/)
      assert.equal(mock.sent[0].chat_id, '555')
      const saved = await waitFor(async () => {
        const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
        return file.offset === 101 && file.messages.length === 2
      })
      assert.equal(saved, true, 'offset и история сохранены')
      await callRoute(ctx, POLLING_PATH, { enabled: false })
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('polling: чужой чат — сообщение с blocked, отказ один раз за 5 минут, команд нет', async () => {
  await withTempInbox(async dir => {
    let calls = 0
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        if (calls === 1) {
          return Response.json({ ok: true, result: [update(200, 999, '/help'), update(201, 999, '/status')] })
        }
        return Response.json({ ok: true, result: [] })
      },
    })
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, messages: [] }), 'utf8')
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      const seen = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return state.totalMessages >= 2
      })
      assert.equal(seen, true)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.messages.every(message => message.blocked === true), true)
      assert.equal(state.messages.every(message => message.direction === 'in'), true)
      assert.equal(mock.sent.length, 1, 'отказ отправлен один раз, командных ответов нет')
      assert.match(mock.sent[0].text, /⛔ Нет доступа/)
      assert.equal(state.chats[0].allowed, false)
      const saved = await waitFor(async () => {
        try {
          const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
          return file.messages.length === 2
        } catch {
          return false
        }
      })
      assert.equal(saved, true, 'заблокированные сообщения сохранены в state.json')
      await callRoute(ctx, POLLING_PATH, { enabled: false })
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('polling: 401 от getUpdates останавливает приём и пишет «токен не принят»', async () => {
  await withTempInbox(async dir => {
    const mock = telegramMock({ getUpdates: () => telegramError(401, 'Unauthorized', 401) })
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

test('messages/clear: очищает историю, offset и белый список сохраняются', async () => {
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
      assert.deepEqual(file.allowedChatIds, ['555'])
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
    const mock = telegramMock({
      getMe: () => telegramError(400, `Bad Request: token ${TOKEN} is invalid`, 400),
      sendMessage: () => telegramError(400, `Bad Request: token ${TOKEN} is invalid`, 400),
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
