--[[
	DataStore (ModuleScript → ServerScriptService/Modules/DataStore)
	Версия 3.0.0

	HTTP-слой взаимодействия с REST API MariaDB.
	Особенности:
	 - Автоматические повторы (retries) с экспоненциальной задержкой
	 - Корректное URL-кодирование параметров (HttpService:UrlEncode)
	 - Поддержка API_KEY (заголовок x-api-key)
	 - Новые функции: промокоды, анти-дюп (сессии), система банов, статистика
]]

local HttpService = game:GetService("HttpService")

local DataStore = {}

DataStore.Config = {
	BaseUrl = "http://localhost:3000",
	ApiKey = nil,          -- строка ключа или nil (если в .env не задан API_KEY)
	Attempts = 3,          -- количество попыток при сетевых сбоях
	RetryDelay = 1.5,      -- базовая пауза между попытками (секунды)
}

-- ------------------------------------------------------------------
--  Внутренние утилиты
-- ------------------------------------------------------------------

local function merge(target, source)
	for key, value in pairs(source or {}) do
		target[key] = value
	end
	return target
end

local function urlEncode(val)
	return HttpService:UrlEncode(tostring(val or ""))
end

local function buildHeaders()
	local headers = { ["Content-Type"] = "application/json" }
	if DataStore.Config.ApiKey and DataStore.Config.ApiKey ~= "" then
		headers["x-api-key"] = DataStore.Config.ApiKey
	end
	return headers
end

local function decode(body)
	local okJson, result = pcall(function()
		return HttpService:JSONDecode(body)
	end)
	if okJson and type(result) == "table" then
		return result
	end
	return nil
end

--- Выполняет HTTP-запрос с защитой от сбоев и повторными попытками.
local function request(method, path, body)
	local options = {
		Url = DataStore.Config.BaseUrl .. path,
		Method = method,
		Headers = buildHeaders(),
	}
	if body ~= nil then
		options.Body = HttpService:JSONEncode(body)
	end

	local lastError
	for attempt = 1, DataStore.Config.Attempts do
		local transportOk, response = pcall(function()
			return HttpService:RequestAsync(options)
		end)

		if transportOk and type(response) == "table" then
			if response.Success and response.StatusCode >= 200 and response.StatusCode < 300 then
				local decoded = decode(response.Body or "")
				if decoded and decoded.ok then
					return decoded, nil
				end
				lastError = (decoded and decoded.error) or ("Сервер вернул ошибку: " .. tostring(response.Body))
			else
				local decoded = decode(response.Body or "")
				lastError = (decoded and decoded.error) or string.format("HTTP %s: %s", tostring(response.StatusCode), tostring(response.Body))
			end
		else
			lastError = "Сеть недоступна или выключен Allow HTTP Requests: " .. tostring(response)
		end

		if attempt < DataStore.Config.Attempts then
			task.wait(DataStore.Config.RetryDelay * attempt)
		end
	end

	return nil, lastError
end

-- ------------------------------------------------------------------
--  Конструктор и Публичные методы
-- ------------------------------------------------------------------

function DataStore.setup(config)
	merge(DataStore.Config, config)
	return DataStore.Config
end

function DataStore.new(userId)
	local self = setmetatable({}, { __index = DataStore })
	self.userId = tonumber(userId) or 0
	return self
end

--- Полный профиль игрока (GET /player)
function DataStore:Get()
	return request("GET", "/player?userId=" .. self.userId)
end

--- Получить одно поле по ключу (GET /stat)
function DataStore:GetStat(key)
	local path = string.format("/stat?userId=%d&key=%s", self.userId, urlEncode(key))
	return request("GET", path)
end

--- Сохранить профиль игрока (POST /player)
function DataStore:Save(payload)
	local body = { userId = self.userId }
	for key, value in pairs(payload or {}) do
		body[key] = value
	end
	return request("POST", "/player", body)
end

--- Записать одно поле (POST /set-stat)
function DataStore:Set(key, value)
	return request("POST", "/set-stat", { userId = self.userId, key = key, value = value })
end

--- Атомарно прибавить число к полю (POST /add-stat)
function DataStore:Add(key, delta)
	return request("POST", "/add-stat", { userId = self.userId, key = key, delta = delta })
end

--- Глубокое слияние JSON-полей в data{} (POST /set)
function DataStore:SetMany(data)
	return request("POST", "/set", { userId = self.userId, data = data })
end

--- Пачка атомарных операций в одной транзакции (POST /batch)
function DataStore:Batch(ops)
	return request("POST", "/batch", { userId = self.userId, ops = ops })
end

--- Получить инвентарь игрока (GET /items)
function DataStore:Items()
	return request("GET", "/items?userId=" .. self.userId)
end

--- Изменить количество предмета в инвентаре (POST /items/add)
function DataStore:AddItem(itemKey, amount)
	return request("POST", "/items/add", {
		userId = self.userId,
		itemKey = itemKey,
		amount = amount,
	})
end

--- Задать точное количество предмета с метаданными (POST /items/set)
function DataStore:SetItem(itemKey, amount, meta)
	local body = { userId = self.userId, itemKey = itemKey, amount = amount }
	if meta ~= nil then
		body.meta = meta
	end
	return request("POST", "/items/set", body)
end

--- Таблица лидеров (GET /leaderboard)
function DataStore:Leaderboard(key, limit, offset, order)
	local path = string.format(
		"/leaderboard?key=%s&limit=%d&offset=%d&order=%s",
		urlEncode(key or "coins"),
		limit or 25,
		offset or 0,
		order or "desc"
	)
	return request("GET", path)
end

--- Поиск игроков по нику (GET /players)
function DataStore:FindPlayers(search, limit)
	local path = string.format("/players?search=%s&limit=%d", urlEncode(search), limit or 25)
	return request("GET", path)
end

--- Проверка статуса блокировки (GET /player/ban)
function DataStore:GetBanStatus()
	return request("GET", "/player/ban?userId=" .. self.userId)
end

--- Блокировка игрока (POST /player/ban)
function DataStore:Ban(reason)
	return request("POST", "/player/ban", { userId = self.userId, reason = reason })
end

--- Разблокировка игрока (POST /player/unban)
function DataStore:Unban()
	return request("POST", "/player/unban", { userId = self.userId })
end

--- Активация промокода (POST /code/redeem)
function DataStore:RedeemCode(code)
	return request("POST", "/code/redeem", { userId = self.userId, code = code })
end

--- Захват сессии (POST /session/acquire)
function DataStore:AcquireSession(jobId, placeId)
	return request("POST", "/session/acquire", {
		userId = self.userId,
		jobId = jobId or game.JobId,
		placeId = placeId or game.PlaceId,
	})
end

--- Освобождение сессии (POST /session/release)
function DataStore:ReleaseSession(jobId)
	return request("POST", "/session/release", {
		userId = self.userId,
		jobId = jobId or game.JobId,
	})
end

--- Поддержание активности сессии (POST /session/heartbeat)
function DataStore:HeartbeatSession(jobId)
	return request("POST", "/session/heartbeat", {
		userId = self.userId,
		jobId = jobId or game.JobId,
	})
end

--- Запись в журнал аудита (POST /log)
function DataStore:Log(action, payload)
	return request("POST", "/log", { userId = self.userId, action = action, payload = payload })
end

--- Полное удаление данных игрока (POST /player/delete)
function DataStore:Delete()
	return request("POST", "/player/delete", { userId = self.userId })
end

--- Проверка здоровья сервера (GET /health)
function DataStore.Health()
	return request("GET", "/health")
end

--- Сводная статистика экономики (GET /admin/stats)
function DataStore.EconomyStats()
	return request("GET", "/admin/stats")
end

return DataStore