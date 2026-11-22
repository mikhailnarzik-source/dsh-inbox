import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  fakeContext,
  installFetch,
  telegramResponse,
  withTempInbox,
} from './helpers.mjs'

const TOKEN = '123456789:AAHfakeTOKENvalue_0123456789abcdef'

/** History with one incoming message. */
const SEED = {
  version: 1,
  offset: 5,
  enabled: false,
  botUsername: 'dsh_inbox_test_bot',
  messages: [{
    chatId: '555',
    chatTitle: 'Иван',
    from: 'Иван',
    text: 'Привет из Telegram',
    at: '2026-11-22T10:00:00.000Z',
    direction: 'in',
  }],
}

/** Load the module and mount it on a fake context. */
async function mount(options = {}) {
  const module = await import('../index.js')
  const ctx = fakeContext(options)
  module.apply(ctx)
  return ctx
}

test('инструменты: зарегистрированы шесть telegram_* инструментов', async () => {
  await withTempInbox(async () => {
    const ctx = await mount()
    try {
      const names = ctx.toolsList.map(tool => tool.name).sort()
      assert.deepEqual(names, ['telegram_allow', 'telegram_allowed', 'telegram_messages', 'telegram_queue_status', 'telegram_send', 'telegram_status'])
      for (const tool of ctx.toolsList) {
        assert.equal(typeof tool.description, 'string', `${tool.name}: описание`)
        assert.equal(typeof tool.parameters, 'object', `${tool.name}: parameters`)
        assert.equal(tool.parameters.type, 'object', `${tool.name}: тип parameters`)
        assert.equal(typeof tool.execute, 'function', `${tool.name}: execute`)
        assert.equal(tool.output?.schema?.type, 'string', `${tool.name}: output.schema`)
        assert.equal(typeof tool.output?.render, 'function', `${tool.name}: output.render`)
        // В DSH 0.2.x у инструмента нет поля run.
        assert.equal('run' in tool, false, `${tool.name}: не должно быть run`)
      }
      const send = ctx.toolsList.find(tool => tool.name === 'telegram_send')
      assert.deepEqual(send.parameters.required, ['text'])
      assert.ok(send.parameters.properties.chatId)
      const messages = ctx.toolsList.find(tool => tool.name === 'telegram_messages')
      assert.ok(messages.parameters.properties.limit)
      const allow = ctx.toolsList.find(tool => tool.name === 'telegram_allow')
      assert.deepEqual(allow.parameters.required, ['chatId'])
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_status: без токена подсказывает, где его взять', async () => {
  await withTempInbox(async () => {
    const ctx = await mount()
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_status')
      const text = await tool.execute({})
      assert.match(text, /токен не сохранён/)
      assert.match(text, /refs\.TELEGRAM_BOT_TOKEN/)
      assert.match(text, /@BotFather/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_status: с токеном показывает бота, приём и историю', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const ctx = await mount({ token: TOKEN })
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_status')
      const text = await tool.execute({})
      assert.match(text, /токен сохранён/)
      assert.match(text, /@dsh_inbox_test_bot/)
      assert.match(text, /Приём сообщений: выключен/)
      assert.match(text, /История: 1 сообщений/)
      assert.match(text, /Последний чат: «Иван»/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_messages: печатает последние сообщения с направлением и чатом', async () => {
  await withTempInbox(async dir => {
    const messages = [
      ...SEED.messages,
      { chatId: '777', chatTitle: 'Даша', from: 'DSH', text: 'Ответ агента', at: '2026-11-22T10:05:00.000Z', direction: 'out' },
      { chatId: '555', chatTitle: 'Иван', from: 'Иван', text: 'Ещё привет', at: '2026-11-22T10:10:00.000Z', direction: 'in' },
    ]
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, messages }), 'utf8')
    const ctx = await mount({ token: TOKEN })
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_messages')
      const text = await tool.execute({ limit: 2 })
      assert.match(text, /2 из 3/)
      assert.match(text, /Ещё привет/)
      assert.match(text, /исходящее|входящее/)
      assert.match(text, /чат «Иван»/)
      assert.ok(!text.includes('Привет из Telegram'), 'лимит соблюдён')
      const all = await tool.execute({})
      assert.match(all, /3 из 3/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_messages: пустая история объясняет, как получить сообщения', async () => {
  await withTempInbox(async () => {
    const ctx = await mount()
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_messages')
      const text = await tool.execute({})
      assert.match(text, /История пуста/)
      assert.match(text, /Telegram/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_send: отвечает в последний чат и пишет историю', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(SEED), 'utf8')
    const mock = installFetch(({ method }) => {
      if (method === 'sendMessage') return telegramResponse({ message_id: 42, date: 1763800100 })
      throw new Error(`неожиданный метод ${method}`)
    })
    const ctx = await mount({ token: TOKEN })
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_send')
      const text = await tool.execute({ text: 'Ответ ассистента' })
      assert.match(text, /Отправлено в «Иван»/)
      assert.match(text, /message_id 42/)
      assert.deepEqual(mock.calls[0].body, { chat_id: '555', text: 'Ответ ассистента' })
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.equal(file.messages.length, 2)
      assert.equal(file.messages[1].direction, 'out')
      assert.equal(file.messages[1].from, 'DSH')
      assert.equal(file.messages[1].text, 'Ответ ассистента')
    } finally {
      mock.restore()
      await ctx.disposeAll()
    }
  })
})

test('telegram_allowed: пустой белый список предупреждает, что управлять нельзя', async () => {
  await withTempInbox(async () => {
    const ctx = await mount()
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_allowed')
      const text = await tool.execute({})
      assert.match(text, /Белый список пуст/)
      assert.match(text, /telegram_allow/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_allow: добавляет чат и пишет его в state.json', async () => {
  await withTempInbox(async dir => {
    const ctx = await mount()
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_allow')
      const text = await tool.execute({ chatId: '777' })
      assert.match(text, /Чат добавлен в белый список/)
      assert.match(text, /777/)
      const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
      assert.deepEqual(file.allowedChatIds, ['777'])
      const again = await tool.execute({ chatId: '777' })
      assert.match(again, /уже был/)
      await assert.rejects(() => tool.execute({ chatId: 'не чат' }), /Неверный chatId/)
      const list = await ctx.toolsList.find(item => item.name === 'telegram_allowed').execute({})
      assert.match(list, /777/)
      const status = await ctx.toolsList.find(item => item.name === 'telegram_status').execute({})
      assert.match(status, /Белый список: 1 чатов/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_status: показывает историю и белую команду', async () => {
  await withTempInbox(async dir => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, allowedChatIds: ['555'] }), 'utf8')
    const ctx = await mount({ token: TOKEN })
    try {
      const text = await ctx.toolsList.find(item => item.name === 'telegram_status').execute({})
      assert.match(text, /Белый список: 1 чатов: 555/)
      assert.match(text, /Приём сообщений: выключен/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_messages: сообщение из чужого чата помечено «нет доступа»', async () => {  await withTempInbox(async dir => {
    const messages = [{
      chatId: '999',
      chatTitle: 'Незнакомец',
      from: 'Незнакомец',
      text: '/help',
      at: '2026-11-22T10:00:00.000Z',
      direction: 'in',
      blocked: true,
    }]
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...SEED, messages }), 'utf8')
    const ctx = await mount({ token: TOKEN })
    try {
      const text = await ctx.toolsList.find(item => item.name === 'telegram_messages').execute({})
      assert.match(text, /⛔ нет доступа/)
      assert.match(text, /Незнакомец/)
    } finally {
      await ctx.disposeAll()
    }
  })
})

test('telegram_send: пустой текст, отсутствие чата и отсутствие токена — ошибки', async () => {
  await withTempInbox(async () => {
    const noToken = await mount()
    try {
      const tool = noToken.toolsList.find(item => item.name === 'telegram_send')
      await assert.rejects(() => tool.execute({ text: 'привет' }), /Токен Telegram не сохранён/)
    } finally {
      await noToken.disposeAll()
    }

    const empty = await mount({ token: TOKEN })
    try {
      const tool = empty.toolsList.find(item => item.name === 'telegram_send')
      await assert.rejects(() => tool.execute({ text: '   ' }), /пуст/)
      await assert.rejects(() => tool.execute({ text: 'а'.repeat(4097) }), /4096/)
      await assert.rejects(() => tool.execute({ text: 'привет' }), /Нет чата/)
    } finally {
      await empty.disposeAll()
    }
  })
})

test('telegram_queue_status: без remote показывает режим inline', async () => {
  await withTempInbox(async () => {
    const ctx = await mount()
    try {
      const tool = ctx.toolsList.find(item => item.name === 'telegram_queue_status')
      const text = await tool.execute({})
      assert.match(text, /Общая очередь команд: не настроена/)
      assert.match(text, /inline/)
      assert.match(text, /dsh-sync\.json/)
    } finally {
      await ctx.disposeAll()
    }
  })
})
