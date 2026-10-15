--!nonstrict
--[[
	Live game.* entries from the game's stagehand-hooks bridge (hooks/ package).

	Server: ReplicatedStorage.StagehandHooks.Invoke (BindableFunction)
	Client: Players.LocalPlayer.PlayerScripts.StagehandHooks.Invoke
	        (never the replicated server bindable: invoking that from a client yields forever)

	Bridge requests: { op = "list" } → { version, side, hooks = { {name, desc, kind, params?} } }
	                 { op = "run", name, player, params } → { ok, value? , error? }
]]

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")
local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")

local GameHooks = {}

GameHooks.LIST_TIMEOUT = 2

--- Example entry used for the `dynamic.game.shape` block of schema/catalog.json.
GameHooks.shape = Meta.entry({
	name = "game.requestSpawn",
	kind = "action",
	contexts = { "server" },
	default = "server",
	summary = "<hook desc>",
	actor = "optional",
	params = { type = "object", additionalProperties = true },
	source = "hook",
})

function GameHooks.bridge(role: string): any
	if role == "server" then
		local rs = Env.service("ReplicatedStorage")
		local folder = rs and rs:FindFirstChild("StagehandHooks")
		local inv = folder and folder:FindFirstChild("Invoke")
		if inv and inv:IsA("BindableFunction") then
			return inv
		end
	elseif role == "client" then
		local players = Env.service("Players")
		local lp = players and players.LocalPlayer
		local ps = lp and lp:FindFirstChildOfClass("PlayerScripts")
		local folder = ps and ps:FindFirstChild("StagehandHooks")
		local inv = folder and folder:FindFirstChild("Invoke")
		if inv and inv:IsA("BindableFunction") then
			return inv
		end
	end
	return nil
end

-- Invoke with a timeout (a hook bridge without OnInvoke would otherwise yield forever).
local function invoke(bridge, request, timeout: number): (boolean, any)
	local task = Env.task()
	local done, waiting, ok, res = false, false, false, nil
	local thread = coroutine.running()
	local timer
	local function finish(success: boolean, value: any)
		if done then
			return
		end
		done = true
		ok, res = success, value
		if timer and coroutine.running() ~= timer then
			pcall(task.cancel, timer)
		end
		if waiting then
			task.spawn(thread)
		end
	end
	task.spawn(function()
		finish(pcall(function()
			return bridge:Invoke(request)
		end))
	end)
	if done then
		return ok, res
	end
	waiting = true
	timer = task.delay(timeout, function()
		finish(false, "hook bridge did not answer within " .. timeout .. "s")
	end)
	coroutine.yield()
	return ok, res
end

function GameHooks.list(role: string): { any }
	local bridge = GameHooks.bridge(role)
	if not bridge then
		return {}
	end
	local ok, res = invoke(bridge, { op = "list" }, GameHooks.LIST_TIMEOUT)
	if not ok or type(res) ~= "table" or type(res.hooks) ~= "table" then
		return {}
	end
	return res.hooks
end

function GameHooks.entries(role: string): { any }
	local out = {}
	for _, h in ipairs(GameHooks.list(role)) do
		if type(h.name) == "string" then
			local params = h.params
			if type(params) ~= "table" then
				params = { type = "object", additionalProperties = true }
			end
			table.insert(
				out,
				Meta.entry({
					name = "game." .. h.name,
					kind = if h.kind == "condition" then "condition" else "action",
					contexts = { role },
					default = role,
					summary = if type(h.desc) == "string" then h.desc else "",
					actor = "optional",
					params = params,
					source = "hook",
				})
			)
		end
	end
	table.sort(out, function(a, b)
		return a.name < b.name
	end)
	return out
end

--- Run a hook; budget is enforced by the Runner.
function GameHooks.run(ctx, hookName: string, params: { [string]: any })
	local bridge = GameHooks.bridge(ctx.role)
	if not bridge then
		Errors.throw(
			"UNKNOWN_ACTION",
			"game." .. hookName .. ": no StagehandHooks bridge on this " .. ctx.role .. " node"
		)
	end
	local ok, res = pcall(function()
		return bridge:Invoke({ op = "run", name = hookName, player = ctx.player(false), params = params })
	end)
	if not ok then
		Errors.throw("ACTION_ERROR", "game." .. hookName .. " bridge error: " .. tostring(res))
	end
	if type(res) ~= "table" then
		Errors.throw("ACTION_ERROR", "game." .. hookName .. ": malformed bridge response")
	end
	if not res.ok then
		local code = if res.code == "UNKNOWN" then "UNKNOWN_ACTION" else "ACTION_ERROR"
		Errors.throw(code, "game." .. hookName .. ": " .. tostring(res.error))
	end
	return res.value
end

--- Registry adapter: an Entry-like object for a live hook meta.
function GameHooks.toEntry(meta)
	local hookName = meta.name:sub(6)
	return {
		meta = meta,
		run = function(ctx, p)
			local value = GameHooks.run(ctx, hookName, p)
			if meta.kind == "condition" then
				return value and true or false, { value = value }
			end
			return value
		end,
	}
end

return GameHooks
