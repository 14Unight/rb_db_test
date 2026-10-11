--[[
	DataClient (LocalScript → StarterPlayer/StarterPlayerScripts/DataClient)
	Версия 3.0.0

	Клиентский помощник для интерфейса (UI) и локальных скриптов.
	Взаимодействует с сервером через RemoteFunction "DataAPI".

	Примеры использования в UI:
		local Data = require(script.Parent.DataClient)

		-- Мгновенно без задержки и без сети:
		local coins = Data:LocalStat("Coins")
		local level = Data:LocalAttribute("level")

		-- Запросы к серверу:
		local profile = Data:GetProfile()
		local items = Data:Items()
		local top = Data:Leaderboard("coins", 10)

		-- Активация промокода:
		local ok, rewards = Data:RedeemCode("PROMO2026")
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local DataClient = {}

local remote = ReplicatedStorage:WaitForChild("DataAPI", 10)

--- Универсальный вызов сервера с защитой от сбоев. Возвращает (результат, ошибка).
function DataClient:Request(action, payload)
	if not remote then
		return nil, "DataAPI RemoteFunction не найден в ReplicatedStorage"
	end
	local ok, result = pcall(function()
		return remote:InvokeServer(action, payload or {})
	end)
	if not ok then
		warn("[DataClient] сетевой запрос не удался:", result)
		return nil, tostring(result)
	end
	if type(result) ~= "table" then
		return nil, "Сервер вернул неожиданный ответ"
	end
	return result, nil
end

--- Получить весь профиль текущего игрока
function DataClient:GetProfile()
	local result, err = self:Request("Get")
	if not result then return nil, err end
	return result
end

--- Получить значение одного поля
function DataClient:Get(key)
	local result, err = self:Request("GetStat", { key = key })
	if not result then return nil, err end
	return result.value
end

--- Получить инвентарь игрока
function DataClient:Items()
	local result, err = self:Request("Items")
	if not result then return nil, err end
	return result.items
end

--- Получить таблицу лидеров по полю (например: "coins", "gems", "level")
function DataClient:Leaderboard(key, limit)
	local result, err = self:Request("Leaderboard", { key = key or "coins", limit = limit or 25 })
	if not result then return nil, err end
	return result.players
end

--- Активировать промокод (начисление наград)
function DataClient:RedeemCode(code)
	local result, err = self:Request("RedeemCode", { code = code })
	if not result then return false, err end
	if not result.ok then return false, result.error end
	return true, result.rewards
end

--- Попросить сервер сохранить данные немедленно
function DataClient:Save()
	return self:Request("Save")
end

--- МГНОВЕННОЕ чтение значения из таблицы leaderstats без сетевых запросов
function DataClient:LocalStat(name)
	local player = Players.LocalPlayer
	if not player then return 0 end
	local stats = player:FindFirstChild("leaderstats") or player:FindFirstChild("Leaderstats")
	local val = stats and stats:FindFirstChild(name)
	if val and val:IsA("IntValue") then
		return val.Value
	end
	return 0
end

--- МГНОВЕННОЕ чтение атрибута игрока (SyncKeys) без сетевых запросов
function DataClient:LocalAttribute(key)
	local player = Players.LocalPlayer
	return player and player:GetAttribute(key) or nil
end

return DataClient