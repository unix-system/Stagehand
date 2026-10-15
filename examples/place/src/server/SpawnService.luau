--!strict
-- Spawning and match-reset logic shared by the RequestSpawn remote handler and the
-- Stagehand game hooks, so tests drive exactly the code real players do.

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")

local SpawnService = {}

-- Finds the SpawnLocation whose TeamColor matches the team (Workspace.Spawns.<Team>).
local function spawnFor(team: Team?): SpawnLocation?
	if not team then
		return nil
	end
	local spawns = workspace:FindFirstChild("Spawns")
	local spawn = spawns and spawns:FindFirstChild(team.Name)
	if spawn and spawn:IsA("SpawnLocation") then
		return spawn
	end
	return nil
end

-- Loads the player's character and places it on their team's SpawnLocation.
function SpawnService.request(player: Player)
	player:LoadCharacter()
	local spawn = spawnFor(player.Team)
	local character = player.Character
	if spawn and character then
		character:PivotTo(spawn.CFrame + Vector3.new(0, 4, 0))
	elseif not spawn then
		warn(`[Example] {player.Name} has no team spawn; spawned at default location`)
	end
end

-- True when the player has a living character.
function SpawnService.hasSpawned(player: Player?): boolean
	local character = player and player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	return humanoid ~= nil and humanoid.Health > 0
end

-- Back to the lobby: clear Hostile tags, teams and characters.
function SpawnService.reset()
	for _, tagged in CollectionService:GetTagged("Hostile") do
		CollectionService:RemoveTag(tagged, "Hostile")
	end
	for _, player in Players:GetPlayers() do
		player.Team = nil
		if player.Character then
			player.Character:Destroy()
			player.Character = nil
		end
	end
end

return SpawnService
