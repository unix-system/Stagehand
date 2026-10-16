--!nonstrict
--[[
	Fallback transport (skeleton): relay node ↔ broker traffic through the server node over a
	RemoteFunction, for an *injected* client runtime (a LocalScript copy of the node) in case Phase 0
	shows plugins do not load in simulated client DataModels (docs/architecture.md "Platform facts").

	  client node:  Remote.client():request(method, path, body)  → InvokeServer({method, path, body})
	  server node:  Remote.serve(httpTransport)                   → OnServerInvoke relays over HTTP

	Messages are identical to Transport/Http; attach bodies are forced to transport = "remote".
	Selected by USE_REMOTE_RELAY in init.server.luau (off by default). Only /attach, /poll, /result
	and /events are relayed.
]]

local Env = require(script.Parent.Parent.Env)

local Remote = {}
Remote.__index = Remote
Remote.kind = "remote"
Remote.NAME = "StagehandRelay"

local ALLOWED = { ["/attach"] = true, ["/poll"] = true, ["/result"] = true, ["/events"] = true }

local function allowed(path: string): boolean
	local base = path:match("^(/[%w_]+)")
	return base ~= nil and ALLOWED[base] == true
end

--- Server side: create ReplicatedStorage.StagehandRelay and relay requests through `http`.
function Remote.serve(http)
	local rs = Env.service("ReplicatedStorage")
	if not rs then
		return nil
	end
	local rf = rs:FindFirstChild(Remote.NAME)
	if not rf then
		rf = Instance.new("RemoteFunction")
		rf.Name = Remote.NAME
		rf.Parent = rs
	end
	rf.OnServerInvoke = function(_player, req)
		if type(req) ~= "table" or type(req.path) ~= "string" or not allowed(req.path) then
			return { status = 400, data = { error = { code = "BAD_REQUEST", message = "relay: path not allowed" } } }
		end
		local body = req.body
		if req.path == "/attach" and type(body) == "table" then
			body.transport = "remote"
		end
		local status, data, err = http:request(req.method or "GET", req.path, body)
		return { status = status, data = data, err = err }
	end
	return rf
end

--- Client side transport.
function Remote.client()
	return setmetatable({}, Remote)
end

function Remote:request(method: string, path: string, body: any?): (number, any, string?)
	local rs = Env.service("ReplicatedStorage")
	local rf = rs and rs:WaitForChild(Remote.NAME, 10)
	if not rf then
		return 0, nil, "relay " .. Remote.NAME .. " not found"
	end
	local ok, res = pcall(function()
		return rf:InvokeServer({ method = method, path = path, body = body })
	end)
	if not ok or type(res) ~= "table" then
		return 0, nil, tostring(res)
	end
	return res.status or 0, res.data, res.err
end

return Remote
