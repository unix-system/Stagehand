--!strict
-- Optional Stagehand game hooks. Exposes game.requestSpawn, game.reset, game.hasSpawned
-- and game.inMatch to playtests. The place runs normally when the package is absent.
-- Server hooks receive (player, params); `player` is nil when the step has no `as`.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local SpawnService = require(ServerScriptService:WaitForChild("SpawnService"))

local packages = ReplicatedStorage:FindFirstChild("Packages")
local module = packages and packages:FindFirstChild("StagehandHooks")
if not module or not module:IsA("ModuleScript") then
	return -- stagehand-hooks not installed (`wally install`); nothing to register
end

local ok, err = pcall(function()
	local Hooks = (require :: any)(module)
	Hooks.server({
		requestSpawn = {
			desc = "Spawn the player at their team's SpawnLocation (same path as the SpawnButton)",
			run = function(player: Player?)
				assert(player, "requestSpawn needs `as`")
				SpawnService.request(player)
			end,
		},
		reset = {
			desc = "Clear Hostile tags, teams and characters (used by session.reset: hook)",
			run = function()
				SpawnService.reset()
			end,
		},
		hasSpawned = {
			kind = "condition",
			desc = "The player has a living character",
			run = function(player: Player?)
				return SpawnService.hasSpawned(player)
			end,
		},
		inMatch = {
			kind = "condition",
			desc = "At least one player is on a team and alive",
			run = function()
				for _, player in Players:GetPlayers() do
					if player.Team and SpawnService.hasSpawned(player) then
						return true
					end
				end
				return false
			end,
		},
	})
end)
if not ok then
	warn(`[Example] Stagehand hooks not registered: {err}`)
end
