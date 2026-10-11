--[[
	LeaderboardStand (Script → ServerScriptService/Examples/LeaderboardStand)
	Пример физического стенда с таблицей лидеров (Топ 10 игроков по монетам).

	Как использовать:
	 1. Помести в Workspace блок (Part) с именем "LeaderboardBoard".
	 2. Этот скрипт автоматически создаст на нём SurfaceGui и будет
	    обновлять список богатейших игроков каждые 30 секунд из MariaDB.
]]

local ServerScriptService = game:GetService("ServerScriptService")
local DataManager = require(ServerScriptService.Modules:WaitForChild("DataManager"))

local REFRESH_INTERVAL = 30 -- Секунд между обновлениями топа

local function updateLeaderboardDisplay(gui)
	local container = gui:FindFirstChild("List")
	if not container then return end

	local topPlayers, err = DataManager.Leaderboard("coins", 10)
	if not topPlayers then
		warn("[LeaderboardStand] Ошибка загрузки топа:", err)
		return
	end

	-- Очищаем старые строки
	for _, child in ipairs(container:GetChildren()) do
		if child:IsA("TextLabel") and child.Name ~= "Header" then
			child:Destroy()
		end
	end

	-- Заполняем топ
	for i, playerInfo in ipairs(topPlayers) do
		local label = Instance.new("TextLabel")
		label.Name = "Row_" .. i
		label.Size = UDim2.new(1, 0, 0, 30)
		label.Position = UDim2.new(0, 0, 0, 35 * i)
		label.BackgroundTransparency = (i % 2 == 0) and 0.8 or 0.9
		label.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
		label.TextColor3 = (i == 1) and Color3.fromRGB(255, 215, 0) or Color3.fromRGB(255, 255, 255)
		label.TextSize = 20
		label.Font = Enum.Font.GothamBold
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.Text = string.format("  #%d  %s — %s монет", playerInfo.position or i, playerInfo.username, tostring(playerInfo.value))
		label.Parent = container
	end
end

local function setupBoard(part)
	if not part:IsA("BasePart") then return end

	local gui = part:FindFirstChild("LeaderboardGui")
	if not gui then
		gui = Instance.new("SurfaceGui")
		gui.Name = "LeaderboardGui"
		gui.Face = Enum.NormalId.Front
		gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
		gui.PixelsPerStud = 50
		gui.Parent = part

		local frame = Instance.new("Frame")
		frame.Name = "List"
		frame.Size = UDim2.new(1, 0, 1, 0)
		frame.BackgroundColor3 = Color3.fromRGB(25, 25, 35)
		frame.Parent = gui

		local header = Instance.new("TextLabel")
		header.Name = "Header"
		header.Size = UDim2.new(1, 0, 0, 40)
		header.BackgroundColor3 = Color3.fromRGB(40, 40, 60)
		header.TextColor3 = Color3.fromRGB(255, 215, 0)
		header.Text = "ТОП 10 ИГРОКОВ (MARIADB)"
		header.TextSize = 24
		header.Font = Enum.Font.GothamBlack
		header.Parent = frame
	end

	task.spawn(function()
		while task.wait(REFRESH_INTERVAL) do
			updateLeaderboardDisplay(gui)
		end
	end)

	-- Первоначальное обновление
	task.delay(3, function()
		updateLeaderboardDisplay(gui)
	end)
end

-- Ищем блок стенда в Workspace
local targetPart = workspace:FindFirstChild("LeaderboardBoard")
if targetPart then
	setupBoard(targetPart)
else
	workspace.DescendantAdded:Connect(function(descendant)
		if descendant:IsA("BasePart") and descendant.Name == "LeaderboardBoard" then
			setupBoard(descendant)
		end
	end)
end

print("[LeaderboardStand] Скрипт 3D таблицы лидеров активен")
