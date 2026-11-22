import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_MESSAGES,
  STATE_VERSION,
  addMessage,
  addMessages,
  clearMessages,
  emptyState,
  lastChat,
  normalizeChatId,
  normalizeChatIds,
  normalizeState,
  readState,
  sanitizeMessage,
  writeState,
} from '../lib/storage.mjs'
import { chatTitle, displayName, messageFromUpdate, nextOffset } from '../lib/messages.mjs'
import { withTempInbox } from './helpers.mjs'

/** A valid history record. */
function record(overrides = {}) {
  return {
    chatId: '555',
    chatTitle: 'Иван',
    from: 'Иван',
    text: 'Привет',
    at: '2026-11-22T10:00:00.000Z',
    direction: 'in',
    ...overrides,
  }
}

test('emptyState: пустая история, белый список, меню, очередь и безопасность', () => {
  assert.deepEqual(emptyState(), {
    version: STATE_VERSION,
    offset: 0,
    enabled: false,
    botUsername: '',
    allowedChatIds: [],
    currentChatSession: {},
    pendingLists: {},
    commandsMenu: { version: '', at: 0, ok: false },
    deviceId: '',
    queue: { listener: false },
    allowedUserIds: [],
    ownerUserId: '',
    ownerChatId: '',
    security: { groupsEnabled: false },
    botProfile: { name: '', description: '', shortDescription: '', at: 0, version: '', ok: false },
    webhook: { url: '', checkedAt: 0 },
    messages: [],
  })
  assert.equal(STATE_VERSION, 5)
})

test('normalizeState: мусор и неверные типы дают пустое состояние', () => {
  assert.deepEqual(normalizeState(null), emptyState())
  assert.deepEqual(normalizeState('строка'), emptyState())
  assert.deepEqual(normalizeState({ offset: -5, enabled: 'да', messages: 'нет' }), emptyState())
  assert.equal(normalizeState({ offset: 12.9 }).offset, 12)
  assert.equal(normalizeState({ enabled: true }).enabled, true)
  assert.equal(normalizeState({ botUsername: '@my_bot' }).botUsername, 'my_bot')
})

test('normalizeState: записи без chatId или направления отбрасываются, порядок сохраняется', () => {
  const state = normalizeState({
    messages: [
      record(),
      { chatId: '', direction: 'in', text: 'без чата' },
      record({ chatId: '556', text: 'второе', direction: 'out', at: '2026-11-22T11:00:00.000Z' }),
      { chatId: '557', direction: 'неизвестно', text: 'мимо' },
    ],
  })
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0].chatId, '555')
  assert.equal(state.messages[1].direction, 'out')
})

test('normalizeState: белый список, текущие сессии и списки сессий очищаются', () => {
  const state = normalizeState({
    allowedChatIds: ['123', ' 123 ', '-1001234567890', 'abc', '', 42, null],
    currentChatSession: { '123': 'session-a', 'плохо': 'session-b', '456': '   ' },
    pendingLists: { '123': ['s1', 's2', ' ', 's1'], 'abc': ['s3'], '456': 'нет' },
  })
  assert.deepEqual(state.allowedChatIds, ['123', '-1001234567890', '42'])
  assert.deepEqual(state.currentChatSession, { '123': 'session-a' })
  assert.deepEqual(state.pendingLists, { '123': ['s1', 's2'] })
})

test('normalizeState: кэш меню команд очищается и переживает запись', () => {
  const state = normalizeState({
    commandsMenu: { version: ' 0.3.0 ', at: 1700000000000.9, ok: true },
  })
  assert.deepEqual(state.commandsMenu, { version: '0.3.0', at: 1700000000000, ok: true })
  assert.deepEqual(normalizeState({ commandsMenu: 'нет' }).commandsMenu, { version: '', at: 0, ok: false })
  assert.deepEqual(normalizeState({ commandsMenu: { version: 5, at: -1, ok: 'да' } }).commandsMenu, { version: '', at: 0, ok: false })
})

test('normalizeState: deviceId и queue.listener очищаются', () => {
  const state = normalizeState({ deviceId: '  device-a  ', queue: { listener: true } })
  assert.equal(state.deviceId, 'device-a')
  assert.deepEqual(state.queue, { listener: true })
  assert.deepEqual(normalizeState({ queue: 'нет' }).queue, { listener: false })
  assert.deepEqual(normalizeState({ queue: { listener: 'да' } }).queue, { listener: false })
  assert.equal(normalizeState({}).deviceId, '')
})

test('normalizeState: файл версии 1 без новых полей читается как совместимый', () => {
  const state = normalizeState({
    version: 1,
    offset: 5,
    enabled: false,
    messages: [record()],
  })
  assert.equal(state.offset, 5)
  assert.deepEqual(state.allowedChatIds, [])
  assert.deepEqual(state.currentChatSession, {})
  assert.deepEqual(state.pendingLists, {})
  assert.equal(state.messages.length, 1)
})

test('normalizeChatIds: только числа, без дублей и в исходном порядке', () => {
  assert.deepEqual(normalizeChatIds(['5', ' 5 ', '-7', 'x', '007']), ['5', '-7', '007'])
  assert.deepEqual(normalizeChatIds('5'), [])
  assert.deepEqual(normalizeChatIds([1, 2]), ['1', '2'])
  assert.equal(normalizeChatId('-1001234567890'), '-1001234567890')
  assert.equal(normalizeChatId('+7'), '')
  assert.equal(normalizeChatId(''), '')
})

test('sanitizeMessage: флаг blocked сохраняется только как true', () => {
  assert.equal(sanitizeMessage({ ...record(), blocked: true }).blocked, true)
  assert.equal('blocked' in sanitizeMessage(record()), false)
  assert.equal('blocked' in sanitizeMessage({ ...record(), blocked: false }), false)
  assert.equal('blocked' in sanitizeMessage({ ...record(), blocked: 'да' }), false)
})

test('normalizeState: история обрезается до MAX_MESSAGES последних записей', () => {
  const many = Array.from({ length: MAX_MESSAGES + 25 }, (_, index) => record({ chatId: String(1000 + index) }))
  const state = normalizeState({ messages: many })
  assert.equal(state.messages.length, MAX_MESSAGES)
  assert.equal(state.messages[0].chatId, String(1000 + 25))
  assert.equal(state.messages[MAX_MESSAGES - 1].chatId, String(1000 + MAX_MESSAGES + 24))
})

test('sanitizeMessage: чистит поля и приводит время к ISO', () => {
  const clean = sanitizeMessage({
    chatId: ' 42 ',
    chatTitle: ' ',
    from: 'Пётр',
    text: 'текст',
    at: '2026-11-22T10:00:00.000Z',
    direction: 'in',
    лишнее: 'поле',
  })
  assert.deepEqual(clean, {
    chatId: '42',
    chatTitle: '42',
    from: 'Пётр',
    text: 'текст',
    at: '2026-11-22T10:00:00.000Z',
    direction: 'in',
  })
  assert.equal(sanitizeMessage({ chatId: '42', direction: 'in', at: 'не дата' }).at, '')
  assert.equal(sanitizeMessage(undefined), undefined)
})

test('writeState/readState: запись и чтение с диска, битый файл читается как пустой', async () => {
  await withTempInbox(async dir => {
    const file = join(dir, 'state.json')
    const state = addMessage({ ...emptyState(), offset: 7, enabled: true }, record())
    const written = await writeState(state, file)
    assert.equal(written.messages.length, 1)
    const loaded = await readState(file)
    assert.equal(loaded.offset, 7)
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.messages[0].text, 'Привет')
    const raw = await readFile(file, 'utf8')
    assert.ok(raw.endsWith('\n'), 'файл заканчивается переводом строки')

    await writeFile(file, '{ не json', 'utf8')
    assert.deepEqual(await readState(file), emptyState())

    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeState(state, join(dir, 'nested', 'deep', 'state.json'))
    assert.equal((await readState(join(dir, 'nested', 'deep', 'state.json'))).messages.length, 1)
  })
})

test('addMessage: добавляет в конец, хранит не больше MAX_MESSAGES', () => {
  let state = emptyState()
  state = addMessage(state, record({ text: 'раз' }))
  state = addMessage(state, record({ text: 'два', direction: 'out' }))
  assert.deepEqual(state.messages.map(message => message.text), ['раз', 'два'])
  for (let index = 0; index < MAX_MESSAGES + 10; index += 1) {
    state = addMessage(state, record({ text: `сообщение ${index}` }))
  }
  assert.equal(state.messages.length, MAX_MESSAGES)
  assert.equal(state.messages.at(-1).text, `сообщение ${MAX_MESSAGES + 9}`)
  assert.equal(addMessage(state, { chatId: '', direction: 'in' }).messages.length, MAX_MESSAGES)
})

test('addMessages: пачка записей добавляется одним шагом', () => {
  const state = addMessages(emptyState(), [record(), record({ chatId: '556' }), { плохо: true }])
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1].chatId, '556')
})

test('lastChat: последний входящий чат важнее исходящего, пустая история — undefined', () => {
  assert.equal(lastChat(emptyState()), undefined)
  let state = addMessage(emptyState(), record({ chatId: '1', chatTitle: 'Первый' }))
  state = addMessage(state, record({ chatId: '2', chatTitle: 'Второй' }))
  state = addMessage(state, record({ chatId: '2', chatTitle: 'Второй', direction: 'out' }))
  assert.deepEqual(lastChat(state), { chatId: '2', chatTitle: 'Второй' })
  state = addMessage(state, record({ chatId: '3', chatTitle: 'Третий', direction: 'out' }))
  assert.deepEqual(lastChat(state), { chatId: '2', chatTitle: 'Второй' })
  const onlyOut = addMessage(emptyState(), record({ chatId: '9', chatTitle: 'Даша', direction: 'out' }))
  assert.deepEqual(lastChat(onlyOut), { chatId: '9', chatTitle: 'Даша' })
})

test('clearMessages: история становится пустой, offset и приём сохраняются', () => {
  const state = clearMessages({ ...addMessage(emptyState(), record()), offset: 31, enabled: true })
  assert.deepEqual(state.messages, [])
  assert.equal(state.offset, 31)
  assert.equal(state.enabled, true)
})

test('displayName и chatTitle: имя, @username, id', () => {
  assert.equal(displayName({ first_name: 'Иван', last_name: 'Петров' }), 'Иван Петров')
  assert.equal(displayName({ username: 'ivan' }), '@ivan')
  assert.equal(displayName({ id: 7 }), '7')
  assert.equal(displayName(null), '')
  assert.equal(chatTitle({ title: 'Команда' }), 'Команда')
  assert.equal(chatTitle({ username: 'team_bot' }), '@team_bot')
  assert.equal(chatTitle({ id: 42, first_name: 'Иван' }), 'Иван')
  assert.equal(chatTitle({ id: 42 }), '42')
})

test('messageFromUpdate: текст и подпись становятся записью, служебные пропускаются', () => {
  const from = { id: 555, first_name: 'Иван', username: 'ivan' }
  const chat = { id: 555, type: 'private', first_name: 'Иван', username: 'ivan' }
  const message = messageFromUpdate({
    update_id: 90,
    message: { message_id: 1, date: 1763800000, from, chat, text: 'Привет' },
  })
  assert.deepEqual(message, {
    chatId: '555',
    chatTitle: '@ivan',
    from: 'Иван',
    fromId: '555',
    chatType: 'private',
    text: 'Привет',
    at: new Date(1763800000 * 1000).toISOString(),
    direction: 'in',
  })
  const caption = messageFromUpdate({ update_id: 91, message: { date: 1763800000, from, chat, caption: 'Подпись' } })
  assert.equal(caption.text, 'Подпись')
  assert.equal(messageFromUpdate({ update_id: 92, message: { date: 1, chat, sticker: {} } }), undefined)
  assert.equal(messageFromUpdate({ edited_message: {} }), undefined)
  assert.equal(messageFromUpdate(null), undefined)
})

test('nextOffset: максимум update_id + 1, не меньше текущего', () => {
  assert.equal(nextOffset(0, []), 0)
  assert.equal(nextOffset(5, [{ update_id: 4 }, { update_id: 9 }]), 10)
  assert.equal(nextOffset(20, [{ update_id: 9 }]), 20)
  assert.equal(nextOffset(0, [{ update_id: 'плохо' }]), 0)
  assert.equal(nextOffset(3, undefined), 3)
})
