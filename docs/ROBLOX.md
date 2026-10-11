# Интеграция с Roblox Studio (v3.0.0)

## Куда поместить скрипты в Roblox Studio

```
ServerScriptService
├── ProfileSync                     ← Script (настройки игры CONFIG)
├── Modules
│   ├── DataStore                   ← ModuleScript (HTTP запросы к MariaDB)
│   └── DataManager                 ← ModuleScript (состояние в памяти и античит)
└── Examples
    ├── SafeShop                    ← Script (пример безопасного магазина)
    ├── CoinPickup                  ← Script (подбираемые монеты в Workspace)
    └── LeaderboardStand            ← Script (3D стенд таблицы лидеров)

StarterPlayer
└── StarterPlayerScripts
    ├── DataClient                  ← LocalScript (модуль доступа к данным для UI)
    └── PromoCodeGui                ← LocalScript (готовое меню активации промокодов)
```

**Обязательное условие:**  
В Roblox Studio перейди в: **Game Settings → Security → Allow HTTP Requests → ВКЛЮЧИТЬ**.

---

## Важные особенности и безопасность

### 1. Таблица игроков (leaderstats)
В Roblox Studio список игроков в верхнем правом углу (Tab-меню) отображается **только** если папка называется `leaderstats` (строчными буквами). Модуль `DataManager` автоматически создаёт и обновляет именно правильную папку `leaderstats`.

### 2. Строгий Античит
Клиенты **НЕ могут** произвольно изменять валюту или инвентарь через RemoteFunction.  
По умолчанию таблица `ClientWritableKeys = {}` пуста. Любые попытки читера вызвать `remote:InvokeServer("Add", { key = "coins", delta = 1000000 })` отклоняются сервером с ошибкой.

Начисление валюты осуществляется **только на сервере**:
```lua
local DataManager = require(game.ServerScriptService.Modules.DataManager)

-- Выдать монеты игроку:
DataManager.GiveCoins(player, 50)

-- Списать монеты при покупке (с проверкой баланса):
local success, err = DataManager.TakeCoins(player, 100)
if success then
    print("Покупка совершена!")
else
    print("Ошибка:", err)
end
```

### 3. Защита от дюпа (Session Locking)
Если в `ProfileSync` включён параметр:
```lua
UseSessionLock = true
```
Сервер при входе игрока захватывает уникальную сессию с `JobId`. Если игрок попытается одновременно зайти на второй сервер (популярный способ дюпа инвентаря в Roblox), второй сервер не пустит его до завершения сохранения на первом.

### 4. Авто-кик заблокированных игроков
Если игрок заблокирован в MariaDB (`POST /player/ban`), при входе в игру он моментально получает кик с причиной блокировки:
```
"Ваш аккаунт заблокирован! Причина: ..."
```

---

## Быстрые примеры для других скриптов игры

```lua
local DataManager = require(game.ServerScriptService.Modules.DataManager)

-- Чтение баланса
local coins = DataManager.GetStat(player, "coins")
local gems = DataManager.GetStat(player, "gems")
local level = DataManager.GetStat(player, "level")

-- Инвентарь
DataManager.AddItem(player, "sword", 1)       -- выдать меч
local items = DataManager.GetItems(player)    -- получить все предметы

-- Промокоды
local ok, rewards = DataManager.RedeemCode(player, "PROMO2026")

-- Принудительное сохранение
DataManager.SaveNow(player)
```