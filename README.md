# BlackVPN_remna

Платный VPN-сервис поверх [Remnawave](https://github.com/remnawave): продажа
подписок через Telegram-бота, выдача ссылки для Happy / v2RayTun и
подобных клиентов, управление нодами и пользователями из админ-бота.

Архитектура: главный сервер (Remnawave Panel + вся бизнес-логика) → ноды
(только Remnawave Node / Xray-core). Проект старается использовать готовые
возможности Remnawave и не переизобретать то, что панель уже умеет
(управление нодами, пользователями, статистика, вебхуки, шаблоны
подписки и т.д.).

## Структура репозитория

```
scripts/
  install-main-server.sh   Установка Remnawave Panel + Caddy на главный сервер
  install-node.sh           Установка Remnawave Node на сервер ноды
  lib/common.sh              Общие bash-функции для обоих скриптов
```

Бот (Telegram, Node.js/TypeScript + grammY) будет добавлен в следующих
итерациях в директорию `bot/`.

## Установка главного сервера

Требования: чистый Ubuntu/Debian сервер, root-доступ, домен, чей A-record
уже указывает на IP этого сервера.

```bash
sudo PANEL_DOMAIN=panel.example.com bash scripts/install-main-server.sh
```

Скрипт идемпотентен (повторный запуск не перегенерирует секреты, если
`.env` уже существует) и делает следующее:

1. Ставит Docker Engine + Compose plugin (`get.docker.com`).
2. Настраивает `ufw` (22, 80, 443).
3. Скачивает официальные `docker-compose-prod.yml` и `.env.sample` из
   `remnawave/backend` и генерирует секреты (`APP_SECRET`, `METRICS_PASS`,
   `WEBHOOK_SECRET_HEADER`, пароль Postgres) — так же, как описано в
   [официальной документации Remnawave](https://github.com/remnawave/panel/blob/main/docs/install/remnawave-panel.md).
4. Прописывает домен (`PANEL_DOMAIN`, `FRONT_END_DOMAIN`,
   `SUB_PUBLIC_DOMAIN`) и поднимает панель (`docker compose up -d`).
5. Поднимает Caddy как reverse proxy с автоматическим SSL.

После установки открой `https://panel.example.com` — первый заход
предложит создать аккаунт суперадмина. Сделай это до того, как это сможет
сделать кто-то другой.

Для более защищённого периметра (MFA на логине, API-ключи для `/api/*`)
позже можно перейти на `remnawave/caddy-with-auth` — см. документацию
Remnawave. Этот скрипт намеренно ставит минимальный рабочий вариант.

## Установка ноды

Выполняется на сервере ноды. `SECRET_KEY` берётся из панели (Nodes → Add
node → Copy docker-compose.yml, либо через API `/api/keygen`, либо позже —
через команду в админ-боте).

```bash
sudo NODE_PORT=2222 SECRET_KEY='...' PANEL_IP=<IP главного сервера> \
    bash scripts/install-node.sh
```

`PANEL_IP` используется, чтобы открыть `NODE_PORT` только для главного
сервера (`ufw allow from <PANEL_IP> ...`), а не всему интернету.

После этого ноду нужно доделать в панели: Nodes → Management → указать
адрес/порт этого сервера и выбрать Config Profile.

Оба скрипта не интерактивны, если переменные окружения уже заданы — это
сделано специально, чтобы админ-бот впоследствии мог запускать их сам по
SSH одной командой.
