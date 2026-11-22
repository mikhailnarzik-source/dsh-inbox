/**
 * Browser half of `dsh-inbox` — «Входящие».
 *
 * Contributes one section to the plugin page: the token field (write-only, the
 * literal goes straight into the DSH credential store), the token check, the
 * receive switch, the last messages, a reply field and a history reset. While
 * the section is open it refreshes every four seconds; the interval and the
 * credential listener are removed when the page closes.
 *
 * The token never reaches this module: `credentials.describe` answers only
 * whether one is stored, `credentials.set` is write-only, and the state route
 * carries a verdict instead of the value.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inbox',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const NS = 'inbox';
    const REF = 'TELEGRAM_BOT_TOKEN';
    const STATE_PATH = '/api/dsh-inbox/state';
    const VERIFY_PATH = '/api/dsh-inbox/verify';
    const SEND_PATH = '/api/dsh-inbox/send';
    const POLLING_PATH = '/api/dsh-inbox/polling';
    const CLEAR_PATH = '/api/dsh-inbox/messages/clear';
    const ALLOWLIST_PATH = '/api/dsh-inbox/allowlist';
    const SESSION_RESET_PATH = '/api/dsh-inbox/session/reset';
    const MENU_REFRESH_PATH = '/api/dsh-inbox/menu/refresh';
    const QUEUE_LISTENER_PATH = '/api/dsh-inbox/queue/listener';
    const QUEUE_SYNC_PATH = '/api/dsh-inbox/queue/sync';
    const REFRESH_MS = 4000;

    const en = {
      pageTitle: 'Inbox',
      statusConnected: '✅ connected',
      statusNoToken: '⚠️ no token',
      pollingOn: 'receiving on',
      pollingOff: 'receiving off',
      tokenLabel: 'Bot token',
      tokenPlaceholderSet: '•••••••• (enter a new token to replace)',
      tokenPlaceholderUnset: '123456789:AA… (token from @BotFather)',
      save: 'Save',
      saving: 'Saving…',
      remove: 'Remove token',
      removing: 'Removing…',
      saved: 'Saved. Applied immediately, no restart needed.',
      removed: 'Token removed. Receiving is off.',
      saveFailed: 'Could not save the token.',
      removeFailed: 'Could not remove the token.',
      storedIn: 'Stored in the DSH credential store (refs.TELEGRAM_BOT_TOKEN), not in the plugin configuration.',
      readonly: 'This deployment stores credentials read-only.',
      verify: 'Check',
      verifying: 'Checking…',
      verifyOk: '✅ bot is online',
      verifyRejected: '🔴 Telegram rejected the token',
      verifyMissing: '⚪ no token is stored',
      verifyUnreachable: '🟡 Telegram did not answer',
      verifyIdle: 'not checked yet',
      checkFailed: 'The check did not complete.',
      receiveTitle: 'Receive messages',
      receiveHint: 'While receiving is on, DSH fetches new bot messages and keeps them locally; the switch is saved across restarts.',
      enable: 'Enable',
      disable: 'Disable',
      toggleFailed: 'Could not switch receiving.',
      lastError: 'Last error:',
      noError: 'none',
      historyTitle: 'Latest messages',
      historyEmpty: 'No messages yet. Turn receiving on and write to the bot in Telegram.',
      historyTotal: 'in history:',
      historyMax: 'of',
      incoming: 'incoming',
      outgoing: 'outgoing',
      replyLabel: 'Reply',
      replyPlaceholder: 'Text to send to the last chat…',
      send: 'Send',
      sending: 'Sending…',
      sent: 'Sent.',
      sendFailed: 'Could not send the message.',
      clear: 'Clear history',
      clearing: 'Clearing…',
      cleared: 'History cleared.',
      clearFailed: 'Could not clear the history.',
      loadFailed: 'Could not load the state. It will retry in a few seconds.',
      retry: 'Retry',
      howTitle: 'How to start',
      step1: 'Open @BotFather in Telegram, send /newbot and pick a name and a username (the username ends with "bot").',
      step2: 'Copy the token that looks like 123456789:AA… and paste it into the "Bot token" field above.',
      step3: 'Press "Save", then "Check" — the bot name (@…) appears next to the status.',
      step4: 'Turn "Receive messages" on and write to the bot in Telegram — the message appears in the list below.',
      step5: 'Answer from the "Reply" field, or ask the agent: it has the tools telegram_status, telegram_messages and telegram_send.',
      botFather: 'Open @BotFather',
      scopeNote: 'This is an MVP: mail is not supported yet, only Telegram messages. The history lives only in DSH and does not replace the Telegram chat.',
      allowTitle: 'Whitelist',
      allowHint: 'Only these chats may control DSH: /sessions, /use, /ask, /steer, /new, /cancel. Enter Telegram chat ids separated by commas; an empty list means nobody can control DSH.',
      allowPlaceholder: '123456789, -1001234567890',
      allowSave: 'Save list',
      allowSaving: 'Saving…',
      allowSaved: 'List saved.',
      allowFailed: 'Could not save the list.',
      allowEmpty: 'The list is empty: nobody can control DSH from Telegram.',
      allowCount: 'Chats in the list:',
      allowCurrent: 'allowed',
      allowAdd: 'Allow this chat',
      allowAddDone: 'Chat allowed.',
      allowAddFailed: 'Could not allow the chat.',
      chatsTitle: 'Chats in the history',
      sessionBlockTitle: 'Current session for the chat',
      sessionNone: 'not chosen',
      sessionRunning: 'running',
      sessionIdle: 'idle',
      sessionReset: 'Reset',
      sessionResetDone: 'Session unlinked from the chat.',
      sessionResetFailed: 'Could not reset the session.',
      sessionHint: 'The session is chosen in Telegram: /sessions, then /use N. Plain text from an allowed chat is sent to it as /ask.',
      commandsTitle: 'Bot commands',
      cmdHelp: '/help — cheat sheet',
      cmdStatus: '/status — bot, whitelist and current session',
      cmdSessions: '/sessions — last 10 DSH sessions',
      cmdUse: '/use N — pick a session for this chat',
      cmdAsk: '/ask <text> — queue a message (plain text works too)',
      cmdSteer: '/steer <text> — steer the running turn',
      cmdNew: '/new <text> — create a session and send the text',
      cmdCancel: '/cancel — cancel the current turn',
      cmdLast: '/last — last 5 Inbox messages',
      blockedBadge: '⛔ no access',
      blockedHint: 'A chat outside the list cannot control DSH; allow it from the chat list below.',
      menuTitle: 'Telegram menu',
      menuHint: 'The command list behind «/» and the keyboard at the bottom of the chat. The bot publishes them itself after a successful token check and at most once a day.',
      menuOn: 'command menu published',
      menuOff: 'not published yet',
      menuUpdate: 'Refresh command menu',
      menuUpdating: 'Refreshing…',
      menuUpdateDone: 'Command menu updated.',
      menuUpdateFailed: 'Could not update the command menu.',
      menuCommands: 'Commands:',
      menuButtons: 'Keyboard:',
      menuButtonsValue: '📋 Сессии · ➕ Новая сессия · ⏹ Прервать · ℹ️ Состояние · ❓ Помощь',
      menuUpdatedAt: 'Last published:',
      queueTitle: 'Shared queue',
      queueConfigured: 'configured',
      queueNotConfigured: 'not configured',
      queueDevice: 'This device:',
      queueRole: 'Role:',
      queueListenerOn: 'listens to Telegram',
      queueListenerOff: 'executor',
      queueSwitching: 'Switching…',
      queueListen: 'Listen to Telegram here',
      queueUnlisten: 'Stop listening here',
      queueListenerDone: 'This device listens to Telegram.',
      queueListenerOffDone: 'Listening is off on this device.',
      queueListenerFailed: 'Could not switch the listener.',
      queue409: 'Only one device may listen to the bot: a second getUpdates consumer gets 409 Conflict. Turn listening off on the other device first.',
      queueSync: 'Sync now',
      queueSyncing: 'Syncing…',
      queueSynced: 'Queue synchronized.',
      queueSyncFailed: 'Could not sync the queue.',
      queueNew: 'new',
      queueInProgress: 'in progress',
      queueDone: 'done',
      queueCounts: 'Commands:',
      queueWho: 'executing now:',
      queueOther: 'Another device listens:',
      queueDevices: 'Devices:',
      queueLastSync: 'Last sync:',
      queueNever: 'never',
      queueRemote: 'Repository:',
      queueInline: 'Queue is off: commands run on this device right away. Fill "remote" in ~/.dsh/dsh-sync.json to share them between devices.',
      queueHint: 'Commands are kept in the git branch inbox of the same repository as dsh-sync. Every device needs the bot token in its own vault; exactly one device is the listener.',
      queueNoToken: 'Save the bot token first.',
    };

    const ru = {
      pageTitle: 'Входящие',
      statusConnected: '✅ подключён',
      statusNoToken: '⚠️ токен не сохранён',
      pollingOn: 'приём включён',
      pollingOff: 'приём выключен',
      tokenLabel: 'Токен бота',
      tokenPlaceholderSet: '•••••••• (введите новый токен, чтобы заменить)',
      tokenPlaceholderUnset: '123456789:AA… (токен от @BotFather)',
      save: 'Сохранить',
      saving: 'Сохраняем…',
      remove: 'Удалить токен',
      removing: 'Удаляем…',
      saved: 'Сохранено. Действует сразу, перезапуск не нужен.',
      removed: 'Токен удалён. Приём сообщений выключен.',
      saveFailed: 'Не удалось сохранить токен.',
      removeFailed: 'Не удалось удалить токен.',
      storedIn: 'Хранится в хранилище секретов DSH (refs.TELEGRAM_BOT_TOKEN), а не в конфигурации плагина.',
      readonly: 'В этом окружении хранилище секретов доступно только для чтения.',
      verify: 'Проверить',
      verifying: 'Проверяем…',
      verifyOk: '✅ бот на связи',
      verifyRejected: '🔴 Telegram отклонил токен',
      verifyMissing: '⚪ токен не сохранён',
      verifyUnreachable: '🟡 Telegram не ответил',
      verifyIdle: 'ещё не проверялся',
      checkFailed: 'Проверка не завершилась.',
      receiveTitle: 'Принимать сообщения',
      receiveHint: 'Пока приём включён, DSH забирает новые сообщения бота и хранит их локально; переключатель сохраняется между запусками.',
      enable: 'Включить',
      disable: 'Выключить',
      toggleFailed: 'Не удалось переключить приём.',
      lastError: 'Последняя ошибка:',
      noError: 'нет',
      historyTitle: 'Последние сообщения',
      historyEmpty: 'Сообщений пока нет. Включите приём и напишите боту в Telegram.',
      historyTotal: 'в истории:',
      historyMax: 'из',
      incoming: 'входящее',
      outgoing: 'исходящее',
      replyLabel: 'Ответ',
      replyPlaceholder: 'Текст ответа в последний чат…',
      send: 'Отправить',
      sending: 'Отправляем…',
      sent: 'Отправлено.',
      sendFailed: 'Не удалось отправить сообщение.',
      clear: 'Очистить историю',
      clearing: 'Очищаем…',
      cleared: 'История очищена.',
      clearFailed: 'Не удалось очистить историю.',
      loadFailed: 'Не удалось получить состояние. Повторим через несколько секунд.',
      retry: 'Повторить',
      howTitle: 'Как начать',
      step1: 'Откройте @BotFather в Telegram, отправьте /newbot и придумайте имя и username (username заканчивается на «bot»).',
      step2: 'Скопируйте токен вида 123456789:AA… и вставьте его в поле «Токен бота» выше.',
      step3: 'Нажмите «Сохранить», затем «Проверить» — рядом со статусом появится имя бота (@…).',
      step4: 'Включите «Принимать сообщения» и напишите боту в Telegram — сообщение появится в списке ниже.',
      step5: 'Ответьте из поля «Ответ» или попросите ассистента: у него есть инструменты telegram_status, telegram_messages и telegram_send.',
      botFather: 'Открыть @BotFather',
      scopeNote: 'Это MVP: почта пока не поддерживается, реализованы только сообщения Telegram. История живёт только в DSH и не заменяет чат Telegram.',
      allowTitle: 'Белый список',
      allowHint: 'Только эти чаты могут управлять DSH: /sessions, /use, /ask, /steer, /new, /cancel. Введите chatId Telegram через запятую; пустой список — управлять нельзя никому.',
      allowPlaceholder: '123456789, -1001234567890',
      allowSave: 'Сохранить список',
      allowSaving: 'Сохраняем…',
      allowSaved: 'Список сохранён.',
      allowFailed: 'Не удалось сохранить список.',
      allowEmpty: 'Список пуст: управлять DSH из Telegram нельзя никому.',
      allowCount: 'Чатов в списке:',
      allowCurrent: 'разрешён',
      allowAdd: 'Разрешить этот чат',
      allowAddDone: 'Чат разрешён.',
      allowAddFailed: 'Не удалось разрешить чат.',
      chatsTitle: 'Чаты в истории',
      sessionBlockTitle: 'Текущая сессия для чата',
      sessionNone: 'не выбрана',
      sessionRunning: 'выполняется',
      sessionIdle: 'ожидает',
      sessionReset: 'Сбросить',
      sessionResetDone: 'Сессия отвязана от чата.',
      sessionResetFailed: 'Не удалось сбросить сессию.',
      sessionHint: 'Сессия выбирается в Telegram: /sessions, затем /use N. Обычный текст из разрешённого чата уходит в неё как /ask.',
      commandsTitle: 'Команды бота',
      cmdHelp: '/help — справка',
      cmdStatus: '/status — состояние бота, белого списка и текущей сессии',
      cmdSessions: '/sessions — 10 последних сессий DSH',
      cmdUse: '/use N — выбрать сессию для этого чата',
      cmdAsk: '/ask <текст> — поставить сообщение в очередь (обычный текст тоже работает)',
      cmdSteer: '/steer <текст> — вклинить сообщение в текущий ход',
      cmdNew: '/new <текст> — создать сессию и отправить в неё текст',
      cmdCancel: '/cancel — отменить текущий ход',
      cmdLast: '/last — последние 5 сообщений «Входящих»',
      blockedBadge: '⛔ нет доступа',
      blockedHint: 'Чат вне списка не может управлять DSH; разрешите его в списке чатов ниже.',
      menuTitle: 'Меню в Telegram',
      menuHint: 'Список команд в «/» и клавиатура внизу чата. Бот публикует их сам после успешной проверки токена и не чаще раза в сутки.',
      menuOn: 'меню команд опубликовано',
      menuOff: 'ещё не опубликовано',
      menuUpdate: 'Обновить меню команд',
      menuUpdating: 'Обновляем…',
      menuUpdateDone: 'Меню команд обновлено.',
      menuUpdateFailed: 'Не удалось обновить меню команд.',
      menuCommands: 'Команды:',
      menuButtons: 'Клавиатура:',
      menuButtonsValue: '📋 Сессии · ➕ Новая сессия · ⏹ Прервать · ℹ️ Состояние · ❓ Помощь',
      menuUpdatedAt: 'Последняя публикация:',
      queueTitle: 'Общая очередь',
      queueConfigured: 'настроена',
      queueNotConfigured: 'не настроена',
      queueDevice: 'Это устройство:',
      queueRole: 'Роль:',
      queueListenerOn: 'слушает Telegram',
      queueListenerOff: 'исполнитель',
      queueSwitching: 'Переключаем…',
      queueListen: 'Слушать Telegram здесь',
      queueUnlisten: 'Выключить приём здесь',
      queueListenerDone: 'Это устройство слушает Telegram.',
      queueListenerOffDone: 'Приём на этом устройстве выключен.',
      queueListenerFailed: 'Не удалось переключить слушателя.',
      queue409: 'Telegram может слушать только одно устройство: второй getUpdates получит 409 Conflict. Сначала выключите приём на другом устройстве.',
      queueSync: 'Синхронизировать сейчас',
      queueSyncing: 'Синхронизируем…',
      queueSynced: 'Очередь синхронизирована.',
      queueSyncFailed: 'Не удалось синхронизировать очередь.',
      queueNew: 'новых',
      queueInProgress: 'в работе',
      queueDone: 'готово',
      queueCounts: 'Команды:',
      queueWho: 'выполняет сейчас:',
      queueOther: 'Слушает другое устройство:',
      queueDevices: 'Устройства:',
      queueLastSync: 'Последняя синхронизация:',
      queueNever: 'не было',
      queueRemote: 'Репозиторий:',
      queueInline: 'Очередь не настроена: команды выполняются на этом устройстве сразу. Заполните «remote» в ~/.dsh/dsh-sync.json, чтобы делить их между устройствами.',
      queueHint: 'Команды складываются в git-ветку inbox того же репозитория, что и dsh-sync. На каждом устройстве нужен свой токен бота в сейфе; слушателем может быть только одно устройство.',
      queueNoToken: 'Сначала сохраните токен бота.',
    };

    /**
     * The stylesheet inherits the host theme: surfaces, text and borders come
     * from the `--dsw-alias-*` tokens, geometry is plain CSS.
     */
    const CSS = `
.dsh-inbox{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-inbox-title{font-size:14px;font-weight:600;margin:0}
.dsh-inbox-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-inbox-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-inbox-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-inbox-label{font-weight:600}
.dsh-inbox-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.dsh-inbox-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-success-primary)}
.dsh-inbox-note.is-bad{color:var(--dsw-alias-state-error-primary)}
.dsh-inbox-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary)}
.dsh-inbox-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:17px;white-space:nowrap}
.dsh-inbox-pill.is-ok{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.dsh-inbox-pill.is-warn{border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)}
.dsh-inbox-pill.is-bad{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.dsh-inbox-input{flex:1 1 260px;min-width:200px;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-inbox-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-inbox-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-inbox-input:disabled{opacity:.6}
.dsh-inbox-reply{flex:1 1 260px;min-width:200px;box-sizing:border-box;min-height:34px;max-height:120px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
.dsh-inbox-reply:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-inbox-button{appearance:none;box-sizing:border-box;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dsh-inbox-button:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)}
.dsh-inbox-button:active:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)}
.dsh-inbox-button:disabled{opacity:.55;cursor:default}
.dsh-inbox-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-inbox-button.is-primary{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)}
.dsh-inbox-button.is-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-inbox-switch{position:relative;box-sizing:border-box;width:38px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dsh-inbox-switch.is-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.dsh-inbox-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-inbox-switch:disabled{opacity:.55;cursor:default}
.dsh-inbox-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay);transition:transform .15s ease}
.dsh-inbox-switch.is-on .dsh-inbox-knob{transform:translateX(16px)}
.dsh-inbox-messages{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow:auto;padding-right:2px}
.dsh-inbox-message{display:flex;flex-direction:column;gap:2px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base)}
.dsh-inbox-message.is-out{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
.dsh-inbox-message-head{display:flex;align-items:baseline;gap:7px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-inbox-arrow{font-size:11.5px}
.dsh-inbox-chat{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.dsh-inbox-time{margin-left:auto;font-variant-numeric:tabular-nums}
.dsh-inbox-text{white-space:pre-wrap;word-break:break-word}
.dsh-inbox-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dsh-inbox-link{color:var(--dsw-alias-brand-primary);font-size:12.5px;text-decoration:underline}
.dsh-inbox-summary{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
.dsh-inbox-badge{display:inline-flex;align-items:center;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:12px;line-height:17px;background:var(--dsw-alias-bg-layer-2)}
.dsh-inbox-badge.is-on{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.dsh-inbox-badge.is-off{border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}
.dsh-inbox-textarea{flex:1 1 260px;min-width:200px;box-sizing:border-box;min-height:56px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;resize:vertical}
.dsh-inbox-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-inbox-textarea:disabled{opacity:.6}
.dsh-inbox-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsh-inbox-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-base);font-size:12px;line-height:17px}
.dsh-inbox-chip.is-blocked{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-inbox-chip-name{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-inbox-chip .dsh-inbox-button{height:24px;padding:0 8px;font-size:11.5px;border-radius:999px}
.dsh-inbox-command{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-inbox-session{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-inbox-session-name{font-weight:600}
`;

    /** Local time for a stored UTC timestamp. */
    function formatTime(at) {
      const date = new Date(String(at ?? ''));
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    /**
     * Mount the section.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-inbox: card dictionaries');

      const api = ctx.remote.credentials;

      /**
       * Call one Host route.
       * @param path - route path.
       * @param payload - JSON body.
       * @returns the parsed answer; `null` when the body is not JSON.
       */
      async function call(path, payload) {
        const response = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        });
        return await response.json().catch(() => null);
      }

      /** Short badge for the plugin row in the list. */
      function InboxSummary() {
        const [data, setData] = React.useState(null);
        React.useEffect(() => {
          let alive = true;
          call(STATE_PATH)
            .then(payload => {
              if (alive) setData(payload);
            })
            .catch(() => {});
          return () => {
            alive = false;
          };
        }, []);
        const configured = data?.configured === true;
        const name = typeof data?.botUsername === 'string' && data.botUsername !== '' ? ` @${data.botUsername}` : '';
        return h(
          'span',
          { className: 'dsh-inbox-summary' },
          h('span', null, t('pageTitle')),
          h('span', { className: configured ? 'dsh-inbox-badge is-on' : 'dsh-inbox-badge' },
            configured ? `${t('statusConnected')}${name}` : t('statusNoToken')),
          h('span', { className: 'dsh-inbox-badge' }, data?.enabled === true ? t('pollingOn') : t('pollingOff')),
        );
      }

      /** The full section: token, receive switch, history and reply. */
      function InboxPage() {
        const [snapshot, setSnapshot] = React.useState(null);
        const [phase, setPhase] = React.useState('loading');
        const [draft, setDraft] = React.useState('');
        const [reply, setReply] = React.useState('');
        const [busy, setBusy] = React.useState('');
        const [notice, setNotice] = React.useState(null);
        const [verifyPhase, setVerifyPhase] = React.useState('idle');
        const [allowDraft, setAllowDraft] = React.useState('');
        const [allowDirty, setAllowDirty] = React.useState(false);
        const mounted = React.useRef(true);

        const refresh = React.useCallback(async () => {
          try {
            const payload = await call(STATE_PATH);
            if (!mounted.current) return;
            if (payload === null || payload.ok !== true) {
              setPhase('error');
              return;
            }
            setSnapshot(payload);
            setPhase('ready');
          } catch {
            if (mounted.current) setPhase('error');
          }
        }, []);

        // The list is live only while the section is mounted: the interval and
        // the credential listener below are disposed on unmount.
        React.useEffect(() => {
          mounted.current = true;
          void refresh();
          const timer = setInterval(() => {
            if (document.visibilityState !== 'hidden') void refresh();
          }, REFRESH_MS);
          return () => {
            mounted.current = false;
            clearInterval(timer);
          };
        }, [refresh]);

        React.useEffect(() => {
          try {
            const off = ctx.remote.$on('credentials/reference-updated', ref => {
              if (ref === REF) void refresh();
            });
            return () => {
              if (typeof off === 'function') off();
            };
          } catch {
            return undefined;
          }
        }, [refresh]);

        // A confirmation line is transient: a stale "saved" must not read as
        // the current state.
        React.useEffect(() => {
          if (notice === null) return undefined;
          const timer = setTimeout(() => setNotice(null), 8000);
          return () => clearTimeout(timer);
        }, [notice]);

        // The allow-list field follows the host until the user starts editing it.
        React.useEffect(() => {
          if (allowDirty) return;
          const ids = Array.isArray(snapshot?.allowedChatIds) ? snapshot.allowedChatIds : [];
          setAllowDraft(ids.join(', '));
        }, [snapshot?.allowedChatIds?.join(','), allowDirty]);

        const run = async (action, work) => {
          if (busy !== '') return;
          setBusy(action);
          setNotice(null);
          try {
            await work();
          } finally {
            if (mounted.current) setBusy('');
          }
        };

        const verify = async () => {
          setVerifyPhase('checking');
          try {
            const verdict = await call(VERIFY_PATH);
            if (!mounted.current) return;
            const code = verdict?.code;
            setVerifyPhase(verdict?.ok === true
              ? 'ok'
              : code === 'rejected'
                ? 'rejected'
                : code === 'missing'
                  ? 'missing'
                  : 'unreachable');
            if (typeof verdict?.message === 'string' && verdict.message !== '') {
              setNotice({ kind: verdict?.ok === true ? 'ok' : 'bad', text: verdict.message });
            }
            await refresh();
          } catch {
            if (mounted.current) {
              setVerifyPhase('unreachable');
              setNotice({ kind: 'bad', text: t('checkFailed') });
            }
          }
        };

        const submitToken = () => {
          const value = draft.trim();
          if (value === '') return;
          return run('save', async () => {
            try {
              await api.set(REF, value);
              if (!mounted.current) return;
              setDraft('');
              setNotice({ kind: 'ok', text: t('saved') });
              await refresh();
              await verify();
            } catch {
              if (mounted.current) setNotice({ kind: 'bad', text: t('saveFailed') });
            }
          });
        };

        const removeToken = () => run('remove', async () => {
          try {
            await api.unset(REF);
            if (!mounted.current) return;
            setVerifyPhase('missing');
            setNotice({ kind: 'ok', text: t('removed') });
            if (snapshot?.enabled === true) await call(POLLING_PATH, { enabled: false });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('removeFailed') });
          }
        });

        const setReceiving = wanted => run('toggle', async () => {
          try {
            const payload = await call(POLLING_PATH, { enabled: wanted });
            if (!mounted.current) return;
            setNotice({ kind: payload?.ok === true ? 'ok' : 'bad', text: payload?.message ?? '' });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('toggleFailed') });
          }
        });

        const sendReply = () => {
          const value = reply.trim();
          if (value === '') return;
          return run('send', async () => {
            try {
              const payload = await call(SEND_PATH, { chatId: 'last', text: value });
              if (!mounted.current) return;
              if (payload?.ok === true) {
                setReply('');
                setNotice({ kind: 'ok', text: t('sent') });
              } else {
                setNotice({ kind: 'bad', text: payload?.message ?? t('sendFailed') });
              }
              await refresh();
            } catch {
              if (mounted.current) setNotice({ kind: 'bad', text: t('sendFailed') });
            }
          });
        };

        const clearHistory = () => run('clear', async () => {
          try {
            const payload = await call(CLEAR_PATH);
            if (!mounted.current) return;
            setNotice({ kind: payload?.ok === true ? 'ok' : 'bad', text: payload?.message ?? (payload?.ok === true ? t('cleared') : t('clearFailed')) });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('clearFailed') });
          }
        });

        const saveAllowlist = () => run('allow', async () => {
          const ids = allowDraft
            .split(/[\s,;]+/)
            .map(item => item.trim())
            .filter(item => item !== '');
          try {
            const payload = await call(ALLOWLIST_PATH, { chatIds: ids });
            if (!mounted.current) return;
            if (payload?.ok === true) {
              setAllowDirty(false);
              setNotice({ kind: 'ok', text: payload.message ?? t('allowSaved') });
            } else {
              setNotice({ kind: 'bad', text: payload?.message ?? t('allowFailed') });
            }
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('allowFailed') });
          }
        });

        const allowThisChat = chatId => run('allow-chat', async () => {
          try {
            const payload = await call(ALLOWLIST_PATH, { add: chatId });
            if (!mounted.current) return;
            setNotice({
              kind: payload?.ok === true ? 'ok' : 'bad',
              text: payload?.ok === true ? (payload.message ?? t('allowAddDone')) : (payload?.message ?? t('allowAddFailed')),
            });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('allowAddFailed') });
          }
        });

        const resetSession = chatId => run('session', async () => {
          try {
            const payload = await call(SESSION_RESET_PATH, { chatId });
            if (!mounted.current) return;
            setNotice({
              kind: payload?.ok === true ? 'ok' : 'bad',
              text: payload?.ok === true ? (payload.message ?? t('sessionResetDone')) : (payload?.message ?? t('sessionResetFailed')),
            });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('sessionResetFailed') });
          }
        });

        const refreshMenu = () => run('menu', async () => {
          try {
            const payload = await call(MENU_REFRESH_PATH, { force: true });
            if (!mounted.current) return;
            setNotice({
              kind: payload?.ok === true ? 'ok' : 'bad',
              text: payload?.ok === true ? (payload.message ?? t('menuUpdateDone')) : (payload?.message ?? t('menuUpdateFailed')),
            });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('menuUpdateFailed') });
          }
        });

        const setListener = enabled => run('queue-listener', async () => {
          try {
            const payload = await call(QUEUE_LISTENER_PATH, { enabled });
            if (!mounted.current) return;
            if (payload?.ok === true) {
              const queue = payload.queue ?? {};
              let text = payload.message ?? (enabled ? t('queueListenerDone') : t('queueListenerOffDone'));
              if (enabled && queue.otherListener) {
                text += ` ${t('queueOther')} ${queue.otherListener.deviceName}. ${t('queue409')}`;
              }
              if (queue.lastError) text += ` ${t('lastError')} ${queue.lastError}`;
              setNotice({ kind: 'ok', text });
            } else {
              setNotice({ kind: 'bad', text: payload?.message ?? t('queueListenerFailed') });
            }
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('queueListenerFailed') });
          }
        });

        const syncQueue = () => run('queue-sync', async () => {
          try {
            const payload = await call(QUEUE_SYNC_PATH, {});
            if (!mounted.current) return;
            setNotice({
              kind: payload?.ok === true ? 'ok' : 'bad',
              text: payload?.ok === true ? (payload.message ?? t('queueSynced')) : (payload?.message ?? t('queueSyncFailed')),
            });
            await refresh();
          } catch {
            if (mounted.current) setNotice({ kind: 'bad', text: t('queueSyncFailed') });
          }
        });

        const configured = snapshot?.configured === true;
        const enabled = snapshot?.enabled === true;
        const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
        const verifyText = verifyPhase === 'checking'
          ? t('verifying')
          : verifyPhase === 'ok'
            ? t('verifyOk')
            : verifyPhase === 'rejected'
              ? t('verifyRejected')
              : verifyPhase === 'missing'
                ? t('verifyMissing')
                : verifyPhase === 'unreachable'
                  ? t('verifyUnreachable')
                  : t('verifyIdle');
        const verifyClass = verifyPhase === 'ok'
          ? 'dsh-inbox-pill is-ok'
          : verifyPhase === 'rejected' || verifyPhase === 'missing'
            ? 'dsh-inbox-pill is-bad'
            : verifyPhase === 'unreachable'
              ? 'dsh-inbox-pill is-warn'
              : 'dsh-inbox-pill';
        const steps = [t('step1'), t('step2'), t('step3'), t('step4'), t('step5')];
        const allowedIds = Array.isArray(snapshot?.allowedChatIds) ? snapshot.allowedChatIds : [];
        const chats = Array.isArray(snapshot?.chats) ? snapshot.chats : [];
        const currentSession = snapshot?.currentSession ?? null;
        const menu = snapshot?.menu ?? {};
        const menuOk = menu.ok === true;
        const menuAt = Number(menu.at) > 0 ? formatTime(new Date(Number(menu.at)).toISOString()) : '';
        const menuCommands = Array.isArray(menu.commands) ? menu.commands.join(' · ') : '';
        const queueInfo = snapshot?.queue ?? {};
        const queueConfigured = queueInfo.configured === true;
        const queueCounts = queueInfo.counts ?? {};
        const queueDevices = Array.isArray(queueInfo.devices) ? queueInfo.devices : [];
        const queueInProgress = Array.isArray(queueInfo.inProgress) ? queueInfo.inProgress : [];
        const queueOther = queueInfo.otherListener ?? null;
        const queueLastSync = Number(queueInfo.lastSyncAt) > 0
          ? formatTime(new Date(Number(queueInfo.lastSyncAt)).toISOString())
          : '';
        const queueDeviceName = queueInfo.device?.name ?? snapshot?.device?.name ?? '';
        const queueDeviceId = queueInfo.device?.id ?? snapshot?.device?.id ?? '';
        const queueListener = queueInfo.listener === true;
        const commandLines = [
          t('cmdHelp'),
          t('cmdStatus'),
          t('cmdSessions'),
          t('cmdUse'),
          t('cmdAsk'),
          t('cmdSteer'),
          t('cmdNew'),
          t('cmdCancel'),
          t('cmdLast'),
        ];

        return h(
          'div',
          { className: 'dsh-inbox' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-inbox-head' },
            h('span', { className: 'dsh-inbox-title' }, t('pageTitle')),
            h('span', { className: configured ? (snapshot?.botUsername ? 'dsh-inbox-pill is-ok' : 'dsh-inbox-pill is-warn') : 'dsh-inbox-pill is-bad' },
              configured
                ? `${t('statusConnected')}${snapshot?.botUsername ? ` @${snapshot.botUsername}` : ''}`
                : t('statusNoToken')),
            h('span', { className: enabled ? 'dsh-inbox-pill is-ok' : 'dsh-inbox-pill' },
              enabled ? t('pollingOn') : t('pollingOff')),
          ),
          phase === 'error'
            ? h('p', { className: 'dsh-inbox-error' }, t('loadFailed'), ' ',
              h('button', { type: 'button', className: 'dsh-inbox-button', onClick: () => void refresh() }, t('retry')))
            : null,
          snapshot?.lastError
            ? h('p', { className: 'dsh-inbox-error' }, `${t('lastError')} ${snapshot.lastError}`)
            : snapshot
              ? h('p', { className: 'dsh-inbox-hint' }, `${t('lastError')} ${t('noError')}`)
              : null,
          notice !== null
            ? h('p', { className: notice.kind === 'ok' ? 'dsh-inbox-note' : 'dsh-inbox-note is-bad' }, notice.text)
            : null,
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h('label', { className: 'dsh-inbox-label', htmlFor: 'dsh-inbox-token' }, t('tokenLabel')),
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('input', {
                id: 'dsh-inbox-token',
                className: 'dsh-inbox-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: configured ? t('tokenPlaceholderSet') : t('tokenPlaceholderUnset'),
                value: draft,
                disabled: busy !== '' || snapshot?.writable === false,
                onChange: event => setDraft(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter') void submitToken();
                },
              }),
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button is-primary',
                disabled: busy !== '' || draft.trim() === '',
                onClick: () => void submitToken(),
              }, busy === 'save' ? t('saving') : t('save')),
              configured
                ? h('button', {
                    type: 'button',
                    className: 'dsh-inbox-button is-danger',
                    disabled: busy !== '',
                    onClick: () => void removeToken(),
                  }, busy === 'remove' ? t('removing') : t('remove'))
                : null,
            ),
            h('p', { className: 'dsh-inbox-hint' }, t('storedIn')),
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: verifyClass, role: 'status' }, verifyText),
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button',
                disabled: busy !== '' || !configured,
                onClick: () => {
                  if (busy !== '') return;
                  setBusy('verify');
                  void verify().finally(() => {
                    if (mounted.current) setBusy('');
                  });
                },
              }, verifyPhase === 'checking' ? t('verifying') : t('verify')),
            ),
            snapshot?.writable === false
              ? h('p', { className: 'dsh-inbox-error' }, t('readonly'))
              : null,
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': enabled,
                'aria-label': t('receiveTitle'),
                className: enabled ? 'dsh-inbox-switch is-on' : 'dsh-inbox-switch',
                disabled: busy !== '',
                onClick: () => void setReceiving(!enabled),
              }, h('span', { className: 'dsh-inbox-knob' })),
              h('span', { className: 'dsh-inbox-label' }, t('receiveTitle')),
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button',
                disabled: busy !== '',
                onClick: () => void setReceiving(!enabled),
              }, enabled ? t('disable') : t('enable')),
            ),
            h('p', { className: 'dsh-inbox-hint' }, t('receiveHint')),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: 'dsh-inbox-label' }, t('allowTitle')),
              h('span', { className: 'dsh-inbox-hint' }, `${t('allowCount')} ${allowedIds.length}`),
            ),
            h('textarea', {
              className: 'dsh-inbox-textarea',
              rows: 2,
              placeholder: t('allowPlaceholder'),
              value: allowDraft,
              disabled: busy !== '',
              onChange: event => {
                setAllowDirty(true);
                setAllowDraft(event.target.value);
              },
            }),
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button is-primary',
                disabled: busy !== '',
                onClick: () => void saveAllowlist(),
              }, busy === 'allow' ? t('allowSaving') : t('allowSave')),
            ),
            h('p', { className: 'dsh-inbox-hint' }, t('allowHint')),
            allowedIds.length === 0
              ? h('p', { className: 'dsh-inbox-error' }, t('allowEmpty'))
              : null,
            chats.length > 0
              ? h(
                  'div',
                  { className: 'dsh-inbox-row' },
                  h('span', { className: 'dsh-inbox-label' }, t('chatsTitle')),
                  h(
                    'div',
                    { className: 'dsh-inbox-chips' },
                    chats.map(chat => h(
                      'span',
                      { key: chat.chatId, className: chat.allowed ? 'dsh-inbox-chip' : 'dsh-inbox-chip is-blocked' },
                      h('span', { className: 'dsh-inbox-chip-name', title: `${chat.chatTitle} (${chat.chatId})` },
                        chat.chatTitle === '' ? chat.chatId : chat.chatTitle),
                      chat.allowed
                        ? h('span', { className: 'dsh-inbox-badge is-on' }, t('allowCurrent'))
                        : h('button', {
                            type: 'button',
                            className: 'dsh-inbox-button',
                            disabled: busy !== '',
                            onClick: () => void allowThisChat(chat.chatId),
                          }, t('allowAdd')),
                    )),
                  ),
                )
              : null,
            h('p', { className: 'dsh-inbox-hint' }, t('blockedHint')),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h('span', { className: 'dsh-inbox-label' }, t('sessionBlockTitle')),
            currentSession === null
              ? h('div', { className: 'dsh-inbox-row' },
                  h('span', { className: 'dsh-inbox-hint' }, t('sessionNone')),
                  h('span', { className: 'dsh-inbox-hint' }, t('sessionHint')))
              : h(
                  'div',
                  { className: 'dsh-inbox-session' },
                  h('span', { className: 'dsh-inbox-session-name' },
                    currentSession.title === '' ? currentSession.sessionId.slice(0, 8) : currentSession.title),
                  h('span', { className: 'dsh-inbox-hint' },
                    currentSession.sessionId.length > 8 ? currentSession.sessionId.slice(0, 8) : currentSession.sessionId),
                  h('span', { className: currentSession.running ? 'dsh-inbox-badge is-on' : 'dsh-inbox-badge' },
                    currentSession.running ? t('sessionRunning') : t('sessionIdle')),
                  h('span', { className: 'dsh-inbox-hint' }, currentSession.chatTitle),
                  h('button', {
                    type: 'button',
                    className: 'dsh-inbox-button',
                    disabled: busy !== '',
                    onClick: () => void resetSession(currentSession.chatId),
                  }, t('sessionReset')),
                ),
            currentSession === null ? null : h('p', { className: 'dsh-inbox-hint' }, t('sessionHint')),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: 'dsh-inbox-label' }, t('menuTitle')),
              h('span', { className: menuOk ? 'dsh-inbox-badge is-on' : 'dsh-inbox-badge is-off' },
                menuOk ? t('menuOn') : t('menuOff')),
            ),
            menuOk && menuAt !== ''
              ? h('p', { className: 'dsh-inbox-hint' }, `${t('menuUpdatedAt')} ${menuAt}`)
              : null,
            menuCommands !== ''
              ? h('p', { className: 'dsh-inbox-hint' }, `${t('menuCommands')} ${menuCommands}`)
              : null,
            h('p', { className: 'dsh-inbox-hint' }, `${t('menuButtons')} ${t('menuButtonsValue')}`),
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button is-primary',
                disabled: busy !== '',
                onClick: () => void refreshMenu(),
              }, busy === 'menu' ? t('menuUpdating') : t('menuUpdate')),
            ),
            h('p', { className: 'dsh-inbox-hint' }, t('menuHint')),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: 'dsh-inbox-label' }, t('queueTitle')),
              h('span', { className: queueConfigured ? 'dsh-inbox-badge is-on' : 'dsh-inbox-badge is-off' },
                queueConfigured ? t('queueConfigured') : t('queueNotConfigured')),
              queueConfigured
                ? h('span', { className: queueListener ? 'dsh-inbox-badge is-on' : 'dsh-inbox-badge' },
                    queueListener ? t('queueListenerOn') : t('queueListenerOff'))
                : null,
            ),
            h('p', { className: 'dsh-inbox-hint' },
              `${t('queueDevice')} ${queueDeviceName === '' ? '—' : `${queueDeviceName} (${queueDeviceId.slice(0, 8)})`}`),
            queueConfigured
              ? h('p', { className: 'dsh-inbox-hint' }, `${t('queueRemote')} ${queueInfo.remote ?? ''}`)
              : h('p', { className: 'dsh-inbox-hint' }, t('queueInline')),
            queueConfigured
              ? h(
                  'div',
                  { className: 'dsh-inbox-row' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-inbox-button',
                    disabled: busy !== '',
                    onClick: () => void setListener(!queueListener),
                  }, busy === 'queue-listener' ? t('queueSwitching') : (queueListener ? t('queueUnlisten') : t('queueListen'))),
                  h('button', {
                    type: 'button',
                    className: 'dsh-inbox-button is-primary',
                    disabled: busy !== '',
                    onClick: () => void syncQueue(),
                  }, busy === 'queue-sync' ? t('queueSyncing') : t('queueSync')),
                )
              : null,
            queueConfigured
              ? h('p', { className: 'dsh-inbox-hint' },
                  `${t('queueCounts')} ${t('queueNew')}: ${queueCounts.new ?? 0} · ${t('queueInProgress')}: ${queueCounts.inProgress ?? 0} · ${t('queueDone')}: ${queueCounts.done ?? 0}`)
              : null,
            queueConfigured && queueInProgress.length > 0
              ? h(
                  'div',
                  null,
                  h('p', { className: 'dsh-inbox-hint' }, t('queueWho')),
                  ...queueInProgress.map((item, index) => h('p', { key: `live-${index}`, className: 'dsh-inbox-hint' },
                    `- ${item.deviceName}: ${item.text}`)),
                )
              : null,
            queueOther !== null
              ? h('p', { className: 'dsh-inbox-error' }, `${t('queueOther')} ${queueOther.deviceName}`)
              : null,
            queueConfigured && queueDevices.length > 0
              ? h(
                  'div',
                  null,
                  h('p', { className: 'dsh-inbox-hint' }, t('queueDevices')),
                  ...queueDevices.map((entry, index) => h('p', { key: `dev-${index}`, className: 'dsh-inbox-hint' },
                    `- ${entry.deviceName} (${entry.listener === true ? t('queueListenerOn') : t('queueListenerOff')})`)),
                )
              : null,
            queueConfigured
              ? h('p', { className: 'dsh-inbox-hint' },
                  `${t('queueLastSync')} ${queueLastSync === '' ? t('queueNever') : queueLastSync}`)
              : null,
            queueConfigured
              ? h('p', { className: (queueInfo.lastError ?? '') !== '' ? 'dsh-inbox-error' : 'dsh-inbox-hint' },
                  `${t('lastError')} ${queueInfo.lastError || t('noError')}`)
              : null,
            queueConfigured ? h('p', { className: 'dsh-inbox-hint' }, t('queue409')) : null,
            h('p', { className: 'dsh-inbox-hint' }, t('queueHint')),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h('span', { className: 'dsh-inbox-label' }, t('commandsTitle')),
            h(
              'ul',
              { className: 'dsh-inbox-list' },
              commandLines.map((line, index) => h('li', { key: index },
                h('span', { className: 'dsh-inbox-command' }, line))),
            ),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: 'dsh-inbox-label' }, t('historyTitle')),
              h('span', { className: 'dsh-inbox-hint' },
                `${t('historyTotal')} ${snapshot?.totalMessages ?? 0} ${t('historyMax')} ${snapshot?.maxMessages ?? 200}`),
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button',
                disabled: busy !== '' || messages.length === 0,
                onClick: () => void clearHistory(),
              }, busy === 'clear' ? t('clearing') : t('clear')),
            ),
            messages.length === 0
              ? h('p', { className: 'dsh-inbox-hint' }, t('historyEmpty'))
              : h(
                  'div',
                  { className: 'dsh-inbox-messages' },
                  [...messages].reverse().map((message, index) => {
                    const out = message.direction === 'out';
                    return h(
                      'div',
                      { key: `${message.at}-${message.chatId}-${index}`, className: out ? 'dsh-inbox-message is-out' : 'dsh-inbox-message' },
                      h(
                        'div',
                        { className: 'dsh-inbox-message-head' },
                        h('span', { className: 'dsh-inbox-arrow' }, out ? '➡' : '⬅'),
                        h('span', null, out ? t('outgoing') : t('incoming')),
                        message.blocked === true
                          ? h('span', { className: 'dsh-inbox-badge is-off' }, t('blockedBadge'))
                          : null,
                        h('span', { className: 'dsh-inbox-chat', title: message.chatTitle }, message.chatTitle),
                        h('span', { className: 'dsh-inbox-time' }, formatTime(message.at)),
                      ),
                      h('div', { className: 'dsh-inbox-text' }, message.text),
                    );
                  }),
                ),
            h(
              'div',
              { className: 'dsh-inbox-row' },
              h('span', { className: 'dsh-inbox-label' }, t('replyLabel')),
              h('textarea', {
                className: 'dsh-inbox-reply',
                rows: 2,
                placeholder: t('replyPlaceholder'),
                value: reply,
                disabled: busy !== '',
                onChange: event => setReply(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-inbox-button is-primary',
                disabled: busy !== '' || reply.trim() === '',
                onClick: () => void sendReply(),
              }, busy === 'send' ? t('sending') : t('send')),
            ),
          ),
          h(
            'div',
            { className: 'dsh-inbox-card' },
            h('span', { className: 'dsh-inbox-label' }, t('howTitle')),
            h('ol', { className: 'dsh-inbox-list' }, steps.map((step, index) => h('li', { key: index }, step))),
            h('a', {
              className: 'dsh-inbox-link',
              href: 'https://t.me/BotFather',
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t('botFather')),
            h('p', { className: 'dsh-inbox-hint' }, t('scopeNote')),
          ),
        );
      }

      try {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'dsh-inbox-detail',
              order: 46,
              locale: NS,
            },
            props => {
              const subject = props?.subject;
              const packageName =
                subject?.kind === 'bundle' && typeof subject?.pkg?.name === 'string'
                  ? subject.pkg.name
                  : typeof subject?.id === 'string'
                    ? subject.id
                    : '';
              if (packageName !== 'dsh-inbox') return null;
              if (props?.view === 'summary') return h(InboxSummary, props);
              return h(InboxPage, props);
            },
          ),
        );
      } catch (error) {
        console.error('[dsh-inbox] секция страницы недоступна:', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'remote', 'remote.credentials'];
    exports.NS = NS;
    return module.exports;
  },
});
