import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Minimal React stand-in: hooks return their initial values and do nothing. */
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
  useCallback: callback => callback,
  useMemo: factory => factory(),
}

/** Render function components down to plain host elements. */
function render(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'object' && typeof node.type === 'function') return render(node.type(node.props ?? {}))
  return node
}

/** Collect every string in a React element tree. */
function texts(node, found = []) {
  if (node === null || node === undefined) return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, found)
    return found
  }
  if (typeof node === 'object' && node.props !== undefined) texts(node.props.children, found)
  return found
}

/** Collect every class name in a React element tree. */
function classes(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const item of node) classes(item, found)
    return found
  }
  if (typeof node === 'object' && node.props !== undefined) {
    if (typeof node.props.className === 'string') found.push(node.props.className)
    classes(node.props.children, found)
  }
  return found
}

/** Collect every href in a React element tree. */
function hrefs(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const item of node) hrefs(item, found)
    return found
  }
  if (typeof node === 'object' && node.props !== undefined) {
    if (typeof node.props.href === 'string') found.push(node.props.href)
    hrefs(node.props.children, found)
  }
  return found
}

/**
 * Load `client.js` the way the browser module loader does.
 * @returns `{ module, locales, injected, registered }`.
 */
async function loadClient() {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const captured = {}
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          captured.options = options
        },
      },
    },
    console: { error: () => {}, warn: () => {}, log: () => {} },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured.options !== undefined, 'ModuleLoader.load вызван')
  assert.equal(captured.options.id, 'dsh-inbox')

  const module = captured.options.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`неожиданный модуль ${name}`)
  })
  assert.equal(typeof module.apply, 'function')
  // The factory creates its exports inside the vm realm; copy them out.
  assert.deepEqual([...module.inject], ['slots', 'locale', 'remote', 'remote.credentials'])
  assert.equal(module.NS, 'inbox')

  const locales = []
  const injected = []
  const registered = []
  const ctx = {
    effect: callback => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries })
      },
      bind(namespace) {
        return key => `${namespace}.${key}`
      },
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    remote: {
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        set: async () => {},
        unset: async () => {},
      },
      $on: () => () => {},
    },
  }
  module.apply(ctx)
  return { module, locales, injected, registered }
}

test('client.js: словари en и ru с одинаковым набором ключей', async () => {
  const { module, locales } = await loadClient()
  assert.equal(locales.length, 1)
  const { namespace, dictionaries } = locales[0]
  assert.equal(namespace, 'inbox')
  assert.equal(dictionaries.en.pageTitle, 'Inbox')
  assert.equal(dictionaries.ru.pageTitle, 'Входящие')
  const enKeys = Object.keys(dictionaries.en).sort()
  const ruKeys = Object.keys(dictionaries.ru).sort()
  assert.deepEqual(enKeys, ruKeys, 'словари описывают одни и те же строки')

  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map(match => match[1]))
  assert.ok(used.size > 30, `строк используется много: ${used.size}`)
  for (const key of used) {
    assert.ok(enKeys.includes(key), `en: есть ключ ${key}`)
    assert.ok(ruKeys.includes(key), `ru: есть ключ ${key}`)
  }
  assert.equal(module.NS, 'inbox')
})

test('client.js: регистрирует секцию plugins.detail.section для dsh-inbox', async () => {
  const { injected, registered } = await loadClient()
  assert.ok(injected.includes('plugins.detail.section'), 'секция объявлена через slots.inject')
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'plugins.detail.section')
  assert.equal(options.id, 'dsh-inbox-detail')
  assert.equal(options.locale, 'inbox')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof component, 'function')

  assert.equal(component({ subject: { kind: 'bundle', pkg: { name: 'dsh-other' } } }), null)
  assert.equal(component({ subject: { id: 'dsh-other' } }), null)
})

test('client.js: сводка в списке плагинов рисуется без ошибок', async () => {
  const { registered } = await loadClient()
  const { component } = registered[0]
  const element = component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-inbox' } },
    view: 'summary',
  })
  assert.notEqual(element, null)
  const labels = texts(render(element)).join(' ')
  assert.match(labels, /inbox\.pageTitle/)
  assert.match(labels, /inbox\.statusNoToken/)
  assert.match(labels, /inbox\.pollingOff/)
})

test('client.js: страница рисуется без ошибок и содержит все блоки', async () => {
  const { registered } = await loadClient()
  const { component } = registered[0]
  const element = component({ subject: { kind: 'bundle', pkg: { name: 'dsh-inbox' } } })
  assert.notEqual(element, null)
  const tree = render(element)
  const allClasses = classes(tree).join(' ')
  for (const className of ['dsh-inbox', 'dsh-inbox-card', 'dsh-inbox-input', 'dsh-inbox-switch', 'dsh-inbox-reply', 'dsh-inbox-textarea']) {
    assert.ok(allClasses.includes(className), `на странице есть ${className}`)
  }
  const labels = texts(tree).join(' ')
  for (const key of [
    'inbox.tokenLabel',
    'inbox.receiveTitle',
    'inbox.historyTitle',
    'inbox.historyEmpty',
    'inbox.replyLabel',
    'inbox.howTitle',
    'inbox.allowTitle',
    'inbox.allowEmpty',
    'inbox.sessionBlockTitle',
    'inbox.menuTitle',
    'inbox.menuUpdate',
    'inbox.commandsTitle',
    'inbox.cmdSessions',
    'inbox.cmdCancel',
  ]) {
    assert.ok(labels.includes(key), `на странице есть строка ${key}`)
  }
  assert.ok(hrefs(tree).includes('https://t.me/BotFather'), 'ссылка на @BotFather')
})
