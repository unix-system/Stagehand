--!strict
--[[
	stagehand-hooks — expose named game actions/conditions to Stagehand playtests as `game.<name>`.

	  Hooks.server({ requestSpawn = { run = function(player, params) … end, desc = "…" } })
	  Hooks.client({ openShop = function(player, params) … end })

	A hook is a function or { run, desc?, kind? = "action" | "condition", params? (JSON Schema) }.
	run(player, params): player = the step actor's Player (nil when the step has no `as`), params =
	the step's params map. Condition hooks return truthy/falsy; action hooks may return a value that
	the step can `save`.

	Bridge (what the Stagehand plugin node calls; hooks run with the game's live module state):
	  server: ReplicatedStorage.StagehandHooks.Invoke                (BindableFunction)
	  client: Players.LocalPlayer.PlayerScripts.StagehandHooks.Invoke (BindableFunction)
	  Invoke({ op = "list" }) → { version = 1, side, hooks = { { name, desc, kind, params? } } }
	  Invoke({ op = "run", name, player, params }) → { ok = true, value } | { ok = false, error, code? }

	The bridge is only created in Studio (RunService:IsStudio()) unless Hooks.enabledInLive = true.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

export type HookFn = (player: Player?, params: { [string]: any }) -> any
export type HookSpec = HookFn | {
	run: HookFn,
	desc: string?,
	kind: ("action" | "condition")?,
	params: { [string]: any }?,
}
type Hook = { name: string, run: HookFn, desc: string, kind: string, params: { [string]: any }? }

local Hooks = {}

Hooks.VERSION = 1
Hooks.FOLDER = "StagehandHooks"
Hooks.enabledInLive = false

local registries: { [string]: { [string]: Hook } } = { server = {}, client = {} }
local bridges: { [string]: BindableFunction } = {}

local function normalise(name: string, spec: HookSpec): Hook
	assert(
		type(name) == "string" and name:match("^[%a_][%w_]*$"),
		"stagehand-hooks: invalid hook name " .. tostring(name)
	)
	if type(spec) == "function" then
		return { name = name, run = spec, desc = "", kind = "action" }
	end
	assert(
		type(spec) == "table" and type(spec.run) == "function",
		"stagehand-hooks: hook " .. name .. " needs a run function"
	)
	local kind = spec.kind or "action"
	assert(
		kind == "action" or kind == "condition",
		"stagehand-hooks: hook " .. name .. " kind must be action|condition"
	)
	return { name = name, run = spec.run, desc = spec.desc or "", kind = kind, params = spec.params }
end

local function list(side: string)
	local out = {}
	for _, h in pairs(registries[side]) do
		table.insert(out, { name = h.name, desc = h.desc, kind = h.kind, params = h.params })
	end
	table.sort(out, function(a, b)
		return a.name < b.name
	end)
	return { version = Hooks.VERSION, side = side, hooks = out }
end

local function handler(side: string)
	return function(request: any): any
		if type(request) ~= "table" then
			return { ok = false, error = "bad request" }
		end
		if request.op == "list" then
			return list(side)
		elseif request.op == "run" then
			local hook = registries[side][request.name]
			if not hook then
				return {
					ok = false,
					code = "UNKNOWN",
					error = "no " .. side .. " hook named " .. tostring(request.name),
				}
			end
			local results = table.pack(pcall(hook.run, request.player, request.params or {}))
			if not results[1] then
				return { ok = false, error = tostring(results[2]) }
			end
			return { ok = true, value = results[2] }
		end
		return { ok = false, error = "unknown op " .. tostring(request.op) }
	end
end

local function ensureBridge(side: string, parent: Instance)
	if bridges[side] and bridges[side].Parent then
		return
	end
	local folder = parent:FindFirstChild(Hooks.FOLDER)
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = Hooks.FOLDER
		folder.Parent = parent
	end
	local invoke = folder:FindFirstChild("Invoke") :: BindableFunction?
	if not invoke then
		local created = Instance.new("BindableFunction")
		created.Name = "Invoke"
		created.Parent = folder
		invoke = created
	end
	assert(invoke and invoke:IsA("BindableFunction"), "stagehand-hooks: Invoke must be a BindableFunction")
	invoke.OnInvoke = handler(side)
	bridges[side] = invoke
end

local function register(side: string, hooks: { [string]: HookSpec })
	for name, spec in pairs(hooks) do
		registries[side][name] = normalise(name, spec)
	end
end

local function enabled(): boolean
	return Hooks.enabledInLive or RunService:IsStudio()
end

--- Register server-side hooks (call from a server Script).
function Hooks.server(hooks: { [string]: HookSpec })
	assert(RunService:IsServer(), "stagehand-hooks: Hooks.server must be called on the server")
	register("server", hooks)
	if enabled() then
		ensureBridge("server", ReplicatedStorage)
	end
end

--- Register client-side hooks (call from a LocalScript).
function Hooks.client(hooks: { [string]: HookSpec })
	assert(RunService:IsClient(), "stagehand-hooks: Hooks.client must be called on a client")
	register("client", hooks)
	if enabled() then
		local player = Players.LocalPlayer
		local playerScripts = player:WaitForChild("PlayerScripts")
		ensureBridge("client", playerScripts)
	end
end

--- Registered hook descriptors for a side ("server" | "client").
function Hooks.list(side: string)
	return list(side)
end

return Hooks
