/**
 * Turning Telegram updates into history records.
 *
 * Only `message` updates are requested from the Bot API (`allowed_updates`),
 * and only updates that carry text or a caption become records: a sticker,
 * photo without caption or a service message has nothing to show in a list.
 */

/**
 * Human-readable name of a Telegram user.
 * @param from - `from` field of a message.
 * @returns the first and last name, else the @username, else the numeric id.
 */
export function displayName(from) {
  if (from === null || typeof from !== 'object') return ''
  const parts = []
  if (typeof from.first_name === 'string' && from.first_name !== '') parts.push(from.first_name)
  if (typeof from.last_name === 'string' && from.last_name !== '') parts.push(from.last_name)
  if (parts.length > 0) return parts.join(' ')
  if (typeof from.username === 'string' && from.username !== '') return `@${from.username}`
  if (from.id !== undefined && from.id !== null) return String(from.id)
  return ''
}

/**
 * Human-readable name of a chat.
 * @param chat - `chat` field of a message.
 * @returns the group title, else the @username, else the person's name, else the id.
 */
export function chatTitle(chat) {
  if (chat === null || typeof chat !== 'object') return ''
  if (typeof chat.title === 'string' && chat.title !== '') return chat.title
  if (typeof chat.username === 'string' && chat.username !== '') return `@${chat.username}`
  const name = displayName(chat)
  if (name !== '') return name
  return chat.id !== undefined && chat.id !== null ? String(chat.id) : ''
}

/**
 * Build one incoming record from an update.
 * @param update - item of `getUpdates`.
 * @returns the record, or `undefined` when the update is not a text message.
 */
export function messageFromUpdate(update) {  if (update === null || typeof update !== 'object') return undefined
  const message = update.message
  if (message === null || typeof message !== 'object') return undefined
  const chat = message.chat ?? {}
  const chatId = chat.id !== undefined && chat.id !== null ? String(chat.id) : ''
  if (chatId === '') return undefined
  const text = typeof message.text === 'string' && message.text !== ''
    ? message.text
    : typeof message.caption === 'string' && message.caption !== ''
      ? message.caption
      : ''
  if (text === '') return undefined
  const date = Number.isFinite(message.date) ? message.date : Math.floor(Date.now() / 1000)
  return {
    chatId,
    chatTitle: chatTitle(chat) || chatId,
    from: displayName(message.from),
    text,
    at: new Date(date * 1000).toISOString(),
    direction: 'in',
  }
}

/**
 * The offset to store after a batch of updates: one past the highest seen id.
 * @param current - offset that was requested.
 * @param updates - the batch returned by Telegram.
 * @returns the next offset, never below `current`.
 */
export function nextOffset(current, updates) {
  let offset = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0
  for (const update of Array.isArray(updates) ? updates : []) {
    const id = Number(update?.update_id)
    if (Number.isFinite(id) && id + 1 > offset) offset = id + 1
  }
  return offset
}

/**
 * Describe one pressed inline button (`callback_query`).
 * @param update - item of `getUpdates`.
 * @returns `{ callbackId, chatId, chatTitle, messageId, data, from }` or
 *   `undefined` when the update is not a callback.
 */
export function callbackFromUpdate(update) {
  if (update === null || typeof update !== 'object') return undefined
  const query = update.callback_query
  if (query === null || typeof query !== 'object') return undefined
  const callbackId = typeof query.id === 'string' ? query.id : ''
  if (callbackId === '') return undefined
  const message = query.message !== null && typeof query.message === 'object' ? query.message : {}
  const chat = message.chat !== null && typeof message.chat === 'object' ? message.chat : {}
  const chatId = chat.id !== undefined && chat.id !== null ? String(chat.id) : ''
  const messageId = Number(message.message_id)
  return {
    callbackId,
    chatId,
    chatTitle: chatId === '' ? '' : chatTitle(chat) || chatId,
    messageId: Number.isFinite(messageId) ? messageId : undefined,
    data: typeof query.data === 'string' ? query.data : '',
    from: displayName(query.from),
  }
}
