--[[
	PromoCodeGui (LocalScript → StarterPlayer/StarterPlayerScripts/PromoCodeGui)
	Пример клиентского интерфейса для ввода и активации промокодов.

	Позволяет игроку ввести промокод (например "STARTGIFT" или "PROMO2026")
	и моментально получить монеты/предметы с обратной связью.
]]

local Players = game:GetService("Players")
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local DataClient = require(script.Parent:WaitForChild("DataClient"))

-- Создаем аккуратный UI для ввода промокода (если его еще нет в StarterGui)
local function buildPromoGui()
	local screenGui = Instance.new("ScreenGui")
	screenGui.Name = "PromoCodeGui"
	screenGui.ResetOnSpawn = false
	screenGui.Parent = playerGui

	local frame = Instance.new("Frame")
	frame.Name = "MainFrame"
	frame.Size = UDim2.new(0, 320, 0, 180)
	frame.Position = UDim2.new(0.5, -160, 0.8, -90)
	frame.BackgroundColor3 = Color3.fromRGB(30, 30, 40)
	frame.BorderSizePixel = 0
	frame.Parent = screenGui

	-- Закругление углов
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 10)
	corner.Parent = frame

	local title = Instance.new("TextLabel")
	title.Size = UDim2.new(1, 0, 0, 35)
	title.BackgroundTransparency = 1
	title.Text = "АКТИВАЦИЯ ПРОМОКОДА"
	title.TextColor3 = Color3.fromRGB(255, 215, 0)
	title.Font = Enum.Font.GothamBold
	title.TextSize = 16
	title.Parent = frame

	local textBox = Instance.new("TextBox")
	textBox.Size = UDim2.new(0.85, 0, 0, 36)
	textBox.Position = UDim2.new(0.075, 0, 0.28, 0)
	textBox.BackgroundColor3 = Color3.fromRGB(45, 45, 60)
	textBox.TextColor3 = Color3.fromRGB(255, 255, 255)
	textBox.PlaceholderText = "Введите промокод..."
	textBox.PlaceholderColor3 = Color3.fromRGB(150, 150, 170)
	textBox.Font = Enum.Font.Gotham
	textBox.TextSize = 16
	textBox.Parent = frame

	local tbCorner = Instance.new("UICorner")
	tbCorner.CornerRadius = UDim.new(0, 6)
	tbCorner.Parent = textBox

	local statusLabel = Instance.new("TextLabel")
	statusLabel.Size = UDim2.new(1, 0, 0, 25)
	statusLabel.Position = UDim2.new(0, 0, 0.52, 0)
	statusLabel.BackgroundTransparency = 1
	statusLabel.Text = ""
	statusLabel.Font = Enum.Font.Gotham
	statusLabel.TextSize = 13
	statusLabel.Parent = frame

	local button = Instance.new("TextButton")
	button.Size = UDim2.new(0.85, 0, 0, 36)
	button.Position = UDim2.new(0.075, 0, 0.72, 0)
	button.BackgroundColor3 = Color3.fromRGB(46, 204, 113)
	button.TextColor3 = Color3.fromRGB(255, 255, 255)
	button.Font = Enum.Font.GothamBold
	button.TextSize = 16
	button.Text = "АКТИВИРОВАТЬ"
	button.Parent = frame

	local btnCorner = Instance.new("UICorner")
	btnCorner.CornerRadius = UDim.new(0, 6)
	btnCorner.Parent = button

	-- Обработка клика
	local busy = false
	button.MouseButton1Click:Connect(function()
		if busy then return end
		local code = textBox.Text:gsub("%s+", "")
		if #code < 3 then
			statusLabel.TextColor3 = Color3.fromRGB(231, 76, 60)
			statusLabel.Text = "Введите код!"
			return
		end

		busy = true
		statusLabel.TextColor3 = Color3.fromRGB(241, 196, 15)
		statusLabel.Text = "Проверка..."

		local success, rewardsOrErr = DataClient:RedeemCode(code)
		busy = false

		if success then
			statusLabel.TextColor3 = Color3.fromRGB(46, 204, 113)
			local rewardText = ""
			if rewardsOrErr.coins and rewardsOrErr.coins > 0 then
				rewardText = rewardText .. "+" .. rewardsOrErr.coins .. " монет "
			end
			if rewardsOrErr.gems and rewardsOrErr.gems > 0 then
				rewardText = rewardText .. "+" .. rewardsOrErr.gems .. " кристаллов "
			end
			if rewardsOrErr.item then
				rewardText = rewardText .. "+" .. rewardsOrErr.amount .. " " .. rewardsOrErr.item
			end
			statusLabel.Text = "Успешно! " .. rewardText
			textBox.Text = ""
		else
			statusLabel.TextColor3 = Color3.fromRGB(231, 76, 60)
			statusLabel.Text = tostring(rewardsOrErr or "Ошибка активации")
		end
	end)
end

task.delay(1, buildPromoGui)
