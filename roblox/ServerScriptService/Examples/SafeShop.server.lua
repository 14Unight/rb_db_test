--[[
	SafeShop (Script → ServerScriptService/Examples/SafeShop)
	Пример безопасного внутриигрового магазина.

	Логика покупки выполняется СТРОГО НА СЕРВЕРЕ, поэтому читер не может
	подделать цену или выдать себе предмет бесплатно.
]]

local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local DataManager = require(ServerScriptService.Modules:WaitForChild("DataManager"))

-- Каталог товаров: [идентификатор] = { имя, цена_в_монетах, цена_в_кристаллах }
local SHOP_ITEMS = {
	wooden_sword = { name = "Деревянный меч",  coins = 50,  gems = 0 },
	iron_sword   = { name = "Железный меч",    coins = 200, gems = 0 },
	magic_staff  = { name = "Магический посох", coins = 0,   gems = 10 },
	health_potion = { name = "Зелье здоровья", coins = 25,  gems = 0 },
}

-- Создаем RemoteFunction для связи с клиентским интерфейсом магазина
local shopRemote = ReplicatedStorage:FindFirstChild("ShopAPI")
if not shopRemote then
	shopRemote = Instance.new("RemoteFunction")
	shopRemote.Name = "ShopAPI"
	shopRemote.Parent = ReplicatedStorage
end

shopRemote.OnServerInvoke = function(player, action, payload)
	if action == "GetCatalog" then
		return { ok = true, items = SHOP_ITEMS }
	end

	if action == "Buy" then
		local itemKey = tostring(payload and payload.itemKey or "")
		local item = SHOP_ITEMS[itemKey]
		if not item then
			return { ok = false, error = "Товар не найден в каталоге" }
		end

		-- Оплата монетами
		if item.coins > 0 then
			local success, balanceOrErr = DataManager.TakeCoins(player, item.coins)
			if not success then
				return { ok = false, error = balanceOrErr or "Недостаточно монет" }
			end
		end

		-- Оплата кристаллами (если товар за кристаллы)
		if item.gems > 0 then
			local success, balanceOrErr = DataManager.TakeGems(player, item.gems)
			if not success then
				return { ok = false, error = balanceOrErr or "Недостаточно кристаллов" }
			end
		end

		-- Выдаем купленный предмет в инвентарь игрока
		DataManager.AddItem(player, itemKey, 1)

		print(string.format("[Shop] Игрок %s успешно купил %s (%s)", player.Name, item.name, itemKey))
		return { ok = true, message = "Предмет '" .. item.name .. "' успешно куплен!" }
	end

	return { ok = false, error = "Неизвестное действие" }
end

print("[Shop] Безопасный серверный магазин запущен и готов к работе")
