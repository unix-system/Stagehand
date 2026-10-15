--!strict
--[[
	Json — deterministic JSON encoder shared by the plugin (wire bodies, catalog command) and
	tools/gen-catalog.luau (byte-for-byte schema/catalog.json).

	Luau tables have no key order and no array/object distinction for empty tables, so:
	  * Json.ordered(keys, t)  pins an explicit key order for t
	  * Json.array(t)          marks t as a JSON array (needed for empty arrays)
	  * Json.object(t)         marks t as a JSON object (needed for empty objects)
	Unmarked objects are ordered by KEY_RANK (catalog entry + JSON Schema keyword order used by
	schema/catalog.json), then alphabetically. Unmarked empty tables encode as {}.

	Output format with indent = 2 matches Python's json.dumps(obj, indent=2) (ensure_ascii):
	non-ASCII characters are escaped as \uXXXX.
]]

local Json = {}

local ORDER: { [any]: { string } } = setmetatable({} :: any, { __mode = "k" })
local KIND: { [any]: string } = setmetatable({} :: any, { __mode = "k" })

Json.null = setmetatable({}, {
	__tostring = function()
		return "null"
	end,
})

local KEY_RANK: { [string]: number } = {}
for i, k in ipairs({
	"name",
	"kind",
	"contexts",
	"type",
	"format",
	"enum",
	"items",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"default",
	"summary",
	"actor",
	"description",
	"params",
	"returns",
	"notes",
	"properties",
	"required",
	"additionalProperties",
	"oneOf",
	"source",
}) do
	KEY_RANK[k] = i
end

function Json.ordered<T>(keys: { string }, t: T): T
	ORDER[t] = keys
	KIND[t] = "object"
	return t
end

function Json.array<T>(t: T): T
	KIND[t] = "array"
	return t
end

function Json.object<T>(t: T): T
	KIND[t] = "object"
	return t
end

function Json.isArray(t: any): boolean
	if type(t) ~= "table" then
		return false
	end
	local k = KIND[t]
	if k then
		return k == "array"
	end
	local n = #t
	if n == 0 then
		return false
	end
	local count = 0
	for _ in pairs(t) do
		count += 1
	end
	return count == n
end

function Json.keysOf(t: { [any]: any }): { string }
	local explicit = ORDER[t]
	if explicit then
		local out = {}
		for _, k in ipairs(explicit) do
			if t[k] ~= nil then
				table.insert(out, k)
			end
		end
		return out
	end
	local keys = {}
	for k in pairs(t) do
		table.insert(keys, tostring(k))
	end
	table.sort(keys, function(a, b)
		local ra, rb = KEY_RANK[a], KEY_RANK[b]
		if ra and rb then
			return ra < rb
		elseif ra then
			return true
		elseif rb then
			return false
		end
		return a < b
	end)
	return keys
end

local ESCAPES = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\b"] = "\\b",
	["\f"] = "\\f",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function escapeCodepoint(cp: number): string
	if cp < 0x10000 then
		return string.format("\\u%04x", cp)
	end
	cp -= 0x10000
	return string.format("\\u%04x\\u%04x", 0xD800 + bit32.rshift(cp, 10), 0xDC00 + bit32.band(cp, 0x3FF))
end

function Json.quote(s: string): string
	local parts = { '"' }
	local ok = pcall(function()
		for _, cp in utf8.codes(s) do
			local ch = utf8.char(cp)
			local e = ESCAPES[ch]
			if e then
				table.insert(parts, e)
			elseif cp < 0x20 or cp >= 0x7F then
				if cp == 0x7F then
					table.insert(parts, ch)
				else
					table.insert(parts, escapeCodepoint(cp))
				end
			else
				table.insert(parts, ch)
			end
		end
	end)
	if not ok then
		-- invalid UTF-8: escape bytes individually as latin-1
		parts = { '"' }
		for i = 1, #s do
			local b = string.byte(s, i)
			local ch = string.char(b)
			local e = ESCAPES[ch]
			if e then
				table.insert(parts, e)
			elseif b < 0x20 or b > 0x7F then
				table.insert(parts, escapeCodepoint(b))
			else
				table.insert(parts, ch)
			end
		end
	end
	table.insert(parts, '"')
	return table.concat(parts)
end

function Json.number(n: number): string
	if n ~= n or n == math.huge or n == -math.huge then
		return "null"
	end
	if n == math.floor(n) and math.abs(n) < 2 ^ 53 then
		return string.format("%d", n)
	end
	for _, fmt in ipairs({ "%.14g", "%.15g", "%.16g", "%.17g" }) do
		local s = string.format(fmt, n)
		if tonumber(s) == n then
			return s
		end
	end
	return string.format("%.17g", n)
end

local function encodeValue(v: any, indent: number?, depth: number, out: { string }, seen: { [any]: boolean })
	local t = type(v)
	if v == nil or v == Json.null then
		table.insert(out, "null")
	elseif t == "boolean" then
		table.insert(out, if v then "true" else "false")
	elseif t == "number" then
		table.insert(out, Json.number(v))
	elseif t == "string" then
		table.insert(out, Json.quote(v))
	elseif t == "table" then
		if seen[v] then
			table.insert(out, '"<cycle>"')
			return
		end
		seen[v] = true
		local nl, pad, padIn, kv
		if indent then
			nl = "\n"
			pad = string.rep(" ", indent * depth)
			padIn = string.rep(" ", indent * (depth + 1))
			kv = ": "
		else
			nl, pad, padIn, kv = "", "", "", ":"
		end
		if Json.isArray(v) then
			local n = #v
			if n == 0 then
				table.insert(out, "[]")
			else
				table.insert(out, "[" .. nl)
				for i = 1, n do
					table.insert(out, padIn)
					encodeValue(v[i], indent, depth + 1, out, seen)
					if i < n then
						table.insert(out, ",")
					end
					table.insert(out, nl)
				end
				table.insert(out, pad .. "]")
			end
		else
			local keys = Json.keysOf(v)
			if #keys == 0 then
				table.insert(out, "{}")
			else
				table.insert(out, "{" .. nl)
				for i, k in ipairs(keys) do
					table.insert(out, padIn .. Json.quote(k) .. kv)
					local val = v[k]
					if val == nil then
						-- numeric keys stored as numbers
						val = v[tonumber(k) :: any]
					end
					encodeValue(val, indent, depth + 1, out, seen)
					if i < #keys then
						table.insert(out, ",")
					end
					table.insert(out, nl)
				end
				table.insert(out, pad .. "}")
			end
		end
		seen[v] = nil
	else
		table.insert(out, Json.quote(tostring(v)))
	end
end

--- Encode v as JSON. indent = nil → compact; indent = 2 → Python-style pretty print.
function Json.encode(v: any, indent: number?): string
	local out = {}
	encodeValue(v, indent, 0, out, {})
	return table.concat(out)
end

return Json
