import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { API_ORIGIN, TelegramError, createTelegram, describeTelegramError, redact } from '../lib/telegram.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'

test('redact: вырезает сохранённый токен и токен по форме', () => {
  assert.equal(redact(`Authorization: bot ${TOKEN}`, TOKEN), 'Authorization: bot <токен скрыт>')
  assert.equal(redact('код 987654321:ZZtopTOKENvalue_abcdefghijkl', ''), 'код <токен скрыт>')
  assert.equal(redact('обычный текст', TOKEN), 'обычный текст')
  assert.equal(redact(undefined, TOKEN), '')
})

test('describeTelegramError: понятные русские подсказки', () => {
  assert.match(describeTelegramError(new TelegramError('нет', { code: 'no-token' })), /не сохранён/)
  assert.match(describeTelegramError(new TelegramError('нет', { code: 'network' })), /интернет/)
  assert.match(describeTelegramError(new TelegramError('нет', { code: 'timeout' })), /не ответил/)
  assert.match(describeTelegramError(new TelegramError('нет', { status: 401 }), TOKEN), /401/)
  assert.match(describeTelegramError(new TelegramError('нет', { status: 409 })), /409/)
  assert.match(describeTelegramError(new TelegramError('нет', { status: 429, retryAfter: 7 })), /7/)
  assert.match(describeTelegramError(new Error(`сбой ${TOKEN}`), TOKEN), /токен скрыт/)
})

test('Telegram-клиент: без токена не ходит в сеть', async () => {
  let called = 0
  const client = createTelegram({
    fetchImpl: async () => {
      called += 1
      return new Response('{}')
    },
  })
  await assert.rejects(() => client.getMe(), error => {
    assert.equal(error.code, 'no-token')
    return true
  })
  assert.equal(called, 0)
})

test('Telegram-клиент: getMe и sendMessage разбирают ответ, ошибки не раскрывают токен', async () => {
  const requests = []
  const okClient = createTelegram({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (String(url).endsWith('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { id: 7, is_bot: true, username: 'test_bot' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 })
    },
  })
  const me = await okClient.getMe()
  assert.equal(me.username, 'test_bot')
  const sent = await okClient.sendMessage({ chatId: '555', text: 'Привет' })
  assert.equal(sent.message_id, 5)
  assert.ok(String(requests[0].url).startsWith(API_ORIGIN), 'единственный сетевой адрес — api.telegram.org')
  assert.deepEqual(JSON.parse(requests[1].init.body), { chat_id: '555', text: 'Привет' })

  const rejecting = createTelegram({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: token ${TOKEN} invalid` }), { status: 400 }),
  })
  await assert.rejects(() => rejecting.getMe(), error => {
    assert.equal(error.status, 400)
    assert.ok(!error.message.includes(TOKEN), 'токен вырезан из сообщения об ошибке')
    assert.match(error.message, /токен скрыт/)
    return true
  })

  const network = createTelegram({
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`)
    },
  })
  await assert.rejects(() => network.getMe(), error => {
    assert.equal(error.code, 'network')
    assert.ok(!error.message.includes(TOKEN), 'токен вырезан из сетевой ошибки')
    return true
  })

  const limited = createTelegram({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }), { status: 429 }),
  })
  await assert.rejects(() => limited.getMe(), error => {
    assert.equal(error.status, 429)
    assert.equal(error.retryAfter, 3)
    return true
  })
})

test('Telegram-клиент: getUpdates просит сообщения и нажатия кнопок, длинный опрос', async () => {
  let body
  const client = createTelegram({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
    },
  })
  const updates = await client.getUpdates({ offset: 33, timeout: 25 })
  assert.deepEqual(updates, [])
  assert.deepEqual(body, { offset: 33, timeout: 25, allowed_updates: ['message', 'callback_query'] })
  client.setToken('987654321:BBotherTOKENvalue_abcdefghijkl')
  await client.getUpdates({})
  assert.equal(body.offset, 0)
})

test('client.js: токен в браузер не идёт, секция и таймер обновления есть', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  assert.ok(source.includes("window.__ModuleLoader__.load({"), 'формат ModuleLoader')
  assert.ok(source.includes("id: 'dsh-inbox'"), 'id модуля совпадает с именем пакета')
  assert.ok(source.includes("ctx.slots.inject('plugins.detail.section'"), 'секция страницы плагина')
  assert.ok(source.includes('setInterval'), 'обновление по таймеру')
  assert.ok(source.includes('clearInterval'), 'таймер снимается при закрытии')
  assert.ok(source.includes('REFRESH_MS = 4000'), 'интервал 4 секунды')
  assert.ok(source.includes("const REF = 'TELEGRAM_BOT_TOKEN'"), 'ссылка на credential store')
  assert.ok(source.includes('api.set(REF'), 'запись токена через credentials')
  assert.ok(source.includes('api.unset(REF)'), 'удаление токена через credentials')
  assert.ok(!source.includes('api.telegram.org'), 'браузер не ходит в Telegram напрямую')
  assert.ok(!/bot[A-Za-z0-9_]*\//.test(source), 'нет обращений к Bot API')
  for (const locale of ['en', 'ru']) {
    assert.ok(source.includes(`const ${locale} = {`), `словарь ${locale}`)
  }
  assert.ok(!source.includes('\uFFFD'), 'нет битых символов')
})
