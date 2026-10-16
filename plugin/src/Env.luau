--!nonstrict
--[[
	Env — the single seam between plugin logic and the Roblox runtime.

	Every module reaches Roblox services/datatypes through Env, never at require time, so the
	pure parts (Resolve, Conditions, Registry, Actions metas) load under Lune. Tests call
	Env.override({ game = stubDataModel, task = <@lune/task>, ... }).
]]

local Env = {}

local overrides: { [string]: any } = {}

function Env.override(map: { [string]: any })
	for k, v in pairs(map) do
		overrides[k] = v
	end
end

function Env.reset()
	table.clear(overrides)
end

-- Captured at require time; all nil under Lune unless overridden.
local builtins: { [string]: any } = {
	game = game,
	task = task,
	Enum = Enum,
	Vector2 = Vector2,
	Vector3 = Vector3,
	CFrame = CFrame,
	Color3 = Color3,
	BrickColor = BrickColor,
	UDim2 = UDim2,
}

local function global(name: string): any
	local v = overrides[name]
	if v ~= nil then
		return v
	end
	return builtins[name]
end

function Env.game(): any
	return global("game")
end

function Env.task(): any
	return global("task")
end

function Env.datatype(name: string): any
	return global(name)
end

function Env.Enum(): any
	return global("Enum")
end

--- Service by name; nil (never an error) when unavailable in this context.
function Env.service(name: string): any
	local o = overrides["service:" .. name]
	if o ~= nil then
		return o
	end
	local g = Env.game()
	if g == nil then
		return nil
	end
	local ok, svc = pcall(function()
		return g:GetService(name)
	end)
	if ok then
		return svc
	end
	return nil
end

function Env.typeof(v: any): string
	local f = overrides.typeof or typeof
	return f(v)
end

function Env.isInstance(v: any): boolean
	return Env.typeof(v) == "Instance"
end

function Env.clock(): number
	local f = overrides.clock or os.clock
	return f()
end

function Env.warn(...)
	local f = overrides.warn or warn or print
	f(...)
end

return Env
