--!nonstrict
--[[
	Default transport: HttpService:RequestAsync against the local daemon broker.
	request(method, path, body?) → (status, data, err). status 0 = connection failure
	(daemon down, or the localhost permission prompt was declined).
]]

local Env = require(script.Parent.Parent.Env)
local Json = require(script.Parent.Parent.Json)

local Http = {}
Http.__index = Http
Http.kind = "http"

function Http.new(port: number)
	return setmetatable({ port = port, baseUrl = "http://127.0.0.1:" .. tostring(port) .. "/v1" }, Http)
end

function Http:request(method: string, path: string, body: any?): (number, any, string?)
	local hs = Env.service("HttpService")
	if not hs then
		return 0, nil, "HttpService unavailable"
	end
	local req = {
		Url = self.baseUrl .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json" },
	}
	if type(body) == "string" then
		req.Body = body -- pre-encoded (relayed from a client node)
	elseif body ~= nil then
		req.Body = Json.encode(body)
	end
	local ok, res = pcall(function()
		return hs:RequestAsync(req)
	end)
	if not ok then
		return 0, nil, tostring(res)
	end
	local data = nil
	if type(res.Body) == "string" and #res.Body > 0 then
		local okDecode, decoded = pcall(function()
			return hs:JSONDecode(res.Body)
		end)
		if okDecode then
			data = decoded
		end
	end
	return res.StatusCode, data, nil
end

return Http
