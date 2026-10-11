--[[
	DataManager (ModuleScript → ServerScriptService/Modules/DataManager)
	Версия 3.0.0

	Центральный менеджер состояния игроков в памяти + синхронизация с MariaDB.
	Особенности:
	 - Защита от эксплоитов: строгая серверная авторизация (клиент не может накрутить валюту)
	 - Автоматический встроенный анти-чит (ClientWritableKeys whitelist)
	 - Авто-кик заблокированных игроков (система банов из MariaDB)
	 - Session Locking: защита от дюпа предметов при быстром перезаходе между серверами
	 - Поддержка стандартного Roblox leaderstats (с маленькой буквы)
	 - Готовые серверные методы: GiveCoins, TakeCoins, GiveGems, TakeGems, RedeemCode
	 - Очередь асинхронных операций для предотвращения race conditions
]]

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local DataStore = require(script.Parent:WaitForChild("DataStore"))

local DataManager = {}

DataManager.Config = {
	-- { Имя IntValue в leaderstats = ключ в базе }
	Leaderstats = {
		Coins = "coins",
		Gems = "gems",
		Level = "level",
	},

	-- Ключи из data{}, которые зеркалятся в player:SetAttribute(...) для мгновенного чтения клиентом
	SyncKeys = { "level", "xp", "gems" },

	-- Автосохранение каждые N секунд (0 — выключить, сохранять только при выходе)
	SaveInterval = 120,

	-- Таймаут загрузки данных при входе (секунды)
	LoadTimeout = 20,

	-- Поведение при недоступности MariaDB: "keepZero" (играть с нулями) или "kick" (выгнать)
	OnLoadFail = "keepZero",

	-- АНТИЧИТ: Белый список ключей, которые клиент МОЖЕТ менять через RemoteFunction.
	-- ПО УМОЛЧАНИЮ ПУСТОЙ! Любые попытки клиента начислить себе монеты будут заблокированы.
	ClientWritableKeys = {},

	-- Защита от дюпа (Session Locking): не пускать игрока, если он уже в сети на другом сервере
	UseSessionLock = false,
}

local state = {}     -- [Player] = профиль
local queues = {}    -- [Player] = очередь операций
local remote = nil   -- RemoteFunction "DataAPI"
local started = false

-- ==================================================================
--  Внутренние утилиты
-- ==================================================================

local function merge(target, source)
	for key, value in pairs(source or {}) do
		target[key] = value
	end
	return target
end

local function log(...)
	print("[DataManager]", ...)
end

local function snapshot(value)
	local ok, result = pcall(function()
		return HttpService:JSONDecode(HttpService:JSONEncode(value))
	end)
	return ok and result or {}
end

local function readField(data, key)
	local current = data
	for part in tostring(key):gmatch("[^%.]+") do
		if type(current) ~= "table" then
			return nil
		end
		current = current[part]
	end
	return current
end

local function writeField(data, key, value)
	local parts = {}
	for part in tostring(key):gmatch("[^%.]+") do
		table.insert(parts, part)
	end
	if #parts == 0 then return end
	local current = data
	for i = 1, #parts - 1 do
		if type(current[parts[i]]) ~= "table" then
			current[parts[i]] = {}
		end
		current = current[parts[i]]
	end
	current[parts[#parts]] = value
end

local function profileValue(profile, key)
	if key == "coins" then return profile.coins end
	if key == "gems" then return profile.gems end
	if key == "level" then return profile.level end
	if key == "xp" then return profile.xp end
	return readField(profile.data, key)
end

local function profileSetValue(profile, key, value)
	if key == "coins" then
		profile.coins = math.max(0, math.floor(tonumber(value) or 0))
	elseif key == "gems" then
		profile.gems = math.max(0, math.floor(tonumber(value) or 0))
	elseif key == "level" then
		profile.level = math.max(1, math.floor(tonumber(value) or 1))
	elseif key == "xp" then
		profile.xp = math.max(0, math.floor(tonumber(value) or 0))
	else
		writeField(profile.data, key, value)
	end
end

-- ------------------------------------------------------------------
--  Очередь операций (защита от состояний гонки / race conditions)
-- ------------------------------------------------------------------

local function enqueue(player, fn)
	local q = queues[player]
	if q == nil then
		q = { running = false, jobs = {} }
		queues[player] = q
	end

	if q.running then
		table.insert(q.jobs, fn)
		return nil, "профиль занят, операция выполняется в очереди"
	end

	q.running = true
	table.insert(q.jobs, fn)

	local lastValue, lastExtra
	local ok, err = pcall(function()
		while #q.jobs > 0 do
			local job = table.remove(q.jobs, 1)
			local jobOk, a, b = pcall(job)
			if jobOk then
				lastValue, lastExtra = a, b
			else
				warn("[DataManager] Ошибка в операции очереди:", a)
			end
		end
	end)
	q.running = false

	if not ok then
		return nil, tostring(err)
	end
	return lastValue, lastExtra
end

-- ==================================================================
--  Leaderstats и Атрибуты
-- ==================================================================

local function getLeaderstatsFolder(player)
	-- Roblox ищет именно "leaderstats" с маленькой буквы
	local folder = player:FindFirstChild("leaderstats") or player:FindFirstChild("Leaderstats")
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = "leaderstats"
		folder.Parent = player
	end
	return folder
end

local function buildLeaderstats(player)
	local folder = getLeaderstatsFolder(player)
	for displayName in pairs(DataManager.Config.Leaderstats) do
		local val = folder:FindFirstChild(displayName)
		if not val then
			val = Instance.new("IntValue")
			val.Name = displayName
			val.Value = 0
			val.Parent = folder
		end
	end
	return folder
end

local function refreshLeaderstats(player, profile)
	local folder = getLeaderstatsFolder(player)
	if not folder then return end
	for displayName, key in pairs(DataManager.Config.Leaderstats) do
		local val = folder:FindFirstChild(displayName)
		if val and val:IsA("IntValue") then
			val.Value = math.floor(tonumber(profileValue(profile, key)) or 0)
		end
	end
end

local function refreshAttributes(player, profile)
	for _, key in ipairs(DataManager.Config.SyncKeys) do
		local val = profileValue(profile, key)
		player:SetAttribute(key, val)
	end
end

local function refreshAll(player, profile)
	refreshLeaderstats(player, profile)
	refreshAttributes(player, profile)
end

local function applyProfile(player, profile)
	state[player] = {
		userId = player.UserId,
		username = (profile.username ~= "" and profile.username) or player.Name,
		coins = tonumber(profile.coins) or 0,
		gems = tonumber(profile.gems) or 0,
		level = tonumber(profile.level) or 1,
		xp = tonumber(profile.xp) or 0,
		data = type(profile.data) == "table" and profile.data or {},
		items = type(profile.items) == "table" and profile.items or {},
		save_version = tonumber(profile.save_version) or 1,
		is_banned = Boolean and profile.is_banned or false,
		loaded = true,
		joinTime = os.clock(),
	}
	refreshAll(player, state[player])
	return state[player]
end

-- ==================================================================
--  Публичное Серверное API
-- ==================================================================

function DataManager.Setup(config)
	merge(DataManager.Config, config)
end

function DataManager.IsLoaded(player)
	return state[player] ~= nil and state[player].loaded == true
end

--- Возвращает копию текущего профиля игрока из памяти
function DataManager.Get(player)
	local current = state[player]
	return current and snapshot(current) or nil
end

--- Получить конкретное поле
function DataManager.GetStat(player, key)
	local current = state[player]
	if not current then return nil end
	return profileValue(current, key)
end

--- Атомарно прибавить к полю (баланс в MariaDB не упадёт ниже нуля)
function DataManager.Add(player, key, delta)
	if not DataManager.IsLoaded(player) then
		return nil, "Профиль игрока ещё не загружен"
	end
	local store = DataStore.new(player.UserId)
	return enqueue(player, function()
		local response, err = store:Add(key, delta)
		if not response then return nil, err end
		local current = state[player]
		if current then
			profileSetValue(current, key, response.value)
			refreshAll(player, current)
		end
		return response.value
	end)
end

--- Записать конкретное значение поля
function DataManager.Set(player, key, value)
	if not DataManager.IsLoaded(player) then
		return nil, "Профиль игрока ещё не загружен"
	end
	local store = DataStore.new(player.UserId)
	return enqueue(player, function()
		local response, err = store:Set(key, value)
		if not response then return nil, err end
		local current = state[player]
		if current then
			profileSetValue(current, key, response.value)
			refreshAll(player, current)
		end
		return response.value
	end)
end

--- Выдать монеты игроку (атомарно)
function DataManager.GiveCoins(player, amount)
	return DataManager.Add(player, "coins", math.max(0, math.floor(amount or 0)))
end

--- Списать монеты с проверкой баланса. Возвращает (успех, новый_баланс_или_ошибка)
function DataManager.TakeCoins(player, amount)
	local cost = math.max(0, math.floor(amount or 0))
	local currentCoins = DataManager.GetStat(player, "coins") or 0
	if currentCoins < cost then
		return false, "Недостаточно монет"
	end
	local newBalance, err = DataManager.Add(player, "coins", -cost)
	if newBalance == nil then
		return false, err or "Сбой списания"
	end
	return true, newBalance
end

--- Выдать кристаллы (Gems)
function DataManager.GiveGems(player, amount)
	return DataManager.Add(player, "gems", math.max(0, math.floor(amount or 0)))
end

--- Списать кристаллы с проверкой баланса
function DataManager.TakeGems(player, amount)
	local cost = math.max(0, math.floor(amount or 0))
	local currentGems = DataManager.GetStat(player, "gems") or 0
	if currentGems < cost then
		return false, "Недостаточно кристаллов"
	end
	local newBalance, err = DataManager.Add(player, "gems", -cost)
	if newBalance == nil then
		return false, err or "Сбой списания"
	end
	return true, newBalance
end

--- Добавить/убавить предмет из инвентаря
function DataManager.AddItem(player, itemKey, amount)
	local store = DataStore.new(player.UserId)
	return enqueue(player, function()
		local response, err = store:AddItem(itemKey, amount)
		if not response then return nil, err end
		local current = state[player]
		if current then
			local found = false
			for _, item in ipairs(current.items) do
				if item.itemKey == itemKey then
					item.amount = response.amount
					found = true
					break
				end
			end
			if not found then
				table.insert(current.items, { itemKey = itemKey, amount = response.amount })
			end
		end
		return response.amount
	end)
end

--- Получить актуальный инвентарь игрока
function DataManager.GetItems(player)
	local current = state[player]
	if current and current.items then
		return current.items
	end
	local store = DataStore.new(player.UserId)
	local response, err = store:Items()
	if response and state[player] then
		state[player].items = response.items or {}
		return response.items
	end
	return nil, err
end

--- Активировать промокод (начисляет награды и обновляет профиль в памяти)
function DataManager.RedeemCode(player, code)
	if not DataManager.IsLoaded(player) then
		return false, "Данные игрока ещё не загружены"
	end
	local store = DataStore.new(player.UserId)
	return enqueue(player, function()
		local response, err = store:RedeemCode(code)
		if not response or not response.ok then
			return false, err or "Не удалось активировать промокод"
		end
		-- Награды применены в MariaDB, перечитываем профиль
		local updatedProfile = store:Get()
		if updatedProfile then
			applyProfile(player, updatedProfile)
		end
		return true, response.rewards
	end)
end

--- Заблокировать игрока в базе и сразу кикнуть из игры
function DataManager.BanPlayer(player, reason)
	reason = reason or "Нарушение правил"
	DataStore.new(player.UserId):Ban(reason)
	player:Kick("Вы были заблокированы администратором: " .. reason)
end

--- Разблокировать игрока по его UserId
function DataManager.UnbanPlayer(userId)
	return DataStore.new(userId):Unban()
end

--- Таблица лидеров по любому полю
function DataManager.Leaderboard(key, limit, offset, order)
	local response, err = DataStore.new(0):Leaderboard(key, limit, offset, order)
	return response and response.players or nil, err
end

--- Принудительное сохранение текущего состояния игрока
function DataManager.SaveNow(player)
	local current = state[player]
	if not current or not current.loaded then
		return nil, "Нечего сохранять (профиль не загружен)"
	end
	local store = DataStore.new(player.UserId)
	local playtime = math.floor(os.clock() - (current.joinTime or os.clock()))
	current.joinTime = os.clock()

	return enqueue(player, function()
		local response, err = store:Save({
			username = player.Name,
			coins = current.coins,
			gems = current.gems,
			level = current.level,
			xp = current.xp,
			data = current.data,
			expectedVersion = current.save_version,
			playtimeDelta = playtime,
		})
		if response and response.player then
			current.save_version = response.player.save_version
		end
		return response, err
	end)
end

-- ==================================================================
--  Загрузка и Сохранение игрока при входе/выходе
-- ==================================================================

local function loadPlayer(player)
	buildLeaderstats(player)

	local store = DataStore.new(player.UserId)

	-- Защита от дюпов: Session Locking
	if DataManager.Config.UseSessionLock then
		local lockRes, lockErr = store:AcquireSession(game.JobId, game.PlaceId)
		if not lockRes or not lockRes.ok then
			warn(string.format("[DataManager] %s: сессия заблокирована на другом сервере (%s)", player.Name, tostring(lockErr)))
			player:Kick("Ваш аккаунт уже находится в игре на другом сервере. Подождите 30 секунд.")
			return
		end
	end

	local deadline = os.clock() + DataManager.Config.LoadTimeout
	local profile, lastError

	while os.clock() < deadline do
		profile, lastError = store:Get()
		if profile then break end
		task.wait(2)
	end

	if not profile then
		warn(string.format("[DataManager] %s: ошибка загрузки профиля (%s)", player.Name, tostring(lastError)))
		if DataManager.Config.OnLoadFail == "kick" then
			player:Kick("Не удалось загрузить ваши данные из базы данных. Попробуйте перезайти позже.")
			return
		end
		-- Играем с нулями в fallback-режиме (защита: loaded = false, чтобы нули не стёрли базу!)
		applyProfile(player, { username = player.Name, coins = 0, gems = 0, level = 1, xp = 0, data = {}, items = {} })
		state[player].loaded = false -- Помечаем, что реальная загрузка НЕ удалась (не перезаписывать в MariaDB)
		return
	end

	-- Проверка бана
	if profile.is_banned then
		local reason = profile.ban_reason or "Нарушение правил сообщества"
		log(string.format("Заблокированный игрок %s (%d) попытался зайти. Кикаем.", player.Name, player.UserId))
		player:Kick("Ваш аккаунт заблокирован! Причина: " .. reason)
		return
	end

	applyProfile(player, profile)
	log(string.format("Игрок %s успешно загружен: Coins=%d, Gems=%d, Level=%d", player.Name, state[player].coins, state[player].gems, state[player].level))
end

local function savePlayer(player)
	local current = state[player]
	if not current or not current.loaded then
		return -- Не сохраняем, если профиль не был успешно загружен
	end
	local store = DataStore.new(player.UserId)
	local playtime = math.floor(os.clock() - (current.joinTime or os.clock()))

	local response, err = store:Save({
		username = player.Name,
		coins = current.coins,
		gems = current.gems,
		level = current.level,
		xp = current.xp,
		data = current.data,
		expectedVersion = current.save_version,
		playtimeDelta = playtime,
	})

	if DataManager.Config.UseSessionLock then
		store:ReleaseSession(game.JobId)
	end

	if response then
		log(string.format("Игрок %s успешно сохранён в MariaDB", player.Name))
	else
		warn(string.format("[DataManager] %s: ошибка сохранения (%s)", player.Name, tostring(err)))
	end
end

-- ==================================================================
--  Безопасная обработка RemoteFunction от клиентов
-- ==================================================================

local function handleRemote(player, action, payload)
	if not player or not player:IsA("Player") then
		return { ok = false, error = "Невалидный клиент" }
	end
	payload = type(payload) == "table" and payload or {}

	if action == "Get" then
		local prof = DataManager.Get(player)
		return prof or { ok = false, error = "Профиль ещё загружается" }

	elseif action == "GetStat" then
		return { ok = true, value = DataManager.GetStat(player, payload.key) }

	elseif action == "Items" then
		local items = DataManager.GetItems(player)
		return { ok = true, items = items or {} }

	elseif action == "Leaderboard" then
		local players, err = DataManager.Leaderboard(payload.key, payload.limit)
		return players and { ok = true, players = players } or { ok = false, error = err }

	elseif action == "RedeemCode" then
		local success, rewardsOrErr = DataManager.RedeemCode(player, payload.code)
		if success then
			return { ok = true, rewards = rewardsOrErr }
		else
			return { ok = false, error = tostring(rewardsOrErr) }
		end

	elseif action == "Save" then
		DataManager.SaveNow(player)
		return { ok = true }

	-- Защищённые действия изменения: РАЗРЕШЕНЫ ТОЛЬКО ДЛЯ КЛЮЧЕЙ ИЗ ClientWritableKeys
	elseif action == "Add" or action == "Set" then
		local key = tostring(payload.key or "")
		if not DataManager.Config.ClientWritableKeys[key] then
			return { ok = false, error = "Изменение этого поля клиентом запрещено античитом" }
		end
		if action == "Add" then
			local val, err = DataManager.Add(player, key, payload.delta)
			return val ~= nil and { ok = true, value = val } or { ok = false, error = err }
		else
			local val, err = DataManager.Set(player, key, payload.value)
			return val ~= nil and { ok = true, value = val } or { ok = false, error = err }
		end
	end

	return { ok = false, error = "Неизвестное или запрещённое действие: " .. tostring(action) }
end

-- ==================================================================
--  Запуск системы
-- ==================================================================

function DataManager.Start()
	if started then return end
	started = true

	local rs = game:GetService("ReplicatedStorage")
	remote = rs:FindFirstChild("DataAPI")
	if not remote then
		remote = Instance.new("RemoteFunction")
		remote.Name = "DataAPI"
		remote.Parent = rs
	end

	-- ВАЖНО: remote.OnServerInvoke передаёт первым аргументом игрока, сделавшего вызов!
	remote.OnServerInvoke = function(player, action, payload)
		local ok, result = pcall(handleRemote, player, action, payload)
		if not ok then
			warn("[DataManager] Сбой вызова RemoteFunction:", result)
			return { ok = false, error = "Внутренняя ошибка сервера" }
		end
		return result
	end

	Players.PlayerAdded:Connect(function(player)
		task.spawn(loadPlayer, player)
	end)

	Players.PlayerRemoving:Connect(function(player)
		savePlayer(player)
		state[player] = nil
		queues[player] = nil
	end)

	for _, player in ipairs(Players:GetPlayers()) do
		task.spawn(loadPlayer, player)
	end

	-- Автосохранение
	if DataManager.Config.SaveInterval and DataManager.Config.SaveInterval > 0 then
		task.spawn(function()
			while task.wait(DataManager.Config.SaveInterval) do
				for _, player in ipairs(Players:GetPlayers()) do
					task.spawn(savePlayer, player)
				end
			end
		end)
	end

	-- Heartbeat для Session Locking
	if DataManager.Config.UseSessionLock then
		task.spawn(function()
			while task.wait(20) do
				for _, player in ipairs(Players:GetPlayers()) do
					if DataManager.IsLoaded(player) then
						DataStore.new(player.UserId):HeartbeatSession(game.JobId)
					end
				end
			end
		end)
	end

	game:BindToClose(function()
		for _, player in ipairs(Players:GetPlayers()) do
			task.spawn(savePlayer, player)
		end
		task.wait(3)
	end)

	log("Запущен · Подключен к API: " .. DataStore.Config.BaseUrl)
end

return DataManager