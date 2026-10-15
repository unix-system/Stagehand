--!strict
-- Builds the spawn menu: PlayerGui.SpawnGui.SpawnButton fires RequestSpawn.
-- Created from code (not StarterGui) because CharacterAutoLoads is off, and StarterGui
-- is only copied into PlayerGui when a character spawns.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RequestSpawn = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("RequestSpawn") :: RemoteEvent
local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local gui = Instance.new("ScreenGui")
gui.Name = "SpawnGui"
gui.ResetOnSpawn = false

local button = Instance.new("TextButton")
button.Name = "SpawnButton"
button.Text = "Spawn"
button.Size = UDim2.fromOffset(160, 48)
button.Position = UDim2.new(0.5, -80, 1, -80)
button.Parent = gui

button.Activated:Connect(function()
	RequestSpawn:FireServer()
end)

gui.Parent = playerGui
