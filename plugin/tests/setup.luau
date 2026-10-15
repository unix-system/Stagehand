-- Wires the plugin's Env seam to Lune's Roblox datatypes and a fresh stub DataModel.
local roblox = require("@lune/roblox")
local task = require("@lune/task")
local Env = require("../src/Env")

local Setup = {}

function Setup.dataModel()
	local Instance = roblox.Instance
	local game = Instance.new("DataModel")
	Env.reset()
	Env.override({
		game = game,
		task = task,
		Enum = roblox.Enum,
		Vector2 = roblox.Vector2,
		Vector3 = roblox.Vector3,
		CFrame = roblox.CFrame,
		Color3 = roblox.Color3,
		BrickColor = roblox.BrickColor,
		UDim2 = roblox.UDim2,
		warn = function() end,
	})
	return game, Instance
end

--- Workspace.Map.{Lamps.{Lamp1,Lamp2,Lamp3}, Spawns.{Blue,'Red Spawn'}}, Workspace.Enemies.{Boss,Grunt,Grunt}
function Setup.world()
	local game, Instance = Setup.dataModel()
	local ws = game:GetService("Workspace")
	local function make(class, name, parent)
		local i = Instance.new(class)
		i.Name = name
		i.Parent = parent
		return i
	end
	local map = make("Model", "Map", ws)
	local lamps = make("Folder", "Lamps", map)
	for n = 1, 3 do
		local lamp = make("Part", "Lamp" .. n, lamps)
		lamp:SetAttribute("Index", n)
	end
	local spawns = make("Folder", "Spawns", map)
	make("SpawnLocation", "Blue", spawns)
	make("SpawnLocation", "Red Spawn", spawns)
	local enemies = make("Folder", "Enemies", ws)
	local boss = make("Model", "Boss", enemies)
	boss:SetAttribute("Team", "Red")
	boss:SetAttribute("Health", 100)
	local g1 = make("Model", "Grunt", enemies)
	g1:SetAttribute("Team", "Red")
	g1:SetAttribute("Health", 50)
	local g2 = make("Model", "Grunt", enemies)
	g2:SetAttribute("Team", "Blue")
	g2:SetAttribute("Health", 100)
	boss:AddTag("Hostile")
	g1:AddTag("Hostile")
	local deep = make("Folder", "Deep", enemies)
	make("Part", "Spawn", deep)
	local rs = game:GetService("ReplicatedStorage")
	local remotes = make("Folder", "Remotes", rs)
	make("RemoteEvent", "RequestSpawn", remotes)
	return game, { map = map, lamps = lamps, spawns = spawns, enemies = enemies, boss = boss, g1 = g1, g2 = g2 }
end

return Setup
