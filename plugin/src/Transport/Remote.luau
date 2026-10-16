--!nonstrict
--[[
	Client transport: relay node ↔ broker traffic through the server node over a RemoteFunction,
	because HttpService refuses requests in a Studio play client. Bodies cross as JSON text.

	  client node:  Remote.client():request(method, path, body)  → InvokeServer({method, path, body})
	  server node:  Remote.serve(httpTransport)                   → OnServerInvoke relays over HTTP

	Messages are identical to Transport/Http (attach sends transport = Remote.kind). Selected by
	Config.USE_REMOTE_RELAY. Only /attach, /poll, /result and /events are relayed.
]]

local Env = require(script.Parent.Parent.Env)
local Json = require(script.Parent.Parent.Json)

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
		if req.body ~= nil and type(req.body) ~= "string" then
			return {
				status = 400,
				data = { error = { code = "BAD_REQUEST", message = "relay: body must be JSON text" } },
			}
		end
		local status, data, err = http:request(req.method or "GET", req.path, req.body)
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
		-- Encode here: Json.null / ordered / array markers do not survive a RemoteFunction.
		return rf:InvokeServer({ method = method, path = path, body = if body ~= nil then Json.encode(body) else nil })
	end)
	if not ok or type(res) ~= "table" then
		return 0, nil, tostring(res)
	end
	return res.status or 0, res.data, res.err
end

return Remote
