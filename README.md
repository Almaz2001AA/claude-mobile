# claude-mobile

Node.js server + PWA for controlling Claude Code sessions running in tmux
(`claude-<name>`) from an iPhone. No build step — the client is vanilla ES
modules served straight from `public/`.

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
