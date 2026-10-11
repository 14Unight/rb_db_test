# Готовые рецепты

Каждый рецепт — кусок серверного скрипта, который работает сразу.
Общий `require` для всех примеров:

```lua
local ServerScriptService = game:GetService("ServerScriptService")
local DataManager = require(ServerScriptService.Modules.DataManager)
```

И настройка `CONFIG` в `ProfileSync`:

```lua
Leaderstats = { Coins = "coins", Gems = "gems" }
SyncKeys    = { "level", "xp" }
```

---

## 1. Две валюты (Монеты и Кристаллы)

Монеты (`coins`) и кристаллы (`gems`) вынесены в отдельные индексированные колонки базы данных MariaDB, поэтому запросы к ним максимально быстрые.

```lua
-- Начислить монеты или кристаллы
DataManager.GiveCoins(player, 100)
DataManager.GiveGems(player, 10)

-- Потратить с безопасной проверкой баланса
local ok, newBalanceOrErr = DataManager.TakeCoins(player, 150)
if not ok then
    print("Недостаточно монет!")
else
    print("Успешно списано! Новый баланс:", newBalanceOrErr)
end
```

---

## 2. Уровни и опыт

Порог растёт по формуле. Опыт копится, уровень пересчитывается из него —
тогда пересчёт ничего не ломает.

```lua
local Data = {}   -- ModuleScript

local function xpForLevel(level)
    return 100 * level * level        -- 1 lvl → 100, 2 → 400, 3 → 900
end

function Data.AddXp(player, amount)
    local xp   = DataManager.GetStat(player, "xp") or 0
    local lvl  = DataManager.GetStat(player, "level") or 1
    local newXp = xp + amount

    while newXp >= xpForLevel(lvl) do
        newXp = newXp - xpForLevel(lvl)
        lvl = lvl + 1
    end

    DataManager.Set(player, "xp", newXp)
    DataManager.Set(player, "level", lvl)
    return lvl
end

function Data.GetLevel(player)
    return DataManager.GetStat(player, "level") or 1
end

return Data
```

Вызов: `Data.AddXp(player, 50)`

Полезно: `xpForLevel` держи в серверных скриптах, а в базе храни только `xp`
и `level`. Потом сможешь пересчитать всех игроков одной функцией.

---

## 3. Магазин

Покупка = списание валюты **и** выдача предмета одной пачкой. Если что-то
сломается посередине, не спишется ни копейки.

```lua
local ServerScriptService = game:GetService("ServerScriptService")
local DataManager = require(ServerScriptService.Modules.DataManager)
local DataStore   = require(ServerScriptService.Modules.DataStore)   -- нужен для Batch

local Shop = {}

local PRICES = {
    sword  = 150,
    shield = 300,
    potion = 25,
}

function Shop.Buy(player, itemKey)
    local price = PRICES[itemKey]
    if not price then
        return false, "нет такого товара"
    end

    local balance = DataManager.GetStat(player, "coins") or 0
    if balance < price then
        return false, "не хватает монет"
    end

    -- Покупка одной пачкой: деньги и предмет либо оба, либо ничего.
    local result, err = DataStore.new(player.UserId):Batch({
        { op = "add",      key = "coins",  delta = -price },
        { op = "itemsAdd", itemKey = itemKey, amount = 1 },
        { op = "log",      action = "shop_buy",
          payload = { item = itemKey, price = price } },
    })

    if not result then
        return false, err or "покупка не удалась"
    end

    -- обновляем локальный кэш, чтобы Leaderstats не ждал автосейва
    DataManager.Set(player, "coins", result.player.coins)
    DataManager.AddItem(player, itemKey, 1)
    return true
end

return Shop
```

Проверку баланса (`balance < price`) **обязательно** оставь снаружи: она
честно отказывает игроку. `add-stat` с огромным отрицательным числом просто
обнулит баланс вместо отказа.

Если цена всегда в одной валюте и батч не нужен:

```lua
local before = DataManager.GetStat(player, "coins") or 0
if before < price then return false, "не хватает монет" end
DataManager.Add(player, "coins", -price)
DataManager.AddItem(player, itemKey, 1)
return true
```

---

## 4. Инвентарь с надетостью

```lua
local Inventory = {}

function Inventory.Give(player, itemKey, amount)
    return DataManager.AddItem(player, itemKey, amount or 1)
end

function Inventory.Take(player, itemKey, amount)
    return DataManager.AddItem(player, itemKey, -(amount or 1))
end

--- Надеть: itemKey переносится в data.equipped, а в инвентаре его не остаётся.
function Inventory.Equip(player, itemKey)
    local items = DataManager.GetItems(player)
    local owned = false
    for _, item in ipairs(items or {}) do
        if item.itemKey == itemKey and item.amount > 0 then
            owned = true
            break
        end
    end
    if not owned then
        return false, "предмета нет"
    end

    DataManager.AddItem(player, itemKey, -1)
    DataManager.Set(player, "equipped." .. itemKey, true)
    return true
end

function Inventory.Unequip(player, itemKey)
    DataManager.Set(player, "equipped." .. itemKey, null)
    DataManager.AddItem(player, itemKey, 1)
    return true
end

function Inventory.IsEquipped(player, itemKey)
    return DataManager.GetStat(player, "equipped." .. itemKey) == true
end

return Inventory
```

`"equipped." .. itemKey` — вложенный ключ, он becomes `data.equipped.sword`.
Надетое состояние в базе читается одним запросом и не занимает строки в инвентаре.

---

## 5. Питомцы

Вложенные ключи — естественный способ хранить сложные сущности.

```lua
local Pets = {}

function Pets.Adopt(player, petId, name)
    DataManager.Set(player, "pets." .. petId .. ".name", name or petId)
    DataManager.Set(player, "pets." .. petId .. ".level", 1)
    DataManager.Set(player, "pets." .. petId .. ".xp", 0)
    DataManager.Set(player, "pets." .. petId .. ".adoptedAt", os.time())
end

function Pets.LevelUp(player, petId)
    local xp = DataManager.GetStat(player, "pets." .. petId .. ".xp") or 0
    local lvl = DataManager.GetStat(player, "pets." .. petId .. ".level") or 1
    xp = xp + 50
    if xp >= 100 * lvl then
        xp = xp - 100 * lvl
        lvl = lvl + 1
    end
    DataManager.Set(player, "pets." .. petId .. ".xp", xp)
    DataManager.Set(player, "pets." .. petId .. ".level", lvl)
    return lvl
end

function Pets.List(player)
    return DataManager.GetStat(player, "pets")   -- { dragon = { level = 3, ... } }
end

function Pets.Sell(player, petId, price)
    DataManager.Set(player, "pets." .. petId, null)   -- удаляет ветку целиком
    return DataManager.Add(player, "coins", price)
end

return Pets
```

Что получится в базе:

```json
{
  "pets": {
    "dragon": { "name": "Draco", "level": 3, "xp": 40, "adoptedAt": 1767345 }
  }
}
```

Топ питомцев по уровню:

```lua
local top = DataManager.Leaderboard("pets.dragon.level", 10)
```

---

## 6. Квесты

```lua
local Quests = {}

local QUESTS = {
    kill10    = { text = "Убей 10 мобов",   target = 10,  reward = 100 },
    bossSlime = { text = "Победи босса",     target = 1,   reward = 500 },
}

function Quests.Progress(player, questId, amount)
    local def = QUESTS[questId]
    if not def then return end

    local done = DataManager.GetStat(player, "quests." .. questId .. ".done")
    if done then return end                     -- наградный не выдаём дважды

    local value = (DataManager.GetStat(player, "quests." .. questId .. ".value") or 0) + (amount or 1)
    value = math.min(value, def.target)

    DataManager.Set(player, "quests." .. questId .. ".value", value)

    if value >= def.target then
        DataManager.Set(player, "quests." .. questId .. ".done", true)
        DataManager.Set(player, "quests." .. questId .. ".doneAt", os.time())
        DataManager.Add(player, "coins", def.reward)
        DataManager.Log(player, "quest_done", { quest = questId, reward = def.reward })
        return true, def.reward
    end
end

return Quests
```

---

## 7. Таблица игроков в UI

```lua
-- LocalScript
local Data = require(script.Parent.DataClient)

local top = Data:Leaderboard("coins", 25)
for i, row in ipairs(top) do
    print(("%d. %s — %s"):format(row.position, row.username, tostring(row.value)))
end
```

Затем построить `ScrollingFrame` с `UIListLayout` — строки создавай циклом
по `top`. `row.position`, `row.username`, `row.value` уже пришли с сервера.

Топ по уровню: `Data:Leaderboard("level", 25)`.
Своя страница: `Data:Leaderboard("coins", 25, 25)` — вторая двадцатка.

Для UI без HTTP-запроса вообще — `SyncKeys`:

```lua
-- LocalScript, ни одного запроса:
player:GetAttribute("level")   -- обновляется сервером сам
```

---

## 8. Ежедневная награда

```lua
local Daily = {}
local COOLDOWN = 86400        -- секунд между наградами

function Daily.CanClaim(player)
    local last = DataManager.GetStat(player, "daily.lastClaimAt") or 0
    return os.time() - last >= COOLDOWN
end

function Daily.Claim(player)
    if not Daily.CanClaim(player) then
        return false, "уже получено"
    end

    local streak = (DataManager.GetStat(player, "daily.streak") or 0) + 1
    local reward = 50 + streak * 10

    DataManager.Set(player, "daily.streak", streak)
    DataManager.Set(player, "daily.lastClaimAt", os.time())
    local coins = DataManager.Add(player, "coins", reward)

    return true, coins, streak
end

return Daily
```

Не сверяй время с сервером Roblox вслепую — `os.time()` в игре можно крутить
в консоли. Для серьёзного проекта проверяй дату ещё и в мосте (своя колонка
с `updated_at`).

---

## 9. Промокоды

```lua
local Codes = {}

local TABLE = {
    STARTGIFT = { coins = 1000, once = true },
    DISCORD   = { coins = 250,  gems = 5 },
}

function Codes.Redeem(player, code)
    local def = TABLE[string.upper(code or "")]
    if not def then
        return false, "код не найден"
    end

    local listKey = "usedCodes"
    local used = DataManager.GetStat(player, listKey) or {}
    for _, usedCode in ipairs(used) do
        if usedCode == string.upper(code) then
            return false, "код уже использован"
        end
    end

    table.insert(used, string.upper(code))
    DataManager.Set(player, listKey, used)

    if def.coins then DataManager.Add(player, "coins", def.coins) end
    if def.gems then DataManager.Add(player, "gems", def.gems) end
    DataManager.Log(player, "code_redeemed", { code = code, reward = def })

    return true
end

return Codes
```

В `data` попадёт массив: `"usedCodes": ["STARTGIFT"]`.

---

## 10. Античит: валюту начисляет только сервер

```lua
-- ProfileSync
ClientReadOnlyKeys = { coins = true, gems = true },
```

```lua
-- серверный скрипт
local price = Shop.PRICES[itemKey]
DataManager.Add(player, "coins", -price)
DataManager.AddItem(player, itemKey, 1)
```

Клиентский `Data:Add("coins", 1_000_000)` вернёт
`{ ok = false, error = "поле защищено от записи с клиента" }`.
Клиент всё ещё может звать `Items`, `Leaderboard`, `Get` — это чтение.

Для полного контроля добавь проверки на сервере:

```lua
-- сумма покупки не может превышать сумму, которую начисляли серверу
if price <= 0 or price % 25 ~= 0 then
    return nil, "подозрительная цена"
end
```

И включай журнал:

```env
LOG_ENABLED=true
```

Теперь каждое изменение видно:

```sql
SELECT created_at, action, payload FROM roblox_db.player_log
WHERE userId = 123 ORDER BY id DESC LIMIT 20;
```

---

## 11. Сезоны и сброс прогресса

Обнулить поле у всех игроков — `batch` в цикле по списку, или быстрее, SQL-ом:

```sql
-- в MariaDB напрямую: обнулить валюту у всех
UPDATE roblox_db.player_stats SET coins = 0;

-- обнулить произвольное поле у всех
UPDATE roblox_db.player_stats
SET data = JSON_REMOVE(data, '$.level');

-- сбросить сезонный прогресс, оставив permanent-поля
UPDATE roblox_db.player_stats
SET data = JSON_REMOVE(data, '$.season.points', '$.season.level');
```

Или точечно, без прямого SQL — серверный скрипт:

```lua
for _, row in ipairs(DataManager.Leaderboard("coins", 100)) do
    local target = Players:GetPlayerByUserId(row.userId)
    if target then
        DataManager.Set(target, "coins", 0)
    end
end
```

Так работает только для игроков **сейчас онлайн**. Для офлайна — SQL.

---

## 12. Ручные правки и админка

```powershell
# выдать монеты игроку
curl.exe -X POST http://localhost:3000/add-stat -H "Content-Type: application/json" `
  -d '{\"userId\":123,\"key\":\"coins\",\"delta\":10000}'

# выдать предмет
curl.exe -X POST http://localhost:3000/items/add -H "Content-Type: application/json" `
  -d '{\"userId\":123,\"itemKey\":\"legendary_sword\",\"amount\":1}'

# поставить уровень
curl.exe -X POST http://localhost:3000/set-stat -H "Content-Type: application/json" `
  -d '{\"userId\":123,\"key\":\"level\",\"value\":50}'

# найти игрока по нику
curl.exe "http://localhost:3000/players?search=Player1"

# посмотреть сырые данные
curl.exe "http://localhost:3000/player?userId=123"

# удалить игрока
curl.exe -X POST http://localhost:3000/player/delete -H "Content-Type: application/json" `
  -d '{\"userId\":123}'
```

Правка через API сразу видна игроку — `DataManager.Reload(player)` перечитает
профиль, если он онлайн.

---

## 13. Обучение (tutorial)

Флаги «что игрок уже сделал» — обычные булевы ключи:

```lua
-- при первом входе
DataManager.Set(player, "tutorial.moved", true)
DataManager.Set(player, "tutorial.jumped", true)
DataManager.Set(player, "tutorial.shopOpened", true)

-- проверка
if not DataManager.GetStat(player, "tutorial.jumped") then
    showHint(player, "Прыгни пробелом")
end

-- сбросить обучение
DataManager.Set(player, "tutorial", null)
```

---

## 14. Таблица «что где лежит»

| Что | Ключ | Где физически |
|---|---|---|
| Монеты | `coins` | колонка `player_stats.coins` |
| Геммы, уровень, опыт | `gems`, `level`, `xp` | JSON `player_stats.data` |
| Вложенное | `pets.dragon.level` | `data.pets.dragon.level` |
| Надетое | `equipped.sword` | `data.equipped.sword` |
| Флаги обучения | `tutorial.jumped` | `data.tutorial.jumped` |
| Использованные коды | `usedCodes` | массив в `data` |
| Предметы | `itemKey` | таблица `player_items` |
| Метаданные предмета | `meta` | `player_items.meta` |
| История действий | `action` | таблица `player_log` |

Правило: **валюты — в `data`**, если их немного. **Таблицы — в `player_items`**,
если предметов много и у них есть количество. Всё, что связано с «прошёл ли
игрок это» — флаги в `data`.