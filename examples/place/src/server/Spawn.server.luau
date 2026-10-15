--!strict
-- Handles the client's spawn request (fired by the SpawnButton GUI).

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local SpawnService = require(ServerScriptService:WaitForChild("SpawnService"))
local RequestSpawn = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("RequestSpawn") :: RemoteEvent

RequestSpawn.OnServerEvent:Connect(function(player: Player)
	SpawnService.request(player)
end)
