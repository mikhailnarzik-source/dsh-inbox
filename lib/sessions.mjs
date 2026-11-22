/**
 * The bridge between the bot and DSH sessions.
 *
 * The bot is a remote control: `/sessions` lists what DSH can talk to, `/use`
 * routes one chat to one session, and `/ask`, `/steer`, `/new`, `/cancel` drive
 * that session through the Host `sessionController` service. `sessionQuery`
 * supplies titles for cold sessions without activating them.
 *
 * The controller lives behind `ctx.get('sessionController')`, so a profile
 * without the web/desktop API answers with one readable Russian error instead
 * of crashing the polling loop.
 */

import { randomUUID } from 'node:crypto'

/** Default timeout of one DSH call made on behalf of a chat message. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default number of sessions listed by `/sessions`. */
export const MAX_LISTED_SESSIONS = 10

/** A failure of the session surface, worded for the chat. */
export class SessionsError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'SessionsError'
    this.code = options.code ?? 'sessions'
  }
}

/** One abortable timeout signal for a Host call. */
function timeoutSignal(ms = DEFAULT_TIMEOUT_MS) {
  return AbortSignal.timeout(ms)
}

/** The title string of a controller list row, tolerant to both wire shapes. */
function titleFromRow(item) {
  const value = item?.projections?.values?.title
  if (typeof value === 'string') return value.trim()
  if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title.trim()
  return ''
}

/** Turn a resolveAgent failure into one Russian sentence. */
function resolveErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'session/not-found') return 'Сессия не найдена: возможно, её удалили. Отправьте /sessions и выберите заново.'
  if (code === 'session/agent-busy') return 'Сессией сейчас управляет субагент — этот бот не может в неё писать.'
  if (code === 'session/writer-held') return 'Сессию удерживает другой писатель: закройте её в другом окне DSH и повторите.'
  if (typeof error?.message === 'string' && error.message !== '') return error.message
  return 'DSH не смог открыть сессию.'
}

/** Wrap an unexpected Host failure with context. */
function wrapError(error, prefix) {
  if (error instanceof SessionsError) return error
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
  return new SessionsError(`${prefix}: ${message}`, { code: error?.code })
}

/**
 * Build the session gateway.
 *
 * @param options - `{ getController, getQuery, maxListed?, newRequestId? }`:
 *   lazy accessors for the two Host services, so a late-mounted controller is
 *   still found; `newRequestId` is injectable for tests.
 * @returns the gateway used by commands and the plugin page.
 */
export function createSessionsGateway(options = {}) {
  const getController = typeof options.getController === 'function' ? options.getController : () => undefined
  const getQuery = typeof options.getQuery === 'function' ? options.getQuery : () => undefined
  const maxListed = Number.isFinite(options.maxListed) ? options.maxListed : MAX_LISTED_SESSIONS
  const newRequestId = typeof options.newRequestId === 'function' ? options.newRequestId : () => randomUUID()

  /** The controller or one readable failure. */
  function controllerOrThrow() {
    const controller = getController()
    if (controller === undefined || controller === null) {
      throw new SessionsError(
        'сервис sessionController не найден в этом профиле. Управление сессиями доступно только в DSH Web/Desktop.',
        { code: 'controller-unavailable' },
      )
    }
    return controller
  }

  /**
   * Fill missing titles from `sessionQuery`; a query failure is not fatal —
   * the row keeps its id-based fallback.
   * @param rows - list rows to enrich.
   * @param signal - cancellation.
   */
  async function fillTitles(rows, signal) {
    const query = getQuery()
    if (query === undefined || query === null || rows.length === 0) return
    const missing = rows.filter(row => row.title === '').map(row => row.sessionId)
    if (missing.length === 0) return
    try {
      const map = await readTitles(query, missing, signal)
      for (const row of rows) {
        const title = map.get(row.sessionId)
        if (typeof title === 'string' && title !== '') row.title = title
      }
    } catch {
      // titles are decoration; listing still works without them
    }
  }

  /** Read a title map from the query service. */
  async function readTitles(query, ids, signal) {
    const map = new Map()
    if (typeof query.readTitleSnapshots === 'function') {
      const results = await query.readTitleSnapshots(ids, signal ?? timeoutSignal())
      for (const entry of Array.isArray(results) ? results : []) {
        if (entry?.status === 'fulfilled') {
          const title = entry.value?.title?.title
          if (typeof title === 'string' && title !== '') map.set(String(entry.sessionId ?? entry.value?.session?.id ?? ''), title)
        }
      }
      return map
    }
    if (typeof query.readTitle === 'function') {
      for (const id of ids) {
        try {
          const snapshot = await query.readTitle(id, signal ?? timeoutSignal())
          if (typeof snapshot?.title === 'string' && snapshot.title !== '') map.set(String(id), snapshot.title)
        } catch {
          // one unreadable session must not fail the batch
        }
      }
    }
    return map
  }

  /**
   * Every visible session, live rows preferred over cold records, without
   * subagent children.
   * @param signal - cancellation.
   * @returns rows `{ sessionId, title, running, agentAvailable, updatedAt, live }`.
   */
  async function collectRows(signal) {
    const controller = controllerOrThrow()
    const query = getQuery()
    const rows = new Map()
    let items = []
    try {
      const value = await controller.list({}, signal ?? timeoutSignal())
      items = Array.isArray(value?.items) ? value.items : []
    } catch (error) {
      throw wrapError(error, 'DSH не отдал список сессий')
    }
    for (const item of items) {
      const id = String(item?.sessionId ?? '')
      if (id === '' || item?.origin === 'subagent') continue
      rows.set(id, {
        sessionId: id,
        title: titleFromRow(item),
        running: item?.running === true,
        agentAvailable: item?.agentAvailable === true,
        updatedAt: Number(item?.updatedAt) || 0,
        live: true,
        blank: item?.blank === true,
        cwd: typeof item?.cwd === 'string' ? item.cwd : '',
      })
    }
    if (query !== undefined && query !== null && typeof query.listSessions === 'function') {
      let records = []
      try {
        records = await query.listSessions(signal ?? timeoutSignal())
      } catch {
        records = []
      }
      for (const record of Array.isArray(records) ? records : []) {
        const header = record?.header ?? {}
        const id = String(header.id ?? '')
        if (id === '' || header.origin === 'subagent' || rows.has(id)) continue
        rows.set(id, {
          sessionId: id,
          title: '',
          running: false,
          agentAvailable: false,
          updatedAt: Number(header.createdAt) || 0,
          live: false,
          blank: false,
          cwd: typeof header.cwd === 'string' ? header.cwd : '',
        })
      }
    }
    return [...rows.values()]
  }

  return {
    /** Whether the Host session controller is composed right now. */
    available() {
      const controller = getController()
      return controller !== undefined && controller !== null
    },
    /**
     * The newest non-subagent sessions.
     * @param options - `{ limit?, signal? }`.
     * @returns rows with titles filled in.
     */
    async list(options = {}) {
      const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || maxListed)))
      const rows = await collectRows(options.signal)
      const sorted = rows.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
      await fillTitles(sorted, options.signal)
      return sorted
    },
    /**
     * Titles for the given ids, without activating anything.
     * @param ids - session ids.
     * @param signal - cancellation.
     * @returns `Map<sessionId, title>`; unknown ids are absent.
     */
    async titlesFor(ids, signal) {
      const query = getQuery()
      const unique = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id ?? '')).filter(id => id !== ''))]
      if (unique.length === 0) return new Map()
      if (query === undefined || query === null) return new Map()
      try {
        return await readTitles(query, unique, signal)
      } catch {
        return new Map()
      }
    },
    /**
     * One title, or '' when it cannot be read.
     * @param sessionId - session id.
     * @returns the title.
     */
    async titleFor(sessionId) {
      const map = await this.titlesFor([sessionId])
      return map.get(String(sessionId)) ?? ''
    },
    /**
     * Describe one session without resuming its Agent.
     * @param sessionId - session id.
     * @returns `{ sessionId, title, running }`.
     */
    async describe(sessionId) {
      const id = String(sessionId ?? '')
      if (id === '') return { sessionId: '', title: '', running: false }
      let row
      try {
        row = (await collectRows()).find(item => item.sessionId === id)
      } catch {
        row = undefined
      }
      let title = row?.title ?? ''
      if (title === '') title = await this.titleFor(id)
      return { sessionId: id, title, running: row?.running === true }
    },
    /**
     * Resolve (or resume) the live Agent of one session.
     * @param sessionId - session id.
     * @returns `{ agent, status }`.
     */
    async resolve(sessionId) {
      const controller = controllerOrThrow()
      let result
      try {
        result = await controller.resolveAgent(sessionId)
      } catch (error) {
        throw wrapError(error, 'DSH не смог открыть сессию')
      }
      if (result !== null && typeof result === 'object' && result.agent !== undefined) {
        return { agent: result.agent, status: result.agent?.status }
      }
      throw new SessionsError(resolveErrorMessage(result?.error), { code: result?.error?.code ?? 'resolve' })
    },
    /**
     * Queue or steer one text message into a session.
     * @param request - `{ sessionId, mode: 'queue'|'steer', text, signal? }`.
     * @returns `{ accepted }`.
     */
    async prompt({ sessionId, mode, text, signal }) {
      const controller = controllerOrThrow()
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') throw new SessionsError('Текст сообщения пуст.', { code: 'empty-text' })
      // Resolving first gives the chat a specific reason (deleted, busy, held)
      // instead of a generic admission failure.
      await this.resolve(sessionId)
      let result
      try {
        result = await controller.prompt({
          requestId: newRequestId(),
          sessionId,
          mode: mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text: value }],
        }, signal ?? timeoutSignal())
      } catch (error) {
        throw wrapError(error, 'DSH не принял сообщение')
      }
      if (result?.accepted !== true) throw new SessionsError('DSH не принял сообщение в сессию.', { code: 'not-accepted' })
      return { accepted: true }
    },
    /**
     * Cancel the active turn of one session.
     * @param sessionId - session id.
     * @returns `{ accepted }`.
     */
    async cancel(sessionId) {
      const controller = controllerOrThrow()
      let result
      try {
        result = await controller.cancel({ sessionId })
      } catch (error) {
        throw wrapError(error, 'DSH не смог отменить сессию')
      }
      return { accepted: result?.accepted !== false }
    },
    /**
     * Create one ordinary Session.
     * @param options - `{ cwd?, signal? }`.
     * @returns `{ sessionId }`.
     */
    async create(options = {}) {
      const controller = controllerOrThrow()
      let result
      try {
        result = await controller.create(
          typeof options.cwd === 'string' && options.cwd !== '' ? { cwd: options.cwd } : {},
        )
      } catch (error) {
        throw wrapError(error, 'DSH не смог создать сессию')
      }
      const sessionId = String(result?.sessionId ?? '')
      if (sessionId === '') throw new SessionsError('DSH не вернул идентификатор новой сессии.', { code: 'create' })
      return { sessionId }
    },
  }
}
