--[[
	ProfileSync (Script → ServerScriptService/ProfileSync)
	Версия 3.0.0

	Главный управляющий скрипт синхронизации данных Roblox Studio с MariaDB.
	Положи этот скрипт в ServerScriptService.
	Все настройки игры задаются в блоке CONFIG ниже.

	ВАЖНО: В Roblox Studio обязательно включи:
	Home → Game Settings → Security → Allow HTTP Requests (Включить!)
]]

local ServerScriptService = game:GetService("ServerScriptService")

local DataStore = require(ServerScriptService.Modules:WaitForChild("DataStore"))
local DataManager = require(ServerScriptService.Modules:WaitForChild("DataManager"))

-- ==================================================================
--  НАСТРОЙКИ ИГРЫ
-- ==================================================================

local CONFIG = {
	-- Адрес локального сервера-моста (если сервер на другом ПК: http://192.168.1.X:3000)
	BaseUrl = "http://localhost:3000",

	-- Токен авторизации (если задан API_KEY в файле server/.env, укажи его здесь строкой)
	ApiKey = nil,

	-- Таблица отображения в списке игроков (leaderstats):
	-- [Имя колонки в Tab-меню] = "ключ в MariaDB"
	Leaderstats = {
		Coins = "coins",
		Gems  = "gems",
		Level = "level",
	},

	-- Поля, которые автоматически зеркалятся в player:SetAttribute(...)
	-- Клиентский UI может читать их мгновенно: player:GetAttribute("level") без сетевых запросов!
	SyncKeys = {
		"level",
		"xp",
		"gems",
	},

	-- АНТИЧИТ: Белый список ключей, которые клиент МОЖЕТ менять через RemoteFunction.
	-- Оставь ПУСТЫМ ({}), чтобы читеры не могли начислять себе монеты или менять уровень!
	-- Начисление валюты производи через серверные скрипты: DataManager.GiveCoins(player, 100)
	ClientWritableKeys = {},

	-- Защита от дюпа (Session Locking):
	-- true — не пускать игрока, если он уже залогинен на другом сервере плейса
	UseSessionLock = false,

	-- Автосохранение в MariaDB каждые N секунд (0 — отключить, сохранять только при выходе)
	SaveInterval = 120,

	-- Сколько секунд ждать загрузки данных из БД при входе
	LoadTimeout = 20,

	-- Поведение при сбое подключения к MariaDB:
	-- "keepZero" — играть с нулями локально (база не затирается нулями)
	-- "kick"     — выгнать игрока с вежливым сообщением
	OnLoadFail = "keepZero",
}

-- ==================================================================
--  ИНИЦИАЛИЗАЦИЯ И СТАРТ
-- ==================================================================

DataStore.setup({
	BaseUrl = CONFIG.BaseUrl,
	ApiKey = CONFIG.ApiKey,
	Attempts = 3,
	RetryDelay = 1.5,
})

DataManager.Setup({
	Leaderstats = CONFIG.Leaderstats,
	SyncKeys = CONFIG.SyncKeys,
	ClientWritableKeys = CONFIG.ClientWritableKeys,
	UseSessionLock = CONFIG.UseSessionLock,
	SaveInterval = CONFIG.SaveInterval,
	LoadTimeout = CONFIG.LoadTimeout,
	OnLoadFail = CONFIG.OnLoadFail,
})

DataManager.Start()