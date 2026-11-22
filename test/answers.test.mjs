import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ANSWER_TIMEOUT_TEXT,
  THINKING_TEXT,
  createAnswerTracker,
  extractAssistantText,
  sessionIdOf,
  splitAnswerText,
} from '../lib/answers.mjs'

/** Build a tracker with recording doubles and a controllable clock. */
function harness(options = {}) {
  let clock = options.clock ?? 1_000_000
  const recorded = []
  const sent = []
  const edits = []
  const typing = []
  const tracker = createAnswerTracker({
    now: () => clock,
    timeoutMs: options.timeoutMs ?? 1000,
    sendTyping: async chatId => {
      typing.push(chatId)
    },
    sendMessage: async ({ chatId, text }) => {
      sent.push({ chatId, text })
      return { messageId: 500 + sent.length }
    },
    editMessage: async ({ chatId, messageId, text }) => {
      edits.push({ chatId, messageId, text })
    },
    recordOutgoing: async payload => {
      recorded.push(payload)
    },
  })
  return {
    tracker,
    typing,
    sent,
    edits,
    recorded,
    advance: ms => {
      clock += ms
    },
  }
}

test('splitAnswerText: режет длинный ответ до лимита и не теряет текст', () => {
  const long = 'а'.repeat(9000)
  const chunks = splitAnswerText(long, 4096)
  assert.equal(chunks.length, 3)
  assert.equal(chunks.join(''), long)
  for (const chunk of chunks) assert.ok(chunk.length <= 4096)
  assert.deepEqual(splitAnswerText(''), [])
  assert.deepEqual(splitAnswerText('коротко'), ['коротко'])
})

test('extractAssistantText: склеивает текстовые блоки assistant/message', () => {
  assert.equal(extractAssistantText({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'раз' }, { type: 'tool-call' }, { type: 'text', text: 'два' }] } },
  }), 'раз\nдва')
  assert.equal(extractAssistantText({ type: 'user/message', data: {} }), '')
  assert.equal(sessionIdOf({ id: 'abc' }), 'abc')
  assert.equal(sessionIdOf({ header: { id: 'def' } }), 'def')
})

test('answers: begin показывает «⏳ Думаю…», turn/end редактирует в ответ', async () => {
  const h = harness()
  const began = await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: 'Иван' })
  assert.equal(began.messageId, 501)
  assert.equal(h.sent[0].text, THINKING_TEXT)
  assert.deepEqual(h.typing, ['555'])
  assert.equal(h.tracker.size(), 1)

  await h.tracker.handleEvent({ id: 's-1' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Ответ DSH' }] } },
  })
  assert.equal(h.edits.length, 0, 'до turn/end ничего не меняем')
  await h.tracker.handleEvent({ id: 's-1' }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } })
  assert.equal(h.edits.length, 1)
  assert.equal(h.edits[0].text, 'Ответ DSH')
  assert.equal(h.tracker.size(), 0)
  assert.equal(h.recorded.at(-1).text, 'Ответ DSH')
})

test('answers: длинный ответ приходит несколькими сообщениями', async () => {
  const h = harness()
  await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: '' })
  await h.tracker.finish('s-1', 'я'.repeat(5000))
  assert.equal(h.edits.length, 1)
  assert.ok(h.edits[0].text.length <= 4096)
  assert.equal(h.sent.length, 2, 'первое — «Думаю», второе — остаток ответа')
  assert.ok(h.sent[1].text.length > 0)
})

test('answers: пустой ход сообщает, что текста нет', async () => {
  const h = harness()
  await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: '' })
  await h.tracker.handleEvent({ id: 's-1' }, { type: 'turn/end', data: {} })
  assert.match(h.edits[0].text, /без текста/)
})

test('answers: fail заменяет «Думаю…» ошибкой', async () => {
  const h = harness()
  await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: '' })
  const ok = await h.tracker.fail('s-1', 'сессия занята')
  assert.equal(ok, true)
  assert.match(h.edits[0].text, /⚠️ Не выполнено: сессия занята/)
  assert.equal(h.tracker.size(), 0)
})

test('answers: timeout через 10 минут сообщает «Ответ не получен»', async () => {
  const h = harness({ timeoutMs: 600_000 })
  await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: '' })
  await h.tracker.sweep()
  assert.equal(h.edits.length, 0, 'до таймаута молчим')
  h.advance(600_001)
  await h.tracker.sweep()
  assert.equal(h.edits[0].text, ANSWER_TIMEOUT_TEXT)
  assert.match(h.edits[0].text, /10 минут/)
  assert.equal(h.tracker.size(), 0)
})

test('answers: turn/end другой сессии не трогает чужой ответ', async () => {
  const h = harness()
  await h.tracker.begin({ sessionId: 's-1', chatId: '555', chatTitle: '' })
  await h.tracker.handleEvent({ id: 's-2' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'чужой' }] } },
  })
  await h.tracker.handleEvent({ id: 's-2' }, { type: 'turn/end', data: {} })
  assert.equal(h.edits.length, 0)
  assert.equal(h.tracker.size(), 1)
})
