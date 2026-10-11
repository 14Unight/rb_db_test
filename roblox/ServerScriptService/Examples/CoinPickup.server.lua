--[[
	CoinPickup (Script → ServerScriptService/Examples/CoinPickup)
	Пример скрипта для подбираемых монет в мире (Workspace).

	Как использовать:
	 1. Создай Part в Workspace, назови его "Coin" (или помести в папку "Coins").
	 2. Скрипт автоматически находит все монеты и при касании начисляет баланс в MariaDB.
]]

local ServerScriptService = game:GetService("ServerScriptService")
local Players = game:GetService("Players")

local DataManager = require(ServerScriptService.Modules:WaitForChild("DataManager"))

local COIN_REWARD = 10     -- Сколько монет давать за подбор
local RESPAWN_TIME = 5    -- Через сколько секунд монетка снова появится

local function setupCoinPart(part)
	if not part:IsA("BasePart") then return end

	local isCollected = false

	part.Touched:Connect(function(hit)
		if isCollected then return end

		local character = hit.Parent
		local player = Players:GetPlayerFromCharacter(character)
		if not player then return end

		isCollected = true

		-- Прячем монетку
		part.Transparency = 1
		part.CanCollide = false

		-- Начисляем монеты на сервере
		local newBalance = DataManager.GiveCoins(player, COIN_REWARD)
		print(string.format("[CoinPickup] %s подобрал монету (+%d). Новый баланс: %s", player.Name, COIN_REWARD, tostring(newBalance)))

		-- Звуковой эффект (если в Part есть Sound)
		local sound = part:FindFirstChildOfClass("Sound")
		if sound then
			sound:Play()
		end

		-- Возрождение монетки
		task.delay(RESPAWN_TIME, function()
			part.Transparency = 0
			part.CanCollide = false
			isCollected = false
		end)
	end)
end

-- Подключаем к существующим и вновь создаваемым монеткам в Workspace
local function scanCoins()
	for _, obj in ipairs(workspace:GetDescendants()) do
		if obj:IsA("BasePart") and obj.Name == "Coin" then
			setupCoinPart(obj)
		end
	end
end

scanCoins()
workspace.DescendantAdded:Connect(function(descendant)
	if descendant:IsA("BasePart") and descendant.Name == "Coin" then
		setupCoinPart(descendant)
	end
end)

print("[CoinPickup] Система подбираемых монет инициализирована")
