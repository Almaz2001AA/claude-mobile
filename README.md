# claude-mobile

Node.js server + PWA for controlling Claude Code sessions running in tmux
(`claude-<name>`) from an iPhone. No build step — the client is vanilla ES
modules served straight from `public/`.

Веб-приложение для iPhone (PWA, без App Store и Mac), через которое можно
продолжать те же сессии Claude Code, что открыты на компьютере: Claude
работает на сервере внутри tmux, а ПК (по SSH) и телефон подключаются к одной
и той же сессии.

Возможности:

- **Чат** — история разговора из транскрипта Claude Code: Markdown, карточки
  инструментов, цветной diff правок, ответы на запросы разрешений кнопками,
  загрузка файлов, быстрые команды.
- **Терминал** — полноценный `tmux attach` через xterm.js с панелью клавиш.
- **Push-уведомления** на iPhone: «Claude закончил» и «нужно разрешение»
  (через хуки Claude Code); не приходят, если чат и так открыт.
- **Telegram** — копия уведомления, если вы не отреагировали за N минут.
- **Предупреждение**, если тот же разговор параллельно ведёт другой Claude
  вне этой tmux-сессии.
- Сессии, избранные папки, «продолжить последний разговор», команда `cc` для
  ПК.
- Вход по PIN; доступ снаружи — через Tailscale (`tailscale serve`), без
  открытых портов.

Требования: Linux-сервер с Node.js ≥ 22 (для Telegram через прокси — ≥ 24.5),
tmux, Claude Code; Tailscale на сервере и iPhone (iOS 16.4+ для push).
Лицензия — MIT.

## Running

```sh
npm install
node bin/claude-mobile.js set-pin      # first-time setup
node bin/claude-mobile.js install-hooks
npm start                              # or: node bin/claude-mobile.js serve
```

`npm test` runs the whole suite (`node --test`).

## Быстрый запуск с ПК: cc

`bin/cc` — маленький bash-скрипт для запуска и подключения к тем же
tmux-сессиям `claude-<name>`, что видит приложение на телефоне, прямо с
компьютера по SSH.

Установка (один раз на сервере):

```sh
ln -s /home/user/claude-mobile/bin/cc ~/.local/bin/cc
```

Использование:

```sh
cc                 # открыть/создать сессию для текущей папки ($PWD)
cc my-app        # по имени из «Избранного» в приложении, если такое есть
cc /home/user/projects/app   # либо по пути — имя сессии возьмётся из basename
cc -n              # начать НОВЫЙ разговор (без --continue) для текущей папки
cc -n my-app     # то же, но для избранного/пути
cc ls              # список запущенных сессий claude-* (имя и путь)
```

Если сессия `claude-<name>` уже запущена — `cc` просто подключается к ней
(через `tmux switch-client`, если вы уже внутри tmux, иначе `tmux attach`).
Если нет — создаёт её (`tmux new-session ... claude --continue`, если только
не передан `-n`) и затем подключается.

Если указанное имя не найдено ни в избранном, ни как существующая папка,
`cc` завершится с ошибкой:

```
Не найдено: <имя>. Добавьте папку в избранное в приложении или укажите путь.
```

### Быстрый вызов с домашнего компьютера (PowerShell)

Чтобы набирать `cc <имя>` прямо в Windows Terminal / PowerShell и попадать
на сервер по SSH, добавьте функцию в свой профиль (`notepad $PROFILE`,
создать файл, если его ещё нет):

```powershell
function cc { ssh -t user@<server> "~/.local/bin/cc $args" }
```

Замените `<server>` на адрес сервера (например, Tailscale-имя машины).
После сохранения профиля откройте новое окно PowerShell — и `cc`, `cc ls`,
`cc -n my-app` и т. д. будут работать так же, как на самом сервере.

## Развёртывание

Реально работает так: без root, без systemd (см. исключение в конце) —
процесс пользователя, поднятый через cron, HTTPS через `tailscale serve`.

### 1. tailscaled (userspace, rootless)

```sh
~/.local/bin/tailscaled --tun=userspace-networking \
  --statedir=~/.local/share/tailscale \
  --socket=~/.local/share/tailscale/tailscaled.sock \
  --port=0
```

Запускается и поддерживается автоматически через `deploy/ensure-running.sh`
(см. п. 4) — руками эту команду запускать не нужно.

### 2. HTTPS — `tailscale serve`

```sh
~/.local/bin/tailscale --socket=~/.local/share/tailscale/tailscaled.sock \
  serve --bg 8787
```

Проксирует `https://<имя-машины>.<tailnet>.ts.net` → `http://127.0.0.1:8787`
(доступно только участникам вашего tailnet). Текущая конфигурация:
`tailscale --socket=... serve status`.

Альтернатива TCP — Unix-сокет, чтобы порт 8787 не был виден вообще никому
локально, кроме самого процесса (полезно, если на машине есть другие
локальные пользователи; см. `CLAUDE_MOBILE_LISTEN` в п. 3). Установленная
версия tailscale (1.102.4) это поддерживает:

```sh
tailscale --socket=~/.local/share/tailscale/tailscaled.sock \
  serve --bg unix:$HOME/.local/state/claude-mobile/http.sock
```

(`tailscale serve --help` перечисляет `unix:/path/to.sock` как допустимую
цель наравне с портом/URL.)

### 3. `~/.config/claude-mobile/env`

Простой файл вида `KEY=VALUE`, по одной переменной на строку, без кавычек
и `export`. Читается `deploy/ensure-running.sh` при каждом запуске (и
пробрасывается в процесс claude-mobile), а также `hooks/notify.js` — но
только ради `CLAUDE_MOBILE_LISTEN`/`CLAUDE_MOBILE_PORT` (хук выполняется
внутри сессии Claude, где остальных переменных claude-mobile нет).

```
CLAUDE_MOBILE_ORIGIN=https://<имя-машины>.<tailnet>.ts.net
# опционально, см. п. 2: слушать unix-сокет вместо 127.0.0.1:8787
# CLAUDE_MOBILE_LISTEN=unix:/home/user/.local/state/claude-mobile/http.sock
# опционально: HTTP-прокси для Telegram (если api.telegram.org напрямую недоступен)
# CLAUDE_MOBILE_TELEGRAM_PROXY=http://127.0.0.1:7890
```

Дублирование уведомлений в Telegram (включается и настраивается в приложении,
«Настройки → Дублировать в Telegram»): если через 5/10/30 минут после
«Claude закончил» / «нужно разрешение» вы не ответили Claude и не открыли чат
сессии, то же уведомление (без текста ответа) приходит в Telegram. Бот и
получатели берутся из настроек Telegram-канала Claude Code:
`~/.claude/channels/telegram/.env` (`TELEGRAM_BOT_TOKEN`) и `access.json`
(`allowFrom`).

`CLAUDE_MOBILE_ORIGIN` обязателен при работе через прокси: без него сервер
сверяет заголовок `Origin` с `Host`/`X-Forwarded-Host` запроса, а за
`tailscale serve` они не совпадают с тем, что видит браузер.

### 4. Автозапуск и watchdog — crontab

```
@reboot /home/user/claude-mobile/deploy/ensure-running.sh
*/5 * * * * /home/user/claude-mobile/deploy/ensure-running.sh
```

`deploy/ensure-running.sh` (POSIX `sh`, идемпотентен):

- поднимает `tailscaled`, если он ещё не запущён;
- запускает claude-mobile внутри цикла перезапуска
  (`while :; do node ...; sleep 2; done` под `setsid`), поэтому падение
  процесса чинится за пару секунд, а не ждёт следующего cron-тика (до 5 минут);
- не даёт двум запускам скрипта или двум циклам перезапуска работать
  параллельно — через `flock -n` на лок-файлах в `~/.local/state/claude-mobile/`;
- узнаёт, что claude-mobile уже запущен, по пути до самого приложения
  (`.../bin/claude-mobile.js serve`), а не по конкретному пути до `node` —
  тот меняется при обновлении nvm и с хардкодом однажды приводил бы к
  повторному (падающему на EADDRINUSE) запуску;
- пробрасывает `CLAUDE_MOBILE_LISTEN` и остальные переменные из
  `~/.config/claude-mobile/env` в процесс claude-mobile;
- делает простую ротацию логов: если лог больше 5 МБ, переносит его в
  `<файл>.1` (одно поколение, без сжатия) перед следующим запуском.

Логи: `~/.local/state/claude-mobile/tailscaled.log` и
`~/.local/state/claude-mobile/claude-mobile.log`.

Хотите перезапустить сервис руками — не убивайте `node` напрямую (watchdog
его тут же поднимет обратно, но без вашего PIN-файла запуск не пройдёт):
```sh
pkill -f 'claude-mobile.js serve'
deploy/ensure-running.sh   # поднимет заново в течение секунд
```

На хосте с включённым `loginctl enable-linger` (пользовательские сервисы
переживают выход из системы) вместо cron-скрипта можно использовать
готовый systemd user-unit `deploy/claude-mobile.service`
(`systemctl --user enable --now claude-mobile`) — это альтернатива, а не то,
что реально запущено на этом сервере: unit не поднимает `tailscaled` и не
делает watchdog-цикл, только `Restart=on-failure`.

### 5. Смена PIN

```sh
node bin/claude-mobile.js set-pin   # 6–8 цифр
```

Перезапускать сервис не нужно: работающий процесс сам подхватывает новый
PIN-хэш и новый cookie-secret (дешёвая проверка `mtime` файлов при каждом
входе/проверке куки) — это разлогинивает все устройства сразу.

### 6. iPhone

Телефон должен быть участником того же tailnet. Откройте в Safari
`https://<имя-машины>.<tailnet>.ts.net`, войдите по PIN, затем
«Поделиться» → «На экран "Домой"» — только так PWA получает push-уведомления
и полноэкранный режим без адресной строки Safari.
