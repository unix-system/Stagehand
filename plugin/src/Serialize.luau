--!nonstrict
--[[
	Roblox value → JSON form (docs/protocol.md "Shared shapes"):
	Vector3 → [x,y,z], Vector2 → [x,y], CFrame → {pos, look}, Color3 → "#rrggbb",
	EnumItem → "Enum.X.Y", Instance → full-name path, other userdata → tostring(v).
]]

local Env = require(script.Parent.Env)
local Json = require(script.Parent.Json)

local Serialize = {}

local function round(n: number): number
	-- trim float noise (0.30000000000000004) without losing meaningful precision
	local r = math.floor(n * 1e6 + 0.5) / 1e6
	if math.abs(r - n) < 1e-9 then
		return r
	end
	return n
end

function Serialize.color3(c: any): string
	return string.format(
		"#%02x%02x%02x",
		math.clamp(math.floor(c.R * 255 + 0.5), 0, 255),
		math.clamp(math.floor(c.G * 255 + 0.5), 0, 255),
		math.clamp(math.floor(c.B * 255 + 0.5), 0, 255)
	)
end

function Serialize.value(v: any, depth: number?): any
	depth = depth or 0
	if depth > 16 then
		return "<depth>"
	end
	local t = Env.typeof(v)
	if t == "nil" or t == "boolean" or t == "string" then
		return v
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return tostring(v)
		end
		return round(v)
	elseif t == "table" then
		if v == Json.null then
			return v
		end
		local isArr = Json.isArray(v)
		local out = {}
		if isArr then
			for i, x in ipairs(v) do
				out[i] = Serialize.value(x, depth + 1)
			end
			return Json.array(out)
		end
		for k, x in pairs(v) do
			out[tostring(k)] = Serialize.value(x, depth + 1)
		end
		return Json.object(out)
	elseif t == "Vector3" then
		return Json.array({ round(v.X), round(v.Y), round(v.Z) })
	elseif t == "Vector2" then
		return Json.array({ round(v.X), round(v.Y) })
	elseif t == "CFrame" then
		local p, l = v.Position, v.LookVector
		return Json.ordered({ "pos", "look" }, {
			pos = Json.array({ round(p.X), round(p.Y), round(p.Z) }),
			look = Json.array({ round(l.X), round(l.Y), round(l.Z) }),
		})
	elseif t == "Color3" then
		return Serialize.color3(v)
	elseif t == "EnumItem" then
		return tostring(v)
	elseif t == "Instance" then
		local ok, name = pcall(function()
			return v:GetFullName()
		end)
		return if ok then name else tostring(v)
	elseif t == "BrickColor" then
		return tostring(v)
	end
	return tostring(v)
end

return Serialize
