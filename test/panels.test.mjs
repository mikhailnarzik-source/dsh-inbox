/**
 * Тесты панелей dsh-inbox: main-панель (страница настроек без блоков
 * плагин-менеджера) и строка левой панели, которая живёт только у
 * закреплённой панели и реагирует на событие dsh-polish.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PANEL_VISIBILITY_KEY = 'dsh-polish:panel-visibility'
const PANELS_CHANGED_EVENT = 'dsh-polish:panels-changed'

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

function elements(node, found = []) {
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const item of node) elements(item, found)
    return found
  }
  if (typeof node === 'object' && node.type !== undefined) {
    found.push(node)
    elements(node.props?.children, found)
  }
  return found
}

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
  if (typeof node === 'object') texts(node.props?.children, found)
  return found
}

/** Хранилище в памяти с тем же API, что у localStorage. */
function createStorage(initial) {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value))
    },
    removeItem: key => {
      data.delete(key)
    },
  }
}

/**
 * Загрузить client.js как браузерный загрузчик, с окном, хранилищем и
 * поддержкой события dsh-polish.
 * @param options - `{storage}`: сохранённые ключи localStorage.
 */
async function loadClient(options = {}) {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const captured = {}
  const storage = createStorage(options.storage)
  const listeners = new Map()
  const window = {
    __ModuleLoader__: {
      load(loadOptions) {
        captured.options = loadOptions
      },
    },
    localStorage: storage,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      listeners.set(type, list.filter(item => item !== handler))
    },
  }
  const sandbox = {
    window,
    console: { error: () => {}, warn: () => {}, log: () => {} },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured.options !== undefined, 'ModuleLoader.load вызван')
  assert.equal(captured.options.id, 'dsh-inbox')

  const module = captured.options.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`неожиданный модуль ${name}`)
  })

  const registered = []
  const injected = []
  const ctx = {
    effect: callback => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => {},
      bind: namespace => key => `${namespace}.${key}`,
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(registerOptions, component) {
        const entry = { options: registerOptions, component }
        registered.push(entry)
        return () => {
          const index = registered.indexOf(entry)
          if (index >= 0) registered.splice(index, 1)
        }
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

  return {
    module,
    storage,
    registered,
    injected,
    /** Состояние панелей, которое записал бы dsh-polish. */
    setPanelState(pinned) {
      storage.setItem(PANEL_VISIBILITY_KEY, JSON.stringify({ visible: pinned, pinned }))
    },
    /** Событие dsh-polish: панели пересчитаны. */
    firePanelsChanged() {
      for (const handler of listeners.get(PANELS_CHANGED_EVENT) ?? []) handler({ type: PANELS_CHANGED_EVENT })
    },
    findPanel(name) {
      return registered.find(entry => entry.options.name === name)
    },
  }
}

test('main-панель: страница настроек без блоков плагин-менеджера', async () => {
  const { module, findPanel } = await loadClient()
  const main = findPanel('main')
  assert.ok(main !== undefined, 'main-панель зарегистрирована')
  assert.equal(main.options.key, 'plugin-inbox')
  assert.equal(module.__test.PANEL_ID, 'plugin-inbox')
  assert.equal(module.__test.PANEL_ORDER, 27)

  const tree = render(main.component({}))
  assert.equal(tree.type, 'div', 'страница — обычный контейнер')

  // Центрированная страница: maxWidth 960, margin auto, padding 24 28 40.
  assert.equal(tree.props.className, 'dsh-inbox')
  assert.equal(tree.props.style.maxWidth, 960)
  assert.equal(tree.props.style.margin, '0 auto')
  assert.equal(tree.props.style.padding, '24px 28px 40px')

  // Шапка: эмодзи, название, короткий подзаголовок.
  const all = elements(tree)
  const header = all.find(node => node.type === 'header')
  assert.ok(header !== undefined, 'шапка страницы')
  const icon = all.find(node => node.props?.className === 'dsh-inbox-icon')
  assert.ok(icon !== undefined, 'иконка в шапке')
  assert.equal(texts(icon).join(''), '📥')
  const labels = texts(tree).join('\n')
  assert.ok(labels.includes('inbox.pageTitle'), 'название в шапке')
  assert.ok(labels.includes('inbox.pageSubtitle'), 'подзаголовок в шапке')

  // Блоков страницы плагин-менеджера на панели нет: нет ни заголовков
  // «Описание/Источник/Версия», ни разметки детальной страницы пакета.
  const blockTitles = new Set(['описание', 'источник', 'версия', 'description', 'source', 'version', 'описание:', 'источник:', 'версия:'])
  for (const text of texts(tree)) {
    assert.ok(!blockTitles.has(text.trim().toLowerCase()), `на панели нет блока «${text}»`)
  }
  const managerMarks = all.filter(node => {
    const className = typeof node.props?.className === 'string' ? node.props.className : ''
    return /plugin-manager|plugin-detail|detail-block/.test(className)
  })
  assert.equal(managerMarks.length, 0, 'нет разметки плагин-менеджера')
  assert.equal(all.filter(node => 'subject' in (node.props ?? {})).length, 0, 'панель не получает subject плагина')
})

test('строка левой панели: есть при закреплённой панели, нет у откреплённой', async () => {
  // Состояния нет — как в dsh-polish, панель видима и закреплена.
  const fresh = await loadClient()
  const freshPanel = fresh.findPanel('sidebar.panellist')
  assert.ok(freshPanel !== undefined, 'строка зарегистрирована по умолчанию')
  assert.equal(freshPanel.options.id, 'plugin-inbox')
  assert.equal(freshPanel.options.order, 27)
  assert.equal(freshPanel.options.label(), 'inbox.panelLabel')
  const icon = render(freshPanel.component({ size: 24 }))
  assert.equal(icon.props['data-dsh-inbox-panel-icon'], 'inbox')
  assert.equal(texts(icon).join(''), '📥')
  assert.equal(icon.props.style.width, 24)

  // Панель откреплена — строки в левой панели нет.
  const unpinned = await loadClient({ storage: { [PANEL_VISIBILITY_KEY]: JSON.stringify({ visible: ['inbox'], pinned: [] }) } })
  assert.equal(unpinned.findPanel('sidebar.panellist'), undefined, 'откреплённая панель без строки')

  // main-панель при этом остаётся.
  assert.ok(unpinned.findPanel('main') !== undefined, 'main-панель всегда')
})

test('строка левой панели: реагирует на событие dsh-polish', async () => {
  const client = await loadClient({ storage: { [PANEL_VISIBILITY_KEY]: JSON.stringify({ visible: ['inbox'], pinned: [] }) } })
  assert.equal(client.findPanel('sidebar.panellist'), undefined)

  // Закрепили в меню «Ещё»: dsh-polish записал состояние и позвал событие.
  client.setPanelState(['inbox'])
  client.firePanelsChanged()
  assert.ok(client.findPanel('sidebar.panellist') !== undefined, 'строка вернулась после закрепления')

  // Открепили обратно: строка снята, повторное событие не плодит дублей.
  client.setPanelState([])
  client.firePanelsChanged()
  assert.equal(client.findPanel('sidebar.panellist'), undefined, 'строка снята после открепления')
  client.firePanelsChanged()
  assert.equal(client.registered.filter(entry => entry.options.name === 'sidebar.panellist').length, 0)
})
