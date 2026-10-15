--!nonstrict
-- player.* actions and conditions

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")
local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")
local Resolve = if script then require(script.Parent.Parent.Resolve) else require("../Resolve")
local Conditions = if script then require(script.Parent.Parent.Conditions) else require("../Conditions")

local S = Meta.S
local SC = { "server", "client" }

local function findToolTemplate(ctx, name: string)
	if Resolve.looksLikeSelector(name) then
		return Resolve.one(name, ctx)
	end
	for _, svcName in ipairs({ "ServerStorage", "ReplicatedStorage", "StarterPack" }) do
		local svc = Env.service(svcName)
		if svc then
			for _, d in ipairs(svc:GetDescendants()) do
				if d.Name == name and d:IsA("Tool") then
					return d
				end
			end
		end
	end
	Errors.throw("RESOLVE_FAILED", "no Tool named '" .. name .. "' in ServerStorage, ReplicatedStorage or StarterPack")
end

local function playerSignals(_ctx)
	local players = Env.service("Players")
	local list = {}
	if players then
		table.insert(list, players.PlayerAdded)
		table.insert(list, players.PlayerRemoving)
	end
	return list
end

return {
	entries = {
		Meta.define({
			name = "player.setTeam",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Set the actor's Team by Teams child name.",
			actor = "required",
			params = S.params({ { "team", S.string() } }, { "team" }),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				local teams = Env.service("Teams")
				local team = teams and teams:FindFirstChild(p.team)
				if not team or not team:IsA("Team") then
					Errors.throw("RESOLVE_FAILED", "no Team named '" .. p.team .. "' under Teams")
				end
				player.Neutral = false
				player.Team = team
				return nil
			end,
		}),

		Meta.define({
			name = "player.respawn",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Respawn the actor (Player:LoadCharacter) and wait for the new character.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local player = ctx.player()
				local old = player.Character
				player:LoadCharacter()
				local status = Conditions.waitUntil(function()
					local c = player.Character
					return c ~= nil and c ~= old and c:FindFirstChildOfClass("Humanoid") ~= nil, nil
				end, {
					timeout = ctx.budget,
					signals = function()
						return { player.CharacterAdded }
					end,
					cancelled = ctx.cancelled,
					cancelSignal = ctx.cancelSignal,
				})
				if status ~= "passed" then
					Errors.throw("TIMEOUT", "character did not load after LoadCharacter")
				end
				return player.Character
			end,
		}),

		Meta.define({
			name = "player.setAttribute",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Set an attribute on the actor's Player.",
			actor = "required",
			params = S.params({ { "name", S.string() }, { "value", S.any() } }, { "name", "value" }),
		}, {
			run = function(ctx, p)
				ctx.player():SetAttribute(p.name, p.value)
				return nil
			end,
		}),

		Meta.define({
			name = "player.giveTool",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Clone a Tool into the actor's Backpack.",
			actor = "required",
			params = S.params({
				{
					"tool",
					S.string(
						"Tool name searched in ServerStorage, ReplicatedStorage, StarterPack (first match), or a selector"
					),
				},
			}, { "tool" }),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				local template = findToolTemplate(ctx, p.tool)
				local backpack = player:FindFirstChildOfClass("Backpack") or player:WaitForChild("Backpack", 5)
				if not backpack then
					Errors.throw("RESOLVE_FAILED", "actor has no Backpack")
				end
				local clone = template:Clone()
				clone.Parent = backpack
				return clone
			end,
		}),

		Meta.define({
			name = "player.setLeaderstat",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Set leaderstats.<stat>.Value for the actor.",
			actor = "required",
			params = S.params({ { "stat", S.string() }, { "value", S.any() } }, { "stat", "value" }),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				local ls = player:FindFirstChild("leaderstats")
				local stat = ls and ls:FindFirstChild(p.stat)
				if not stat then
					Errors.throw("RESOLVE_FAILED", "no leaderstats." .. p.stat .. " on " .. player.Name)
				end
				stat.Value = p.value
				return nil
			end,
		}),

		Meta.define({
			name = "player.onTeam",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Actor's Team name equals team.",
			actor = "required",
			params = S.params({ { "team", S.string() } }, { "team" }),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				local name = player.Team and player.Team.Name or nil
				return name == p.team, { team = name, neutral = player.Neutral }
			end,
			signals = function(ctx)
				local player = ctx.player()
				return { player:GetPropertyChangedSignal("Team") }
			end,
		}),

		Meta.define({
			name = "player.count",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Compare #Players:GetPlayers() with value.",
			actor = "none",
			params = S.params({ { "op", S.op() }, { "value", S.integer() } }, { "value" }),
		}, {
			run = function(_ctx, p)
				local n = #Env.service("Players"):GetPlayers()
				return Conditions.compare(p.op, n, p.value), { value = n }
			end,
			signals = playerSignals,
		}),

		Meta.define({
			name = "player.exists",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "The actor's Player is in the game.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local player = ctx.player(false)
				local exists = player ~= nil and player.Parent == Env.service("Players")
				return exists, { value = exists }
			end,
			signals = playerSignals,
		}),

		Meta.define({
			name = "player.attribute",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Compare an attribute on the actor's Player.",
			actor = "required",
			params = S.params({ { "name", S.string() }, { "op", S.op() }, { "value", S.any() } }, { "name", "value" }),
		}, {
			run = function(ctx, p)
				local v = ctx.player():GetAttribute(p.name)
				return Conditions.compare(p.op, v, p.value), { value = v }
			end,
			signals = function(ctx, p)
				return { ctx.player():GetAttributeChangedSignal(p.name) }
			end,
		}),
	},
}
