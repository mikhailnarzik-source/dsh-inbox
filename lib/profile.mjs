/**
 * The bot's Telegram profile: name, description, short description and the
 * chat menu button. Published when the token is known to work and at most once
 * a day per plugin version; every Telegram call is best effort, so a failed
 * profile update never breaks polling.
 */

/** Version whose profile is considered current. */
export const PROFILE_VERSION = '0.5.0'

/** How long a published profile is trusted. */
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000

/** Bot display name (Telegram limit: 64 characters). */
export const BOT_NAME = '📥 DSH Входящие'

/** Bot description shown on the profile page (Telegram limit: 512 characters). */
export const BOT_DESCRIPTION = 'Входящие для DeepSeek Harness: пишите боту, чтобы узнать статус, выбрать сессию DSH и отправить задачу. Бот слушает только доверенные личные чаты — группы по умолчанию запрещены. Ответы приходят из DSH.'

/** Short description shown before «Start» (Telegram limit: 120 characters). */
export const BOT_SHORT_DESCRIPTION = 'Telegram-бот DSH: сессии, задачи и ответы из DeepSeek Harness.'

/** The menu button replacing the command list button with the commands menu. */
export function botMenuButton() {
  return { type: 'commands' }
}

/**
 * Whether the profile has to be published again.
 * @param cache - `state.botProfile` (`{ version, at, ok }`).
 * @param now - current epoch milliseconds.
 * @param version - local profile version.
 * @returns true on a version change, a failed attempt or an expired cache.
 */
export function shouldRefreshProfile(cache, now = Date.now(), version = PROFILE_VERSION) {
  if (cache === null || typeof cache !== 'object') return true
  if (cache.version !== version) return true
  if (cache.ok !== true) return true
  const at = Number(cache.at)
  if (!Number.isFinite(at) || at <= 0) return true
  return now - at >= PROFILE_TTL_MS
}
