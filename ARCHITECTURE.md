# WireDeck — архитектурный контракт

Self-hosted панель управления WireGuard VPN: один Node-процесс, который поднимает
WireGuard-интерфейс, управляет пирами (юзерами), собирает статистику трафика в SQLite
и отдаёт красивую веб-морду (React SPA, русский язык).

Этот файл — **контракт** между модулями. Реализация каждого модуля обязана
соответствовать сигнатурам и форматам отсюда. При конфликте — контракт прав.

## Стек

- **server/**: Node 22+, TypeScript, ESM (`"type": "module"`, module NodeNext —
  относительные импорты обязательно с расширением `.js`), Fastify 5,
  better-sqlite3, node:crypto (X25519-ключи, scrypt для пароля).
- **web/**: React 19, Vite, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`),
  react-router-dom 7, recharts 2, qrcode, lucide-react.
- npm workspaces: корневой package.json → `server`, `web`.
- Прод: Docker (node:24-alpine + wireguard-tools), либо bare-metal Linux.
- Dev на Windows/Mac: автоматический mock-режим WireGuard (см. ниже).

## Раскладка файлов и владельцы

```
package.json, .gitignore, ARCHITECTURE.md          — каркас (готово)
server/
  package.json, tsconfig.json                      — каркас (готово)
  src/
    config.ts        — каркас (готово): env-конфиг
    types.ts         — каркас (готово): общие типы
    ipam.ts          — агент wg: выделение IP в подсети
    wg/
      runner.ts      — каркас (готово): интерфейс WgRunner
      keys.ts        — агент wg: генерация ключей X25519 + preshared
      confgen.ts     — агент wg: рендер конфигов (сервер + клиент)
      linux.ts       — агент wg: реальный runner (wg-quick / wg syncconf)
      mock.ts        — агент wg: mock runner с живой симуляцией трафика
      index.ts       — агент wg: createRunner(cfg)
    db.ts            — агент db: better-sqlite3, миграции, CRUD
    seed.ts          — агент db: демо-данные для mock-режима
    stats/
      poller.ts      — агент db: опрос статистики, дельты, агрегация
      queries.ts     — агент db: выборки для API (overview, timeseries, top)
    auth.ts          — агент api: пароль админа, сессии
    api/
      routes.ts      — агент api: все REST-маршруты
    index.ts         — агент api: bootstrap всего процесса
web/
  package.json, tsconfig.json, vite.config.ts, index.html — каркас (готово)
  src/
    main.tsx, App.tsx, index.css                   — каркас (готово)
    lib/types.ts, lib/api.ts, lib/format.ts        — каркас (готово)
    components/Layout.tsx      — агент web-core: сайдбар + Outlet
    components/PeerConfig.tsx  — агент web-core: QR + скачать/скопировать конфиг
    pages/Login.tsx            — агент web-core: логин + первичная настройка
    pages/Users.tsx            — агент web-core: таблица юзеров, создание, toggle
    pages/Dashboard.tsx        — агент web-stats: карточки + графики
    pages/UserDetail.tsx       — агент web-stats: страница юзера (QR, график, действия)
    components/charts/*        — агент web-stats: переиспользуемые графики
deploy/
  Dockerfile, docker-compose.yml, install.sh       — агент deploy
README.md                                          — агент deploy (на русском)
```

Каждый агент пишет **только свои файлы**. Импортировать чужие модули можно —
строго по сигнатурам из этого файла.

## Конфигурация (server/src/config.ts — готово)

Всё через env, все значения имеют дефолты для локальной разработки:

| Env | Дефолт | Смысл |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP панели |
| `DATA_DIR` | `./data` | БД + wg-конфиг (в Docker: `/data`) |
| `WG_HOST` | `''` | Публичный IP/домен сервера (обязателен в проде) |
| `WG_PORT` | `51820` | UDP-порт WireGuard |
| `WG_INTERFACE` | `wg0` | Имя интерфейса |
| `WG_SUBNET` | `10.8.0.0/24` | Подсеть VPN; сервер — первый хост (.1) |
| `WG_DNS` | `1.1.1.1` | DNS для клиентов |
| `WG_ALLOWED_IPS` | `0.0.0.0/0, ::/0` | AllowedIPs в клиентском конфиге |
| `WG_PERSISTENT_KEEPALIVE` | `25` | keepalive клиента |
| `WG_MTU` | `''` | пусто = не указывать |
| `WG_MOCK` | авто | `1`/`true` — мок; по умолчанию мок везде, кроме linux |
| `WG_MOCK_SEED` | `1` в мок-режиме | Засеять демо-юзеров и историю трафика |
| `POLL_INTERVAL_MS` | `15000` | Период опроса статистики |
| `WEB_DIST` | `../../web/dist` от dist/ | Путь к собранной SPA |

Экспорт: `export const config` (см. файл), `export type Config`.

## База данных (better-sqlite3, WAL)

```sql
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  private_key TEXT NOT NULL,      -- клиентский приватный ключ (base64)
  public_key TEXT NOT NULL,
  preshared_key TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,   -- чистый IP, например '10.8.0.2'
  enabled INTEGER NOT NULL DEFAULT 1,
  total_rx INTEGER NOT NULL DEFAULT 0,   -- байты за всё время
  total_tx INTEGER NOT NULL DEFAULT 0,
  last_handshake INTEGER,                -- unix ms, NULL = никогда
  created_at INTEGER NOT NULL,           -- unix ms
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS traffic_hourly(
  user_id INTEGER NOT NULL,
  hour_ts INTEGER NOT NULL,       -- unix ms, усечённый до начала часа
  rx INTEGER NOT NULL DEFAULT 0,
  tx INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, hour_ts)
);
```

Ключи `settings`: `admin_password_hash` (`<salt_hex>:<scrypt_hex>`),
`server_private_key`, `server_public_key`.

Направление трафика: **rx/tx с точки зрения сервера** (как в `wg show dump`):
`rx` = получено от клиента (его upload), `tx` = отправлено клиенту (его download).

## Контракты модулей (точные сигнатуры)

### server/src/types.ts (готово) — см. файл. Ключевое:

```ts
UserRow { id, name, privateKey, publicKey, presharedKey, address, enabled,
          totalRx, totalTx, lastHandshake: number|null, createdAt, updatedAt }
PeerStats { publicKey, endpoint: string|null, lastHandshake: number|null, rx, tx }
WgPeer { publicKey, presharedKey, allowedIps }        // allowedIps = '10.8.0.x/32'
ServerWgState { iface, privateKey, address /* '10.8.0.1/24' */, listenPort, mtu?, peers: WgPeer[] }
UserDTO, OverviewDTO, TimeseriesPoint, UserUsage, OnlineUserDTO, Range — DTO для API (см. файл)
```

### server/src/wg/runner.ts (готово)

```ts
export interface WgRunner {
  up(state: ServerWgState): Promise<void>;    // создать/поднять интерфейс, идемпотентно
  sync(state: ServerWgState): Promise<void>;  // применить изменения пиров без рестарта
  stats(): Promise<PeerStats[]>;
  down(): Promise<void>;
}
```

### агент wg

```ts
// wg/keys.ts — через node:crypto, БЕЗ бинарника wg:
export function genKeypair(): { privateKey: string; publicKey: string }
export function genPresharedKey(): string
// X25519: generateKeyPairSync('x25519');
// priv = privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('base64')
// pub  = publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64')
// preshared = randomBytes(32).toString('base64')

// ipam.ts
export function serverAddress(subnet: string): string          // '10.8.0.0/24' -> '10.8.0.1'
export function subnetPrefix(subnet: string): number           // -> 24
export function nextFreeAddress(subnet: string, taken: string[]): string  // след. свободный IP (с .2), throw если нет

// wg/confgen.ts
export function buildServerState(cfg: Config, serverPrivateKey: string, users: UserRow[]): ServerWgState
// peers — только enabled-юзеры
export function renderClientConfig(cfg: Config, serverPublicKey: string, user: UserRow): string
// [Interface] PrivateKey, Address = <ip>/<prefix подсети>, DNS
// [Peer] PublicKey=<server>, PresharedKey, Endpoint=<WG_HOST>:<WG_PORT>,
//        AllowedIPs=<WG_ALLOWED_IPS>, PersistentKeepalive

// wg/index.ts
export function createRunner(cfg: Config): WgRunner   // mock или linux по cfg.wg.mock
```

**linux.ts**: конфиг wg-quick пишется в `<DATA_DIR>/<iface>.conf` (chmod 600):
`[Interface] PrivateKey, Address, ListenPort, PostUp/PostDown` (iptables MASQUERADE
для подсети на egress-интерфейс — определить через `ip -4 route show default`,
fallback `eth0`; плюс FORWARD accept для %i). `up()`: если `ip link show <iface>`
успешен → `sync()`, иначе `wg-quick up <путь>`. `sync()`: записать **wg-нативный**
конфиг (только PrivateKey/ListenPort + пиры, без Address/PostUp) во временный файл →
`wg syncconf <iface> <файл>` → удалить файл. `stats()`: `wg show <iface> dump` —
табы-разделители; строки пиров: `public_key preshared_key endpoint allowed_ips
latest_handshake(unix sec, 0 = никогда) transfer_rx transfer_tx keepalive`.
`down()`: `wg-quick down <путь>`, ошибки глотать.

**mock.ts**: держит state в памяти. Симуляция: у каждого enabled-пира с шансом
~60% «онлайн-сессия» (включается/выключается случайно раз в несколько минут);
у онлайн-пиров rx/tx монотонно растут случайными шагами (rx 0.1–2 МБ, tx 0.5–8 МБ
за тик `stats()`), lastHandshake обновляется. Счётчики НЕ сбрасываются между
sync(). Выглядеть должно живо: панель в dev-режиме показывает движущийся трафик.

### агент db

```ts
// db.ts (синглтон модуля)
export function openDb(dbPath: string): void          // + миграции, WAL
export function getSetting(key: string): string | null
export function setSetting(key: string, value: string): void
export function listUsers(): UserRow[]                // ORDER BY id
export function getUser(id: number): UserRow | null
export function createUser(u: { name: string; privateKey: string; publicKey: string;
                                presharedKey: string; address: string }): UserRow
export function updateUser(id: number, patch: { name?: string; enabled?: boolean }): UserRow | null
export function deleteUser(id: number): boolean       // + удалить traffic_hourly юзера
export function updateCounters(id: number,
  c: { totalRx: number; totalTx: number; lastHandshake: number | null }): void
export function addHourlyTraffic(userId: number, hourTs: number, rxDelta: number, txDelta: number): void

// stats/poller.ts
export function startPoller(runner: WgRunner, intervalMs: number): void
export function getLiveRate(userId: number): { rateRx: number; rateTx: number } | null
// Текущая скорость (байт/сек): дельта тика / фактически прошедшее время между
// удачными тиками. Первый тик после старта = 0. null — замера нет или он
// протух (старше ~2.5 периодов поллера, т.е. опрос wg давно падает). Пиры,
// исчезнувшие из stats (выключен/удалён), из карты удаляются.
// Каждый тик: runner.stats() → матчить пиров с юзерами по publicKey.
// Дельты против предыдущего замера (в памяти, ключ publicKey):
//   delta = cur - prev; если cur < prev (рестарт интерфейса) → delta = cur.
//   Первый замер после старта процесса: prev = cur, дельта 0 (не задваивать total).
// total_rx/tx юзера = сохранённый total на момент старта пира + текущий счётчик?
//   НЕТ — проще: total_rx += delta каждый тик (updateCounters с новыми суммами).
// last_handshake: из stats (sec → ms), 0 = null; писать только если изменился.
// Дельты > 0 → addHourlyTraffic(текущий час).

// stats/queries.ts
export type { Range } from '../types.js'
export function overview(cfg: Config): OverviewDTO
// usersTotal, usersOnline (last_handshake > now-180s), rxToday/txToday (sum
// traffic_hourly с начала локального дня), rxTotal/txTotal (sum users.total_*),
// server: { host: cfg.wg.host, port, publicKey: getSetting('server_public_key') ?? '',
//           subnet, iface, mock: cfg.wg.mock }
export function timeseries(range: Range, userId?: number): TimeseriesPoint[]
// 24h → 24 часовых точек, 7d → 168 часовых, 30d → 30 дневных (агрегация по дням).
// Пустые интервалы заполнять нулями (непрерывный ряд). ts = начало интервала, unix ms.
export function topUsers(range: Range): UserUsage[]   // sum rx/tx за период, desc по rx+tx, все юзеры
export function onlineUsers(): OnlineUserDTO[]
// Юзеры с last_handshake младше 180с (критерий тот же, что в overview.usersOnline),
// + текущие скорости из getLiveRates() (округлённые до целых байт/с),
// сортировка по суммарной скорости desc, затем по id.

// seed.ts
export function maybeSeedDemo(cfg: Config): void
// Только если cfg.wg.mockSeed && в БД нет юзеров: создать 5 юзеров с русскими
// именами (Алиса, Борис, Виктор, Галина, Даша), ключи через wg/keys.js, адреса
// через ipam.js; забэкфиллить traffic_hourly за 30 дней правдоподобным паттерном
// (день/ночь, разный профиль у юзеров, суммарно единицы-десятки ГБ) и выставить
// total_rx/tx = суммам, last_handshake разбросать (2 юзера «онлайн» = недавний).
```

### агент api

```ts
// auth.ts
export function needsSetup(): boolean                     // нет admin_password_hash
export function setupAdmin(password: string): void        // scrypt(64), salt random 16b
export function verifyPassword(password: string): boolean // timingSafeEqual
export function createSession(): string                   // token = randomBytes(32).hex; Map в памяти, TTL 30 дней
export function checkSession(token: string | undefined): boolean
export function destroySession(token: string | undefined): void

// api/routes.ts
export function registerRoutes(app: FastifyInstance,
  deps: { cfg: Config; runner: WgRunner }): void
```

**index.ts (bootstrap)**: openDb → ключи сервера в settings (genKeypair, если нет) →
maybeSeedDemo → createRunner → `runner.up(buildServerState(...))` → startPoller →
Fastify: @fastify/cookie, registerRoutes, @fastify/static (root = cfg.webDist,
если папка существует) + SPA-fallback (setNotFoundHandler: не-/api → index.html,
/api → 404 JSON) → listen. Грациозное завершение по SIGINT/SIGTERM (runner.down()
только в НЕ-mock… нет: down() при завершении процесса НЕ вызывать — интерфейс
должен переживать рестарт панели; просто закрыть сервер). Ошибку `WG_HOST` не
задан в не-mock режиме — залогировать warning, не падать.

## REST API

Сессия: cookie `sid` (httpOnly, sameSite=lax, path=/, maxAge 30 дней).
Все `/api/*` кроме `/api/auth/status|setup|login` требуют валидную сессию, иначе
`401 {"error":"Не авторизован"}`. Ошибки всегда `{ "error": string }` (на русском).
Валидация: `name` — строка 1..64 символов после trim, вырезать управляющие
символы и переводы строк (инъекция в conf-файл!).

| Метод и путь | Тело | Ответ |
|---|---|---|
| GET `/api/auth/status` | — | 200 `{needsSetup, authenticated}` (всегда 200) |
| POST `/api/auth/setup` | `{password}` (мин. 8 симв.) | 204; 409 если уже настроено |
| POST `/api/auth/login` | `{password}` | 204 + cookie; 401 при неверном (задержка 500мс) |
| POST `/api/auth/logout` | — | 204 |
| GET `/api/users` | — | 200 `UserDTO[]` |
| POST `/api/users` | `{name}` | 201 `UserDTO`; создаёт ключи, IP, → `runner.sync` |
| GET `/api/users/:id` | — | 200 `UserDTO`; 404 |
| PATCH `/api/users/:id` | `{name?, enabled?}` | 200 `UserDTO`; → `runner.sync` при смене enabled |
| DELETE `/api/users/:id` | — | 204; → `runner.sync` |
| GET `/api/users/:id/config` | — | 200 text/plain, `Content-Disposition: attachment; filename="<safe>.conf"` (safe = [a-zA-Z0-9_-], иначе `wg-client-<id>`) |
| GET `/api/stats/overview` | — | 200 `OverviewDTO` |
| GET `/api/stats/timeseries?range=24h\|7d\|30d&user=<id?>` | — | 200 `TimeseriesPoint[]` |
| GET `/api/stats/top?range=` | — | 200 `UserUsage[]` |
| GET `/api/stats/online` | — | 200 `OnlineUserDTO[]` — кто онлайн + скорость байт/с |

`UserDTO` (никогда не отдавать privateKey/presharedKey в списках):
```ts
{ id, name, address, publicKey, enabled, createdAt,
  totalRx, totalTx, lastHandshake: number|null, online: boolean /* < 180s */ }
```

После **каждого** изменения юзеров (create/patch-enabled/delete) роут обязан
пересобрать state (`buildServerState(cfg, priv, listUsers())`) и вызвать
`runner.sync(state)`; ошибки sync логировать, но HTTP-ответ не валить.

## Фронтенд

SPA на русском. `web/src/lib/api.ts` (готово) — единственный способ ходить в API.
`api.onUnauthorized` дергается при любом 401 → App сбрасывает auth-состояние.

Контракты компонентов (владелец web-core, использует и web-stats):

```tsx
// components/Layout.tsx — props: { onLogout: () => void }
// Сайдбар: логотип «WireDeck», навигация (Дашборд /, Пользователи /users),
// внизу — статус сервера (mock-бейдж «демо-режим» если server.mock) и кнопка выхода.
// Рендерит <Outlet/>. Адаптив: на мобильном сайдбар сворачивается в верхнюю панель.

// components/PeerConfig.tsx — props: { userId: number; userName: string }
// Сам грузит текст конфига через api.getUserConfig, показывает: QR-код (библиотека
// qrcode, toDataURL, размер ~260px), кнопки «Скачать .conf» (Blob) и «Скопировать».

// pages/Login.tsx — props: { needsSetup: boolean; onSuccess: () => void }
// Центрированная карточка. needsSetup=true → «Придумайте пароль администратора»
// (+ подтверждение, мин. 8 символов), иначе — логин. Ошибки — в карточке.

// pages/Users.tsx — таблица: имя, IP, статус (зелёная точка «онлайн» / серая +
// timeAgo хендшейка), трафик ↓выгрузка ↑ (formatBytes(totalTx)/(totalRx)), тумблер
// enabled (api.updateUser), строка кликабельна → /users/:id. Кнопка «Добавить
// пользователя» → модалка с именем → после создания сразу показать PeerConfig
// (QR + скачать). Автообновление списка каждые 10 сек (setInterval + cleanup).

// pages/Dashboard.tsx — 4 стат-карточки (юзеров всего / онлайн, трафик сегодня
// ↓+↑, трафик за всё время), переключатель периода 24ч/7д/30д, area-график.
// В карточке «Пользователи» под счётчиком онлайна — мини-список онлайн-юзеров
// (api.onlineUsers, поллинг каждые 10 сек): точка, имя, «↓ X/с · ↑ Y/с» мелким
// текстом; высота ~5 строк, при большем количестве — вертикальный скролл;
// строка кликабельна → /users/:id.
// суммарного трафика (rx/tx), топ-5 юзеров по трафику за период (горизонтальные
// бары или компактный список с formatBytes). Автообновление каждые 30 сек.

// pages/UserDetail.tsx — заголовок с именем (inline-переименование), статус,
// IP, создан, трафик; PeerConfig (QR + кнопки); график трафика юзера с
// переключателем периода; действия: включить/выключить, удалить (confirm).
```

### Стайл-гайд (обязателен для обоих web-агентов)

Тёмная тема, сдержанно и дорого: фон `bg-slate-950`, панели `bg-slate-900/60` +
`border border-slate-800` + `rounded-xl`, текст `text-slate-100`, вторичный
`text-slate-400`. Акцент — emerald: кнопки `bg-emerald-500 hover:bg-emerald-400
text-slate-950 font-medium`, ссылки/активная навигация `text-emerald-400`.
Графики: rx (выгрузка юзера) `#34d399`, tx (загрузка юзера) `#38bdf8`, сетка
`#1e293b`, area с градиентом до прозрачного. Онлайн-точка `bg-emerald-400` +
`animate-pulse`, оффлайн `bg-slate-600`. Иконки lucide-react, размер 16–20.
Системный шрифт. Никаких внешних CDN/шрифтов. Пустые состояния и состояния
загрузки обязательны (скелетоны или спиннер), ошибки — красная плашка
`bg-red-500/10 text-red-400 border-red-500/30`.

В терминологии UI: rx сервера показывать юзеру как «выгрузка ↑», tx — «загрузка ↓».

## Деплой (агент deploy)

- **deploy/Dockerfile** (контекст сборки — корень репо): stage1 node:24-alpine —
  npm ci по workspaces, build web + server; stage2 node:24-alpine + `apk add
  wireguard-tools iptables ip6tables bash iproute2` — прод-зависимости server
  (`npm ci --omit=dev -w server`), копия dist-ов с сохранением раскладки
  (`/app/server/dist`, `/app/web/dist`, node_modules), `ENV DATA_DIR=/data`,
  `CMD ["node","/app/server/dist/index.js"]`.
- **deploy/docker-compose.yml**: build context `..`, `cap_add: NET_ADMIN`,
  sysctls `net.ipv4.ip_forward=1`, `net.ipv4.conf.all.src_valid_mark=1`,
  ports `51820:51820/udp`, `8080:8080/tcp`, volume `wiredeck_data:/data`,
  env `WG_HOST` (обязателен), restart unless-stopped.
- **Management-скрипты в корне** (основной способ управления): `start.sh` —
  первичная настройка и запуск (проверка/установка Docker, WG_HOST → deploy/.env,
  compose up, в конце URL панели; пароль администратора задаётся в веб-панели
  при первом входе), `restart.sh` (down+up, применяет .env), `update.sh`
  (git pull + пересборка, только если задеплоен не текущий коммит — метка
  deploy/.deployed), `logs.sh`, `stop.sh` (volume сохраняется).
- **deploy/install.sh**: тонкий бутстрап для `curl | sudo bash` на чистой
  Ubuntu/Debian: ставит git/curl, клонирует репо в /opt/wiredeck (или обновляет)
  и передаёт управление start.sh.
- **README.md** (русский): что это, скриншот-плейсхолдер, быстрый старт одной
  командой, ручная установка, все env, dev-режим (`npm install && npm run dev`,
  мок-режим), архитектура кратко, безопасность (пароль, рекомендация reverse
  proxy + TLS для панели).

## Конвенции

- ESM везде на сервере; относительные импорты с `.js`. Никаких `require`.
- Ошибки внешних команд (`wg`, `ip`) — оборачивать, в лог писать stderr.
- Байты везде `number` (JS safe до 9 ПБ — ок). Время — unix ms, кроме conf/wg.
- Логи сервера — console.log/error с префиксами `[wg]`, `[poller]`, `[http]`.
- Не добавлять зависимостей сверх перечисленных в package.json без крайней нужды.
- UI-тексты — русский. Код, идентификаторы, комментарии — англ. или рус., кратко.
