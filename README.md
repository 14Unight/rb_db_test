# Roblox ↔ MariaDB Bridge (v3.0.0 Secure Edition)

Универсальный высокопроизводительный и защищённый мост: **Roblox Studio** ⇄ **HTTP REST API** ⇄ **Node.js** ⇄ **MariaDB**.

Работает с **любой** игрой в Roblox Studio: баланс монет и кристаллов, уровни, опыт, инвентарь с метаданными, питомцы, квесты, флаги, вложенные JSON-структуры, таблица лидеров, журнал действий, защита от дюпов (Session Locking), система банов и промокоды.

```
 Roblox Studio                     твой ПК                        твой ПК
┌──────────────┐   HTTP    ┌──────────────────┐   SQL    ┌──────────────┐
│ ProfileSync  │ ────────► │  Node.js :3000   │ ───────► │   MariaDB    │
│ DataManager  │ ◄──────── │  Express + mysql2│ ◄─────── │  roblox_db   │
│ DataClient   │   JSON    └──────────────────┘  JSON    └──────────────┘
└──────────────┘           [Anti-DoS, Whitelist,         [Auto-Migrations,
                            Timing-Safe Auth]             InnoDB, JSON]
```

---

## 🛡️ Безопасность и «Плюшки» версии 3.0.0

- 🔒 **Строгий Античит (Server-Authoritative):** Клиенты не могут произвольно начислять валюту или переписывать инвентарь через RemoteFunction. Разрешены только ключи из белого списка `ClientWritableKeys`.
- ⚡ **Защита от дюпа (Session Locking):** Предотвращает дублирование предметов при одновременном входе игрока на несколько серверов.
- 🚫 **Встроенная система банов:** Блокировка нечестных игроков прямо через API (`POST /player/ban`) с автоматическим киком при попытке входа.
- 🎁 **Система промокодов:** Создание кодов с лимитом активаций, сроком действия и автоматическим начислением монет/кристаллов/предметов в одной транзакции.
- ⏱️ **Защита от Timing Attacks:** Проверка токенов API с постоянным временем (`crypto.timingSafeEqual`).
- 🛡️ **Защита от DoS и спама:** Встроенный In-Memory Rate Limiter с ограничением запросов по IP.
- 🛡️ **Защита от Prototype Pollution и Injection:** Строгая проверка ключей и очистка JSON-структур.
- 💎 **Выделенные колонки валют и прогресса:** `coins`, `gems`, `level`, `xp` индексированы для мгновенных таблиц лидеров, а любые вложенные структуры хранятся в `data (JSON)`.
- 🔄 **Отказоустойчивость:** Сервер не падает, если MariaDB ещё не запущена, а автоматически переподключается в фоне.

---

## 📁 Структура проекта

| Что | Где | Описание |
|---|---|---|
| `server/index.js` | сервер | REST API сервер: Rate Limiter, валидация, маршруты |
| `server/store.js` | сервер | Логика БД: профили, инвентарь, баны, промокоды, сессии |
| `server/db.js` | сервер | Пул соединений MariaDB, транзакции, авто-миграции |
| `server/util.js` | сервер | Защита от Prototype Pollution, timing-safe checks, валидация |
| `server/db/schema.sql` | сервер | DDL-схема базы данных MariaDB (v3.0.0) |
| `roblox/ServerScriptService/ProfileSync.server.lua` | игра | Главный конфигурационный скрипт для игры |
| `roblox/ServerScriptService/Modules/DataManager.lua` | игра | Состояние игроков в памяти, leaderstats, автосейв, античит |
| `roblox/ServerScriptService/Modules/DataStore.lua` | игра | HTTP-клиент с повторами и кодированием URL |
| `roblox/StarterPlayer/StarterPlayerScripts/DataClient.client.lua` | игра | Клиентский модуль для UI |
| `roblox/ServerScriptService/Examples/SafeShop.server.lua` | игра | Готовый пример безопасного серверного магазина |
| `roblox/ServerScriptService/Examples/CoinPickup.server.lua` | игра | Готовый пример подбираемых монеток в мире |
| `roblox/ServerScriptService/Examples/LeaderboardStand.server.lua` | игра | 3D-стенд таблицы лидеров в Workspace |
| `roblox/StarterPlayer/StarterPlayerScripts/PromoCodeGui.client.lua` | игра | Готовый GUI интерфейс активации промокодов |

---

## 🚀 Быстрый старт

### 1. Запуск сервера

1. Убедись, что служба MariaDB или MySQL запущена на порту 3306.
2. Открой папку `server`:
   ```powershell
   cd server
   copy .env.example .env    # если файла .env ещё нет
   npm start
   ```
3. Сервер выведет:
   ```
   [db] MariaDB OK · база "roblox_db" · схема и миграции применены
   [http] HTTP Сервер запущен: http://localhost:3000
   ```
   *База `roblox_db` и все таблицы создаются полностью автоматически!*

### 2. Подключение в Roblox Studio

1. Открой плейс в Roblox Studio.
2. Перейди в: **Home → Game Settings → Security → Allow HTTP Requests** → **ВКЛЮЧИТЬ**.
3. Скопируй файлы из папки `roblox/` в соответствующие папки обозревателя (Explorer):
   - `roblox/ServerScriptService/ProfileSync.server.lua` → `ServerScriptService/ProfileSync` (Script)
   - `roblox/ServerScriptService/Modules/DataStore.lua` → `ServerScriptService/Modules/DataStore` (ModuleScript)
   - `roblox/ServerScriptService/Modules/DataManager.lua` → `ServerScriptService/Modules/DataManager` (ModuleScript)
   - `roblox/StarterPlayer/StarterPlayerScripts/DataClient.client.lua` → `StarterPlayer/StarterPlayerScripts/DataClient` (LocalScript)
4. Нажми кнопку **Play** в Studio. В консоли Output появится:
   ```
   [DataManager] Запущен · Подключен к API: http://localhost:3000
   [DataManager] Игрок Player1 успешно загружен: Coins=0, Gems=0, Level=1
   ```

---

## 📖 Документация

- [docs/API.md](docs/API.md) — Справочник всех REST API эндпоинтов, параметры, примеры JSON.
- [docs/ROBLOX.md](docs/ROBLOX.md) — Инструкция по настройке, leaderstats, античиту и атрибутам.
- [docs/EXAMPLES.md](docs/EXAMPLES.md) — Рецепты кода: магазин, квесты, питомцы, промокоды, стенды лидеров.