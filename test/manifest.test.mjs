import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Read and parse one JSON file of the plugin. */
async function readJson(relative) {
  return JSON.parse(await readFile(join(ROOT, relative), 'utf8'))
}

/** Assert that a plugin file exists. */
async function exists(relative) {
  await access(join(ROOT, relative))
}

test('package.json: bundle-патч, клиент, версия 0.1.0 и экспорты ресурсов', async () => {
  const manifest = await readJson('package.json')
  assert.equal(manifest.name, 'dsh-inbox')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.client?.immediately, true)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-slots',
  ])
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.icon, './icon.svg')
  for (const entry of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale/*.json', 'docs', 'icon.svg', 'README.md', 'test']) {
    assert.ok(manifest.files.includes(entry), `files содержит ${entry}`)
  }
  assert.equal(manifest.scripts?.test, 'node --test test/*.test.mjs')
})

test('cordis.patch.yml вставляет строку dsh-inbox', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: dsh-inbox/)
  assert.match(patch, /name: dsh-inbox/)
})

test('локали ru и en: meta.title/description/detail и документ существует', async () => {
  for (const locale of ['ru', 'en']) {
    const data = await readJson(`locale/${locale}.json`)
    assert.equal(typeof data.meta?.title, 'string', `${locale}: title`)
    assert.ok(data.meta.title.length > 1, `${locale}: title не пустой`)
    assert.equal(typeof data.meta?.description, 'string', `${locale}: description`)
    assert.ok(data.meta.description.length > 60, `${locale}: description содержательный`)
    assert.equal(data.meta.detail, 'docs/DETAIL.md', `${locale}: detail`)
  }
  const ru = await readJson('locale/ru.json')
  assert.match(ru.meta.title, /Входящие/)
  assert.match(ru.meta.description, /Telegram/)
  const en = await readJson('locale/en.json')
  assert.equal(en.meta.title, 'Inbox')
})

test('ресурсы на месте: index.js, client.js, lib, icon.svg, README, docs/DETAIL.md', async () => {
  for (const relative of [
    'index.js',
    'client.js',
    'icon.svg',
    'README.md',
    'docs/DETAIL.md',
    'lib/paths.mjs',
    'lib/storage.mjs',
    'lib/messages.mjs',
    'lib/telegram.mjs',
    'lib/polling.mjs',
    'lib/tools.mjs',
  ]) {
    await exists(relative)
  }
  const icon = await readFile(join(ROOT, 'icon.svg'), 'utf8')
  assert.match(icon, /^<svg /)
  assert.match(icon, /viewBox="0 0 24 24"/)
  assert.ok(!icon.includes('\uFFFD'))
})

test('index.js объявляет имя, inject и apply, не содержит прямых секретов', async () => {
  const module = await import('../index.js')
  assert.equal(module.name, 'dsh-inbox')
  assert.deepEqual(module.inject, ['tools', 'credentials', 'connection', 'sessionPersistence'])
  assert.equal(typeof module.apply, 'function')
  const source = await readFile(join(ROOT, 'index.js'), 'utf8')
  for (const path of [
    '/api/dsh-inbox/state',
    '/api/dsh-inbox/verify',
    '/api/dsh-inbox/send',
    '/api/dsh-inbox/polling',
    '/api/dsh-inbox/messages/clear',
  ]) {
    assert.ok(source.includes(path), `маршрут ${path} объявлен`)
  }
  const { createTools } = await import('../lib/tools.mjs')
  const toolNames = createTools({
    ready: Promise.resolve(),
    tokenInfo: async () => ({ configured: false, writable: true }),
    snapshot: () => ({ messages: [], botUsername: '', enabled: false, lastError: '' }),
    polling: () => false,
    sendReply: async () => ({}),
  }).map(tool => tool.name).sort()
  assert.deepEqual(toolNames, ['telegram_messages', 'telegram_send', 'telegram_status'])
  assert.equal(source.includes('\uFFFD'), false, 'нет битых символов')
})

test('README и docs/DETAIL.md: инструкция для новичка и @BotFather', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /@BotFather/)
  assert.match(readme, /\/newbot/)
  assert.match(readme, /TELEGRAM_BOT_TOKEN/)
  assert.match(readme, /Плагины/)
  assert.match(readme, /Как открыть/)
  assert.match(readme, /Ограничения/)
  const detail = await readFile(join(ROOT, 'docs', 'DETAIL.md'), 'utf8')
  assert.match(detail, /@BotFather/)
  assert.match(detail, /Что это и зачем/)
  assert.match(detail, /Как открыть/)
  assert.match(detail, /Как пользоваться пошагово/)
  assert.match(detail, /Что вы увидите/)
  assert.match(detail, /Частые ошибки/)
  assert.match(detail, /Ограничения/)
  assert.match(detail, /Связанные плагины/)
  for (const text of [readme, detail]) {
    assert.equal(text.includes('\uFFFD'), false, 'нет битых символов')
  }
})
