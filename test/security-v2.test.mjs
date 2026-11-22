import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTelegram, isNotModifiedError, TelegramError } from '../lib/telegram.mjs'
import {
  HOUR_MS,
  RATE_WINDOW_MS,
  allowSender,
  checkSender,
  createRateLimiter,
  createUpdateDeduper,
  denySender,
  isPrivateChat,
} from '../lib/security.mjs'
import { emptyState } from '../lib/storage.mjs'
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
const POLLING_PATH = '/api/dsh-inbox/polling'
const WEBHOOK_DELETE_PATH = '/api/dsh-inbox/webhook/delete'
const SECURITY_PATH = '/api/dsh-inbox/security'

/** One text update; `chatId` doubles as the sender id by default. */
function messageUpdate(updateId, text, chatId = CHAT, chatType = 'private', fromId = chatId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1763800000,
      from: { id: Number(fromId), first_name: 'Иван' },
      chat: { id: Number(chatId), type: chatType, title: chatType === 'private' ? undefined : 'Группа' },
      text,
    },
  }
}

/** Seed the state with one allowed user. */
async function seed(dir, overrides = {}) {
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 5,
    enabled: false,
    allowedUserIds: [CHAT],
    allowedChatIds: [CHAT],
    security: { groupsEnabled: false },
    ...overrides,
  }), 'utf8')
}

test('checkSender: только личные чаты, только разрешённый пользователь', () => {
  const state = { ...emptyState(), allowedUserIds: ['555'] }
  assert.equal(isPrivateChat('private'), true)
  assert.equal(isPrivateChat(undefined), true)
  assert.equal(isPrivateChat('group'), false)
  assert.deepEqual(checkSender(state, { chatId: '555', fromId: '555', chatType: 'private' }), { allowed: true, reason: '', userId: '555' })
  assert.equal(checkSender(state, { chatId: '555', fromId: '777', chatType: 'private' }).reason, 'not-listed')
  assert.equal(checkSender(state, { chatId: '-1001', fromId: '555', chatType: 'group' }).reason, 'group')
  const groups = { ...state, security: { groupsEnabled: true } }
  assert.equal(checkSender(groups, { chatId: '-1001', fromId: '555', chatType: 'group' }).allowed, true)
})

test('owner: первый разрешённый становится владельцем, владельца нельзя удалить', () => {
  let state = emptyState()
  const allowed = allowSender(state, { chatId: '555', fromId: '555' })
  state = allowed.state
  assert.equal(state.ownerUserId, '555')
  assert.equal(state.ownerChatId, '555')
  assert.equal(allowSender(state, { chatId: '777', fromId: '777' }).state.ownerUserId, '555')
  const kept = denySender(state, '555')
  assert.equal(kept.changed, false)
  assert.deepEqual(kept.state.allowedUserIds, ['555'])
  const removed = denySender(state, '555', { includeOwner: true })
  assert.equal(removed.changed, true)
  assert.equal(removed.state.ownerUserId, '')
})

test('rate limiter: 1 команда/1.5 с и 30 в час', () => {
  let clock = 1_000_000
  const limiter = createRateLimiter({ now: () => clock })
  assert.equal(limiter.check('555').ok, true)
  const second = limiter.check('555')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'window')
  assert.ok(second.retryAfterMs <= RATE_WINDOW_MS)
  clock += RATE_WINDOW_MS
  assert.equal(limiter.check('555').ok, true)
  // Different chat has its own window.
  assert.equal(limiter.check('777').ok, true)

  const hourly = createRateLimiter({ now: () => clock, windowMs: 0, hourLimit: 2 })
  assert.equal(hourly.check('1').ok, true)
  assert.equal(hourly.check('1').ok, true)
  const third = hourly.check('1')
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'hour')
  assert.ok(third.retryAfterMs <= HOUR_MS)
  clock += HOUR_MS
  assert.equal(hourly.check('1').ok, true)
})

test('update deduper: второй раз тот же update_id не проходит', () => {
  const deduper = createUpdateDeduper(2)
  assert.equal(deduper.seen(1), false)
  assert.equal(deduper.seen(1), true)
  assert.equal(deduper.seen(2), false)
  assert.equal(deduper.seen(3), false)
  // The oldest id was forgotten after the cap.
  assert.equal(deduper.seen(1), false)
})

test('Telegram 429: ждёт retry_after и повторяет один раз', async () => {
  const delays = []
  let calls = 0
  const client = createTelegram({
    token: TOKEN,
    sleep: async ms => {
      delays.push(ms)
    },
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }), { status: 429 })
      }
      return new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 })
    },
  })
  const result = await client.getMe()
  assert.deepEqual(result, { id: 1 })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [2000])
})

test('Telegram 429: повторная ошибка не зацикливается', async () => {
  let calls = 0
  const client = createTelegram({
    token: TOKEN,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }), { status: 429 })
    },
  })
  await assert.rejects(() => client.getMe(), error => {
    assert.equal(error.status, 429)
    return true
  })
  assert.equal(calls, 2)
})

test('isNotModifiedError распознаёт 400 message is not modified', () => {
  assert.equal(isNotModifiedError(new TelegramError('Bad Request: message is not modified', { status: 400 })), true)
  assert.equal(isNotModifiedError(new TelegramError('Bad Request: chat not found', { status: 400 })), false)
  assert.equal(isNotModifiedError(new Error('message is not modified')), false)
})

test('409: читает webhook, объясняет и останавливает приём', async () => {
  await withTempInbox(async dir => {
    await seed(dir)
    let updates = 0
    let webhookCalls = 0
    const mock = telegramMock({
      getUpdates: () => {
        updates += 1
        if (updates === 1) return telegramError(409, 'Conflict: terminated by other getUpdates request', 409)
        return Response.json({ ok: true, result: [] })
      },
      getWebhookInfo: () => {
        webhookCalls += 1
        return Response.json({ ok: true, result: { url: webhookCalls === 1 ? 'https://example.test/hook' : '' } })
      },
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      const explained = await waitFor(async () => {
        const state = await callRoute(ctx, STATE_PATH, {})
        return /webhook/i.test(state.lastError)
      }, 4000)
      assert.equal(explained, true)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.webhook.url, 'https://example.test/hook')
      assert.equal(state.polling, false)
      const deleted = await callRoute(ctx, WEBHOOK_DELETE_PATH, {})
      assert.equal(deleted.ok, true)
      assert.equal(deleted.polling, true, 'после снятия webhook приём возобновляется')
      assert.ok(mock.webhook.some(call => call.method === 'deleteWebhook'))
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})

test('rate limit в приёме: вторая команда получает подсказку', async () => {
  await withTempInbox(async dir => {
    process.env.DSH_INBOX_RATE_LIMIT_MS = '1500'
    process.env.DSH_INBOX_RATE_HOUR_LIMIT = '0'
    await seed(dir)
    let calls = 0
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        return Response.json({ ok: true, result: calls === 1 ? [messageUpdate(1, '/help'), messageUpdate(2, '/help')] : [] })
      },
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      const limited = await waitFor(() => mock.sent.some(message => /Слишком часто/.test(message.text)), 4000)
      assert.equal(limited, true)
      assert.equal(mock.sent.filter(message => /✅ Принято/.test(message.text)).length, 1)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      delete process.env.DSH_INBOX_RATE_LIMIT_MS
    }
  })
})

test('hour limit: после 30 команд приходит «Лимит 30 команд»', async () => {
  await withTempInbox(async dir => {
    process.env.DSH_INBOX_RATE_LIMIT_MS = '0'
    process.env.DSH_INBOX_RATE_HOUR_LIMIT = '2'
    await seed(dir)
    let calls = 0
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        return Response.json({ ok: true, result: calls === 1 ? [messageUpdate(1, '/help'), messageUpdate(2, '/help'), messageUpdate(3, '/help')] : [] })
      },
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      const limited = await waitFor(() => mock.sent.some(message => /30 команд/.test(message.text)), 4000)
      assert.equal(limited, true)
      assert.equal(mock.sent.filter(message => /✅ Принято/.test(message.text)).length, 2)
    } finally {
      await ctx.disposeAll()
      mock.restore()
      delete process.env.DSH_INBOX_RATE_HOUR_LIMIT
    }
  })
})

test('дедуп update_id: повторный апдейт не выполняется дважды', async () => {
  await withTempInbox(async dir => {
    await seed(dir)
    let calls = 0
    const duplicate = [messageUpdate(7, '/help'), messageUpdate(7, '/help')]
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        return Response.json({ ok: true, result: calls === 1 ? duplicate : [] })
      },
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      await waitFor(() => mock.sent.length > 0, 4000)
      await sleep(300)
      assert.equal(mock.sent.filter(message => /✅ Принято/.test(message.text)).length, 1)
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.totalMessages, 2, 'одно входящее и один ответ')
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})

test('группы: после разрешения через локальный роут команда проходит', async () => {
  await withTempInbox(async dir => {
    await seed(dir)
    let calls = 0
    let securityEnabled = false
    let secondBatchSent = false
    const mock = telegramMock({
      getUpdates: () => {
        calls += 1
        if (calls === 1) return Response.json({ ok: true, result: [messageUpdate(1, '/help', -100123, 'group', CHAT)] })
        if (securityEnabled && !secondBatchSent) {
          secondBatchSent = true
          return Response.json({ ok: true, result: [messageUpdate(2, '/help', -100123, 'group', CHAT)] })
        }
        return Response.json({ ok: true, result: [] })
      },
    })
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      await callRoute(ctx, POLLING_PATH, { enabled: true })
      assert.equal(await waitFor(() => mock.sent.some(message => /Группы запрещены/.test(message.text)), 4000), true)
      const security = await callRoute(ctx, SECURITY_PATH, { groupsEnabled: true })
      assert.equal(security.ok, true)
      securityEnabled = true
      const accepted = await waitFor(() => mock.sent.some(message => /✅ Принято/.test(message.text)), 6000)
      assert.equal(accepted, true, JSON.stringify({ sent: mock.sent.map(message => message.text), calls }))
      const state = await callRoute(ctx, STATE_PATH, {})
      assert.equal(state.security.groupsEnabled, true)
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})

test('локальный роут безопасности назначает владельца', async () => {
  await withTempInbox(async dir => {
    await seed(dir, { ownerUserId: '', ownerChatId: '' })
    const mock = telegramMock()
    const module = await import('../index.js')
    const ctx = fakeContext({ token: TOKEN })
    module.apply(ctx)
    try {
      const payload = await callRoute(ctx, SECURITY_PATH, { ownerUserId: '777', ownerChatId: '777' })
      assert.equal(payload.ok, true)
      assert.equal(payload.owner.userId, '777')
      assert.deepEqual(payload.allowedUserIds, [CHAT, '777'])
      assert.equal(payload.security.groupsEnabled, false)
    } finally {
      await ctx.disposeAll()
      mock.restore()
    }
  })
})
