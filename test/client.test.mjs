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

/** Render function components down to plain host elements (children included). */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node === 'string' || typeof node === 'number') return node
  if (typeof node === 'object' && typeof node.type === 'function') return render(node.type(node.props ?? {}))
  if (typeof node === 'object' && node.props !== undefined) {
    const raw = node.props.children
    const children = Array.isArray(raw) ? raw.map(render) : render(raw)
    return { ...node, props: { ...node.props, children } }
  }
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

/** Collect every React element (object with a type) in the tree. */
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

/** Снимок подключённого бота: полная страница «Входящих». */
function connectedSnapshot(overrides = {}) {
  return {
    ok: true,
    configured: true,
    enabled: true,
    writable: true,
    botUsername: 'dsh_bot',
    allowedUserIds: ['123456789'],
    allowedChatIds: ['123456789'],
    chats: [],
    messages: [],
    totalMessages: 0,
    maxMessages: 200,
    currentSession: null,
    security: { groupsEnabled: false },
    owner: { userId: '123456789', chatId: '123456789' },
    botProfile: { ok: true, name: 'DSH', description: '', commands: [] },
    webhook: {},
    menu: { ok: true, at: 0, commands: [] },
    queue: { configured: false, counts: {}, devices: [], inProgress: [], listener: false },
    device: { name: 'PC', id: 'abcdef123456' },
    lastError: '',
    ...overrides,
  }
}

/** Страница в секции «Плагины» с заданным снимком состояния. */
async function renderPage(initialSnapshot) {
  const { registered } = await loadClient()
  const { component } = registered[0]
  const element = component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-inbox' } },
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
  })
  assert.notEqual(element, null)
  return render(element)
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
  const detail = registered.filter(entry => entry.options.name === 'plugins.detail.section')
  assert.equal(detail.length, 1)
  const { options, component } = detail[0]
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

test('client.js: без токена на странице только токен и «как получить»', async () => {
  const tree = await renderPage(undefined)
  const allClasses = classes(tree).join(' ')
  for (const className of ['dsh-inbox', 'dsh-inbox-card', 'dsh-inbox-input']) {
    assert.ok(allClasses.includes(className), `на странице есть ${className}`)
  }
  const labels = texts(tree).join(' ')
  for (const key of ['inbox.tokenLabel', 'inbox.howTitle', 'inbox.connectFirst', 'inbox.storedIn', 'inbox.verify']) {
    assert.ok(labels.includes(key), `на странице есть строка ${key}`)
  }
  assert.ok(hrefs(tree).includes('https://t.me/BotFather'), 'ссылка на @BotFather')
  // Белый список, сессия, команды и очередь — только после подключения.
  for (const key of ['inbox.allowTitle', 'inbox.sessionBlockTitle', 'inbox.commandsTitle', 'inbox.queueTitle', 'inbox.historyTitle', 'inbox.dangerTitle']) {
    assert.ok(!labels.includes(key), `без токена нет блока ${key}`)
  }
  assert.equal(allClasses.includes('dsh-inbox-switch'), false, 'переключателя приёма нет')
  assert.equal(allClasses.includes('dsh-inbox-reply'), false, 'ответа нет')
})

test('client.js: после подключения видны белый список, сессия, команды и очередь', async () => {
  const tree = await renderPage(connectedSnapshot({ allowedUserIds: [], allowedChatIds: [] }))
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
    'inbox.profileTitle',
    'inbox.profileRefresh',
    'inbox.securityTitle',
    'inbox.ownerLabel',
    'inbox.ownerHint',
    'inbox.groupsHint',
    'inbox.answersPending',
    'inbox.usersHint',
    'inbox.queueTitle',
    'inbox.queueInline',
    'inbox.commandsTitle',
    'inbox.cmdSessions',
    'inbox.cmdCancel',
    'inbox.dangerTitle',
    'inbox.moreTitle',
  ]) {
    assert.ok(labels.includes(key), `на странице есть строка ${key}`)
  }
  assert.ok(hrefs(tree).includes('https://t.me/BotFather'), 'ссылка на @BotFather')
})

test('client.js: «Очередь между устройствами» — в свёрнутом «Дополнительно»', async () => {
  const tree = await renderPage(connectedSnapshot())
  const accordions = elements(tree).filter(node => node.props?.className === 'dsh-inbox-acc' || node.props?.className === 'dsh-inbox-acc is-danger')
  assert.equal(accordions.length, 2, 'два аккордеона: «Дополнительно» и «Опасная зона»')
  const toggles = elements(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-inbox-acc-toggle'))
  assert.equal(toggles.length, 2)
  for (const toggle of toggles) assert.equal(toggle.props['aria-expanded'], 'false', 'по умолчанию свёрнуто')
  const bodies = elements(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-inbox-acc-body'))
  assert.equal(bodies.length, 2)
  for (const body of bodies) assert.equal(body.props.hidden, true, 'тело скрыто атрибутом hidden')
  const more = accordions.find(node => !node.props.className.includes('is-danger'))
  assert.ok(elements(more).some(node => texts(node).join(' ').includes('inbox.queueTitle')), 'очередь внутри «Дополнительно»')
  const danger = accordions.find(node => node.props.className.includes('is-danger'))
  assert.ok(danger, 'опасная зона выделена красным')
  assert.equal(texts(danger).join(' ').includes('inbox.dangerTitle'), true)
  // Опасная зона — последний блок страницы.
  const page = elements(tree).find(node => node.props?.className === 'dsh-inbox')
  const last = [...page.props.children].filter(child => child !== null && child !== undefined).at(-1)
  assert.equal(last, danger, 'опасная зона внизу')
})

test('client.js: очистка истории и удаление токена — в «Опасной зоне» с подтверждением', async () => {
  const tree = await renderPage(connectedSnapshot({ messages: [{ at: new Date().toISOString(), direction: 'in', chatId: '1', chatTitle: 'Чат', text: 'привет' }] }))
  const danger = elements(tree).find(node => typeof node.props?.className === 'string' && node.props.className.includes('dsh-inbox-acc is-danger'))
  assert.ok(danger, 'опасная зона')
  const buttons = elements(danger).filter(node => node.type === 'button' && String(node.props.className ?? '').includes('is-danger'))
  assert.equal(buttons.length, 2, 'очистка истории и удаление токена')
  for (const button of buttons) {
    assert.equal(button.props.disabled, false)
    // Первый клик только взводит подтверждение, действие не выполняется.
    button.props.onClick()
  }
  // В обычной карточке истории кнопки очистки больше нет.
  const historyCard = elements(tree).find(node => node.props?.className === 'dsh-inbox-card'
    && elements(node).some(child => texts(child).join(' ') === 'inbox.historyTitle'))
  assert.ok(historyCard, 'карточка истории')
  assert.equal(elements(historyCard).some(node => node.type === 'button' && texts(node).join('') === 'inbox.clearTitle'), false)
})

test('client.js: сохранение рядом с полями — бейдж «есть изменения»', async () => {
  const tree = await renderPage(connectedSnapshot())
  const savebars = elements(tree).filter(node => node.props?.className === 'dsh-inbox-savebar')
  assert.equal(savebars.length, 3, 'токен, белый список и владелец — три ряда сохранения')
  const badges = savebars.map(bar => elements(bar).find(node => String(node.props?.className ?? '').startsWith('dsh-inbox-savebar-badge')))
  for (const badge of badges) {
    assert.ok(badge, 'бейдж изменений')
    assert.equal(badge.props.className, 'dsh-inbox-savebar-badge')
    assert.equal(texts(badge).join(''), 'inbox.noChanges')
  }
  // Сохранение стоит в той же карточке, что и поле.
  const tokenCard = elements(tree).find(node => node.props?.className === 'dsh-inbox-card'
    && elements(node).some(child => child.props?.id === 'dsh-inbox-token'))
  assert.ok(tokenCard, 'карточка токена')
  assert.ok(elements(tokenCard).some(node => node.props?.className === 'dsh-inbox-savebar'))
  assert.ok(elements(tokenCard).some(node => node.type === 'button' && texts(node).join('') === 'inbox.save'))
})

test('client.js: страница оформлена по единому стилю', async () => {
  const tree = await renderPage(connectedSnapshot())
  const all = elements(tree)

  // Центрированный контейнер 960: стиль задан и на контейнере, и в CSS.
  assert.equal(tree.props.className, 'dsh-inbox')
  assert.equal(tree.props.style.maxWidth, 960)
  assert.equal(tree.props.style.margin, '0 auto')
  assert.equal(tree.props.style.padding, '24px 28px 40px')
  assert.equal(tree.props.style.boxSizing, 'border-box')

  const style = all.find(node => node.type === 'style')
  assert.ok(style, 'страница подключает свой стиль')
  const css = String(style.props.children)
  assert.match(css, /max-width:960px/)
  assert.match(css, /margin:0 auto/)
  assert.match(css, /padding:24px 28px 40px/)
  assert.match(css, /@media \(max-width:900px\)/)
  assert.match(css, /@media \(max-width:640px\)/)
  assert.match(css, /--dsw-alias-bg-layer-1/)
  assert.match(css, /border-radius:14px/)
  assert.match(css, /height:36px/)
  assert.match(css, /:focus-visible/)

  // Шапка: иконка-квадрат 52, заголовок, подзаголовок, чипы и кнопка «Обновить».
  const header = all.find(node => node.type === 'header')
  assert.ok(header, 'шапка страницы')
  assert.equal(header.props.className, 'dsh-inbox-header')
  const icon = all.find(node => node.props?.className === 'dsh-inbox-icon')
  assert.ok(icon, 'иконка в шапке')
  assert.equal(icon.props['aria-hidden'], true)
  assert.equal(texts(icon).join(''), '📥')
  assert.equal(icon.props.style ?? null, null)
  assert.match(css, /\.dsh-inbox-icon\{[^}]*width:52px/)
  assert.equal(all.find(node => node.props?.className === 'dsh-inbox-h1').props.children, 'inbox.pageTitle')
  assert.equal(all.find(node => node.props?.className === 'dsh-inbox-subtitle').props.children, 'inbox.pageSubtitle')
  assert.match(css, /\.dsh-inbox-h1\{[^}]*font-size:20px/)
  assert.match(css, /\.dsh-inbox-h1\{[^}]*font-weight:600/)

  const pills = all.filter(node => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-inbox-pill'))
  assert.ok(pills.length >= 2, 'чипы статуса в шапке')
  assert.match(css, /\.dsh-inbox-pill::before/)
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*height:32px/, 'чип — кнопка: height 32')
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*border-radius:10px/, 'чип — не пилюля: radius 10')
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*padding:0 12px/, 'padding чипа 0 12')
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*border:1px solid/, 'у чипа рамка 1px')
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*font-size:12\.5px/, 'шрифт чипа 12.5')
  assert.match(css, /\.dsh-inbox-pill,\.dsh-inbox-badge\{[^}]*font-weight:600/, 'шрифт чипа 600')
  assert.match(css, /\.dsh-inbox-pill::before,\.dsh-inbox-badge::before\{[^}]*width:6px[^}]*height:6px/, 'точка-индикатор 6px')

  const refreshButton = all.find(node => typeof node.props?.className === 'string'
    && node.props.className.includes('dsh-inbox-button')
    && texts(node).join('') === 'inbox.refresh')
  assert.ok(refreshButton, 'кнопка «Обновить» в шапке')
  assert.equal(typeof refreshButton.props.onClick, 'function', 'обновление подключено')

  // Карточки-секции: каждая с заголовком и акцентной полоской из CSS.
  const cards = all.filter(node => node.props?.className === 'dsh-inbox-card')
  assert.ok(cards.length >= 8, `секций на странице: ${cards.length}`)
  for (const card of cards) {
    const titled = elements(card).some(node => node.props?.className === 'dsh-inbox-card-title')
    assert.ok(titled, 'у каждой карточки есть заголовок секции')
  }
  assert.match(css, /\.dsh-inbox-card-title::before\{[^}]*width:3px/)

  // Списки: hover и пустое состояние истории.
  assert.match(css, /\.dsh-inbox-message:hover/)
  assert.match(css, /\.dsh-inbox-session:hover/)
  assert.match(css, /\.dsh-inbox-empty\{/)
  const empty = all.find(node => node.props?.className === 'dsh-inbox-empty')
  assert.ok(empty, 'пустое состояние истории')
  assert.ok(texts(empty).join(' ').includes('inbox.historyEmpty'))
})

test('client.js: кнопки — единая система, без белого на белом и fixed width', async () => {
  const { registered } = await loadClient()
  const { component } = registered[0]
  const tree = render(component({ subject: { kind: 'bundle', pkg: { name: 'dsh-inbox' } } }))
  const all = elements(tree)
  const style = all.find(node => node.type === 'style')
  assert.ok(style, 'страница подключает свой стиль')
  const css = String(style.props.children)

  // Геометрия и типографика кнопок — по спеке.
  assert.match(css, /\.dsh-inbox-button\{[^}]*box-sizing:border-box/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*display:inline-flex/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*height:36px/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*padding:0 14px/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*border-radius:10px/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*font-size:12\.5px/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*font-weight:600/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*white-space:nowrap/)
  assert.match(css, /\.dsh-inbox-button\{[^}]*min-width:0/)
  assert.match(css, /\.dsh-inbox-button\.is-small\{height:32px/)
  assert.match(css, /\.dsh-inbox-chip \.dsh-inbox-button\{height:28px/)
  assert.match(css, /\.dsh-inbox-button:disabled\{opacity:\.55/)
  assert.match(css, /\.dsh-inbox-button:focus-visible\{outline:2px solid color-mix/)

  // Варианты: мягкие заливки из токенов, никакого белого текста на белом.
  assert.match(css, /\.dsh-inbox-button\.is-primary\{[^}]*color-mix\(in srgb,var\(--dsw-alias-brand-primary\) 18%,transparent\)/)
  assert.match(css, /\.dsh-inbox-button\.is-primary\{[^}]*color:var\(--dsw-alias-brand-primary\)/)
  assert.doesNotMatch(css, /\.dsh-inbox-button\.is-primary\{[^}]*color:#fff/)
  assert.doesNotMatch(css, /\.dsh-inbox-button\.is-primary\{[^}]*background:var\(--dsw-alias-brand-primary\)/)
  assert.match(css, /\.dsh-inbox-button\.is-primary:hover:not\(:disabled\)\{background:color-mix\(in srgb,var\(--dsw-alias-brand-primary\) 28%,transparent\)/)
  assert.match(css, /\.dsh-inbox-button\.is-danger\{[^}]*color-mix\(in srgb,var\(--dsw-alias-state-error-primary\) 16%,transparent\)/)
  assert.match(css, /\.dsh-inbox-button:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover/)
  assert.doesNotMatch(css, /var\(--dsw-alias-button-primary-fill\)/, 'нет старой сплошной заливки brand')

  // В шапке — маленькая кнопка 28/32, не 36.
  const header = all.find(node => node.type === 'header')
  const headerButton = elements(header).find(node => node.type === 'button')
  assert.ok(headerButton, 'кнопка «Обновить» в шапке')
  assert.match(headerButton.props.className, /is-small/)

  // Адаптив: никаких фиксированных ширин полей, медиа 900/640, переносы.
  assert.match(css, /\.dsh-inbox-input\{[^}]*min-width:0/)
  assert.match(css, /\.dsh-inbox-reply\{[^}]*min-width:0/)
  assert.doesNotMatch(css, /min-width:200px/)
  assert.match(css, /\.dsh-inbox-text\{[^}]*overflow-wrap:anywhere/)
  assert.match(css, /\.dsh-inbox-row\{[^}]*flex-wrap:wrap/)
  assert.match(css, /@media \(max-width:900px\)/)
  assert.match(css, /@media \(max-width:640px\)\{\.dsh-inbox\{padding:16px 14px 28px/)
})
