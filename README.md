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
  install-main-server.sh   Установка Remnawave Panel + Caddy + автобутстрап
  install-node.sh           Установка Remnawave Node на сервер ноды
  add-node.sh                 Регистрация новой ноды на панели (+ опционально SSH-установка)
  lib/common.sh                Общие bash-функции для всех скриптов
bot/
  src/remnawave/client.ts        Тонкий клиент Remnawave API
  src/remnawave/reality-inbound.ts Генератор VLESS+Reality inbound
  src/cli/bootstrap.ts             CLI: супер-админ, API-токен, Config Profile
  src/cli/add-node.ts               CLI: регистрация ноды + Host на панели
```

Telegram-бот (grammY) будет добавлен в следующих итерациях поверх того же
`bot/` — клиент Remnawave API и CLI-инструменты ниже написаны так, чтобы
бот мог напрямую их переиспользовать.

## Установка главного сервера

Требования: чистый Ubuntu/Debian сервер, root-доступ, домен, чей A-record
уже указывает на IP этого сервера.

```bash
sudo PANEL_DOMAIN=panel.example.com bash scripts/install-main-server.sh
```

Скрипт идемпотентен (повторные шаги пропускаются, если уже выполнены) и
делает следующее:

1. Ставит Docker Engine + Compose plugin (`get.docker.com`).
2. Настраивает `ufw` (22, 80, 443).
3. Скачивает официальные `docker-compose-prod.yml` и `.env.sample` из
   `remnawave/backend` и генерирует секреты (`APP_SECRET`, `METRICS_PASS`,
   `WEBHOOK_SECRET_HEADER`, пароль Postgres) — так же, как описано в
   [официальной документации Remnawave](https://github.com/remnawave/panel/blob/main/docs/install/remnawave-panel.md).
4. Прописывает домен (`PANEL_DOMAIN`, `FRONT_END_DOMAIN`,
   `SUB_PUBLIC_DOMAIN`) и поднимает панель (`docker compose up -d`).
5. Поднимает Caddy как reverse proxy с автоматическим SSL.
6. Ставит Node.js и запускает `bot/src/cli/bootstrap.ts`, который:
   - регистрирует супер-админа (уникально: работает только пока в панели
     ещё нет ни одного админа — это гарантирует сама панель) со
     сгенерированным паролем;
   - создаёт для бота долгоживущий API-токен;
   - добавляет в автоматически засеянный панелью `Default-Profile`
     инбаунд **VLESS + Reality** (порт 443, свежесгенерированный
     X25519-ключ, случайный shortId), не трогая уже существующий
     Shadowsocks-инбаунд.

Пароль супер-админа и API-токен печатаются в терминал один раз и
сохраняются в `${REMNAWAVE_DIR:-/opt/remnawave}/bootstrap-summary.json`
(`chmod 600`). Повторный запуск скрипта пропускает бутстрап, если этот
файл уже существует.

Для более защищённого периметра (MFA на логине, API-ключи для `/api/*`)
позже можно перейти на `remnawave/caddy-with-auth` — см. документацию
Remnawave. Этот скрипт намеренно ставит минимальный рабочий вариант.

## Добавление ноды

Два шага: регистрация на панели (`scripts/add-node.sh`, с главного
сервера) и установка Remnawave Node на самом сервере ноды
(`scripts/install-node.sh`).

```bash
# С главного сервера — заводит Node + Host в Remnawave через API,
# используя API-токен и Config Profile из bootstrap-summary.json:
NODE_NAME=de-1 NODE_ADDRESS=203.0.113.10 bash scripts/add-node.sh
```

По умолчанию скрипт только печатает готовую команду для установки на
сервере ноды. Если задать `NODE_SSH_HOST` (и есть root-доступ по SSH-ключу
до этого сервера), он выполнит установку там сам:

```bash
NODE_NAME=de-1 NODE_ADDRESS=203.0.113.10 \
    NODE_SSH_HOST=203.0.113.10 PANEL_IP=<IP главного сервера> \
    bash scripts/add-node.sh
```

Ручной вариант установки на сервере ноды (то, что `add-node.sh` в итоге
выполняет по SSH сам):

```bash
sudo NODE_PORT=2222 SECRET_KEY='...' PANEL_IP=<IP главного сервера> \
    bash scripts/install-node.sh
```

`PANEL_IP` используется, чтобы открыть `NODE_PORT` только для главного
сервера (`ufw allow from <PANEL_IP> ...`), а не всему интернету.

Все скрипты не интерактивны, если переменные окружения уже заданы — это
сделано специально, чтобы админ-бот впоследствии мог запускать их сам по
SSH одной командой.
