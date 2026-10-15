--!nonstrict
-- remote.* actions

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")
local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")
local Resolve = if script then require(script.Parent.Parent.Resolve) else require("../Resolve")

local S = Meta.S
local NAME_DESC = "Remote name (searched recursively in ReplicatedStorage) or selector"

local function findRemote(ctx, name: string, classes: { string })
	local inst
	if Resolve.looksLikeSelector(name) then
		inst = Resolve.one(name, ctx)
	else
		local rs = Env.service("ReplicatedStorage")
		if rs then
			for _, d in ipairs(rs:GetDescendants()) do
				if d.Name == name then
					for _, cls in ipairs(classes) do
						if d:IsA(cls) then
							inst = d
							break
						end
					end
					if inst then
						break
					end
				end
			end
		end
		if not inst then
			Errors.throw(
				"RESOLVE_FAILED",
				"no " .. table.concat(classes, "/") .. " named '" .. name .. "' in ReplicatedStorage"
			)
		end
	end
	for _, cls in ipairs(classes) do
		if inst:IsA(cls) then
			return inst
		end
	end
	Errors.throw(
		"BAD_PARAMS",
		inst:GetFullName() .. " is a " .. inst.ClassName .. ", expected " .. table.concat(classes, "/")
	)
end

local EVENTS = { "RemoteEvent", "UnreliableRemoteEvent" }

local function argsParams()
	return S.params({ { "name", S.string(NAME_DESC) }, { "args", S.args() } }, { "name" })
end

return {
	entries = {
		Meta.define({
			name = "remote.fire",
			kind = "action",
			contexts = { "client" },
			default = "client",
			summary = "RemoteEvent:FireServer(args...) from the actor's client.",
			actor = "required",
			params = argsParams(),
		}, {
			run = function(ctx, p)
				local remote = findRemote(ctx, p.name, EVENTS)
				remote:FireServer(table.unpack(p.args or {}))
				return nil
			end,
		}),

		Meta.define({
			name = "remote.invoke",
			kind = "action",
			contexts = { "client" },
			default = "client",
			summary = "RemoteFunction:InvokeServer(args...) from the actor's client; returns the first result.",
			actor = "required",
			params = argsParams(),
			returns = { description = "First return value" },
		}, {
			run = function(ctx, p)
				local remote = findRemote(ctx, p.name, { "RemoteFunction" })
				return (remote:InvokeServer(table.unpack(p.args or {})))
			end,
		}),

		Meta.define({
			name = "remote.fireClient",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "RemoteEvent:FireClient(actorPlayer, args...).",
			actor = "required",
			params = argsParams(),
		}, {
			run = function(ctx, p)
				local remote = findRemote(ctx, p.name, EVENTS)
				remote:FireClient(ctx.player(), table.unpack(p.args or {}))
				return nil
			end,
		}),
	},
}
