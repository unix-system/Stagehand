--!nonstrict
--[[
	The `lua` verb (action) and `wait: lua` / `expect: lua` (condition).
	Code runs via loadstring in plugin identity with an env exposing:
	  actor (Player | nil), player (same), character, vars, game, workspace, plugin, and every
	  service by name (Players, ReplicatedStorage, …) on top of the normal globals.
]]

local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")
local Json = if script then require(script.Parent.Parent.Json) else require("../Json")

local Lua = {}

--- Pseudo-entry for schema/catalog.json `dynamic.lua.shape` (kind is "action | condition").
Lua.shape = {
	name = "lua",
	kind = "action | condition",
	contexts = Json.array({ "edit", "server", "client" }),
	default = "server",
	summary = "Run Luau in plugin identity with actor, player, character, vars in scope",
	actor = "optional",
	params = {
		type = "object",
		properties = Json.ordered({ "code" }, { code = { type = "string" } }),
		required = Json.array({ "code" }),
		additionalProperties = false,
	},
}

local baseEnv = getfenv(1)

function Lua.env(ctx, extra: { [string]: any }?): { [string]: any }
	local player = ctx and ctx.player and ctx.player(false) or nil
	local env = {
		actor = player,
		player = player,
		character = player and player.Character or nil,
		vars = (ctx and ctx.vars) or {},
		game = Env.game(),
		workspace = Env.service("Workspace"),
		plugin = ctx and ctx.node and ctx.node.plugin or nil,
		script = nil,
	}
	if extra then
		for k, v in pairs(extra) do
			env[k] = v
		end
	end
	return setmetatable(env, {
		__index = function(_, k)
			local v = baseEnv[k]
			if v ~= nil then
				return v
			end
			if type(k) == "string" and k:match("^%u") then
				return Env.service(k)
			end
			return nil
		end,
	})
end

function Lua.compile(code: string, env: { [string]: any }): (...any) -> ...any
	if type(code) ~= "string" then
		Errors.throw("BAD_PARAMS", "lua code must be a string")
	end
	local ls = baseEnv.loadstring or loadstring
	if not ls then
		Errors.throw("LUA_ERROR", "loadstring is not available in this context")
	end
	local fn, err = ls(code, "=stagehand")
	if not fn then
		Errors.throw("LUA_ERROR", "compile error: " .. tostring(err))
	end
	setfenv(fn, env)
	return fn
end

--- Run code; returns the first value. Raises LUA_ERROR on failure.
function Lua.run(ctx, code: string, extra: { [string]: any }?): any
	local fn = Lua.compile(code, Lua.env(ctx, extra))
	local results = table.pack(pcall(fn))
	if not results[1] then
		local e = results[2]
		if Errors.is(e) then
			error(e, 0)
		end
		Errors.throw("LUA_ERROR", tostring(e))
	end
	return results[2]
end

--- Extract code from step params: { code } or { code, returns? }.
function Lua.code(params: any): string
	if type(params) == "string" then
		return params
	end
	if type(params) == "table" then
		if type(params.code) == "string" then
			return params.code
		elseif type(params.code) == "table" and type(params.code.code) == "string" then
			return params.code.code
		end
	end
	Errors.throw("BAD_PARAMS", "lua step needs params.code")
end

return Lua
