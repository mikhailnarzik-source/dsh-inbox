import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMMANDS_MENU,
  COMMANDS_TTL_MS,
  MENU_BUTTON_ACTIONS,
  MENU_VERSION,
  helpInlineKeyboard,
  parseCallbackData,
  replyKeyboard,
  sessionInlineKeyboard,
  sessionsInlineKeyboard,
  shouldRefreshCommands,
  statusInlineKeyboard,
} from '../lib/menu.mjs'
import { MENU_LABELS } from '../lib/replies.mjs'
import { createTelegram } from '../lib/telegram.mjs'
import { callbackFromUpdate } from '../lib/messages.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'

/** Read and parse one JSON file. */
async function readJson(relative) {
  return JSON.parse(await readFile(join(ROOT, relative), 'utf8'))
}

test('MENU_VERSION совпадает с версией пакета, команды латинские с русскими описаниями', async () => {
  const manifest = await readJson('package.json')
  // Набор и формат меню меняются вместе с минорной версией; патч-релиз
  // (оформление страницы) не требует переопубликовать меню в Telegram.
  const menuBase = MENU_VERSION.split('.').slice(0, 2).join('.')
  const packageBase = manifest.version.split('.').slice(0, 2).join('.')
  assert.equal(packageBase, menuBase, 'мажорная и минорная версии меню и пакета совпадают')
  assert.equal(COMMANDS_MENU.length, 10)
  const names = COMMANDS_MENU.map(item => item.command)
  assert.deepEqual(names, ['help', 'status', 'sessions', 'use', 'ask', 'steer', 'new', 'cancel', 'last', 'menu'])
  for (const item of COMMANDS_MENU) {
    assert.match(item.command, /^[a-z]+$/, `команда ${item.command}: только латиница в нижнем регистре`)
    assert.match(item.description, /[А-Яа-яЁё]/, `описание ${item.command} на русском`)
  }
})

test('reply keyboard: пять кнопок внизу чата и их команды', () => {
  const keyboard = replyKeyboard()
  assert.equal(keyboard.resize_keyboard, true)
  assert.equal(keyboard.is_persistent, true)
  const texts = keyboard.keyboard.flat().map(button => button.text)
  assert.deepEqual(texts, ['📋 Сессии', '➕ Новая сессия', '⏹ Прервать', 'ℹ️ Состояние', '❓ Помощь'])
  assert.deepEqual(MENU_BUTTON_ACTIONS[MENU_LABELS.sessions], { command: 'sessions' })
  assert.deepEqual(MENU_BUTTON_ACTIONS[MENU_LABELS.newSession], { hint: 'new' })
  assert.deepEqual(MENU_BUTTON_ACTIONS[MENU_LABELS.cancel], { command: 'cancel' })
  assert.deepEqual(MENU_BUTTON_ACTIONS[MENU_LABELS.status], { command: 'status' })
  assert.deepEqual(MENU_BUTTON_ACTIONS[MENU_LABELS.help], { command: 'help' })
})

test('inline keyboard /sessions: кнопки use:<id> и строка действий', () => {
  const keyboard = sessionsInlineKeyboard([
    { sessionId: 's-1', title: 'Первая', running: true },
    { sessionId: 's-2', title: '', running: false },
  ])
  const rows = keyboard.inline_keyboard
  assert.equal(rows.length, 3)
  assert.equal(rows[0][0].callback_data, 'use:s-1')
  assert.match(rows[0][0].text, /1\. Первая — выполняется/)
  assert.equal(rows[1][0].callback_data, 'use:s-2')
  assert.match(rows[1][0].text, /2\. s-2 — ожидает/)
  assert.deepEqual(rows[2].map(button => button.callback_data), ['sessions:refresh', 'status'])
  assert.deepEqual(sessionsInlineKeyboard([]).inline_keyboard, [[{
    text: MENU_LABELS.refresh,
    callback_data: 'sessions:refresh',
  }, { text: MENU_LABELS.status, callback_data: 'status' }]])
})

test('inline keyboard выбранной сессии и /status, /help', () => {
  const chosen = sessionInlineKeyboard('s-1').inline_keyboard
  assert.deepEqual(chosen[0].map(button => button.callback_data), ['ask', 'cancel:s-1'])
  assert.deepEqual(chosen[1].map(button => button.callback_data), ['sessions:refresh', 'status'])

  const status = statusInlineKeyboard('s-1').inline_keyboard
  assert.deepEqual(status[0].map(button => button.callback_data), ['cancel:s-1', 'menu', 'help'])
  assert.equal(statusInlineKeyboard('').inline_keyboard[0][0].callback_data, 'cancel')

  const help = helpInlineKeyboard().inline_keyboard
  assert.deepEqual(help[0].map(button => button.callback_data), ['sessions:refresh', 'status'])
  assert.deepEqual(help[1].map(button => button.callback_data), ['menu'])
})

test('parseCallbackData: use, cancel, refresh, status, help, menu, ask и неизвестное', () => {
  assert.deepEqual(parseCallbackData('use:s-1'), { action: 'use', sessionId: 's-1' })
  assert.deepEqual(parseCallbackData('cancel:s-2'), { action: 'cancel', sessionId: 's-2' })
  assert.deepEqual(parseCallbackData('cancel'), { action: 'cancel', sessionId: '' })
  assert.deepEqual(parseCallbackData('sessions:refresh'), { action: 'sessions-refresh' })
  assert.deepEqual(parseCallbackData('status'), { action: 'status' })
  assert.deepEqual(parseCallbackData('help'), { action: 'help' })
  assert.deepEqual(parseCallbackData('menu'), { action: 'menu' })
  assert.deepEqual(parseCallbackData('ask'), { action: 'ask' })
  assert.deepEqual(parseCallbackData('wat'), { action: 'unknown', data: 'wat' })
  assert.deepEqual(parseCallbackData(undefined), { action: 'unknown', data: '' })
})

test('shouldRefreshCommands: сутки, версия и неудачная попытка', () => {
  const now = 1_700_000_000_000
  const fresh = { version: MENU_VERSION, at: now - 1000, ok: true }
  assert.equal(shouldRefreshCommands(fresh, now), false)
  assert.equal(shouldRefreshCommands({ ...fresh, at: now - COMMANDS_TTL_MS - 1 }, now), true)
  assert.equal(shouldRefreshCommands({ ...fresh, version: '0.2.0' }, now), true)
  assert.equal(shouldRefreshCommands({ ...fresh, ok: false }, now), true)
  assert.equal(shouldRefreshCommands({ version: MENU_VERSION, at: 0, ok: true }, now), true)
  assert.equal(shouldRefreshCommands(undefined, now), true)
})

test('callbackFromUpdate: чат, сообщение и data из callback_query', () => {
  const callback = callbackFromUpdate({
    update_id: 5,
    callback_query: {
      id: 'cb-1',
      from: { id: 555, first_name: 'Иван' },
      message: {
        message_id: 42,
        chat: { id: 555, type: 'private', first_name: 'Иван' },
      },
      data: 'use:s-1',
    },
  })
  assert.deepEqual(callback, {
    callbackId: 'cb-1',
    chatId: '555',
    chatTitle: 'Иван',
    fromId: '555',
    chatType: 'private',
    messageId: 42,
    data: 'use:s-1',
    from: 'Иван',
  })
  assert.equal(callbackFromUpdate({ update_id: 6 }), undefined)
  assert.equal(callbackFromUpdate({ callback_query: { data: 'x' } }), undefined)
  assert.equal(callbackFromUpdate({ callback_query: { id: 'cb-2' } }).chatId, '')
})

test('Telegram-клиент: setMyCommands, editMessageText и answerCallbackQuery', async () => {
  const requests = []
  const client = createTelegram({
    token: TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ method: String(url).slice(String(url).lastIndexOf('/') + 1), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
    },
  })
  await client.setMyCommands(COMMANDS_MENU, { type: 'default' })
  assert.equal(requests[0].method, 'setMyCommands')
  assert.equal(requests[0].body.scope.type, 'default')
  assert.equal(requests[0].body.commands.length, 10)
  assert.deepEqual(requests[0].body.commands[0], { command: 'help', description: 'Помощь' })

  await client.sendMessage({ chatId: '555', text: 'Меню', replyMarkup: { keyboard: [] } })
  assert.deepEqual(requests[1].body.reply_markup, { keyboard: [] })

  await client.editMessageText({ chatId: '555', messageId: 42, text: 'Новый текст', replyMarkup: { inline_keyboard: [] } })
  assert.equal(requests[2].method, 'editMessageText')
  assert.deepEqual(requests[2].body, {
    chat_id: '555',
    message_id: 42,
    text: 'Новый текст',
    reply_markup: { inline_keyboard: [] },
  })

  await client.answerCallbackQuery({ callbackQueryId: 'cb-1', text: 'Готово' })
  assert.deepEqual(requests[3].body, { callback_query_id: 'cb-1', text: 'Готово', show_alert: false })
})
