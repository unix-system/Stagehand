-- Minimal test harness for Lune (no external deps).
local H = { passed = 0, failed = 0, failures = {} }

local prefix = {}

function H.describe(name: string, fn: () -> ())
	table.insert(prefix, name)
	fn()
	table.remove(prefix)
end

function H.it(name: string, fn: () -> ())
	local full = table.concat(prefix, " > ") .. " > " .. name
	local ok, err = pcall(fn)
	if ok then
		H.passed += 1
	else
		H.failed += 1
		table.insert(H.failures, full .. "\n    " .. tostring(err))
	end
end

local function fmt(v: any): string
	if type(v) == "string" then
		return string.format("%q", v)
	end
	return tostring(v)
end

function H.eq(actual: any, expected: any, msg: string?)
	if actual ~= expected then
		error((msg or "values differ") .. ": expected " .. fmt(expected) .. ", got " .. fmt(actual), 2)
	end
end

function H.truthy(v: any, msg: string?)
	if not v then
		error(msg or ("expected truthy, got " .. fmt(v)), 2)
	end
end

function H.throws(fn: () -> (), code: string?): any
	local ok, err = pcall(fn)
	if ok then
		error("expected an error" .. (if code then " " .. code else ""), 2)
	end
	if code and (type(err) ~= "table" or err.code ~= code) then
		error("expected error code " .. code .. ", got " .. tostring(type(err) == "table" and err.code or err), 2)
	end
	return err
end

--- Deep equality for plain tables (used for catalog parity).
function H.deepEq(a: any, b: any, path: string?): (boolean, string?)
	path = path or "$"
	if type(a) ~= type(b) then
		return false, path .. ": type " .. type(a) .. " vs " .. type(b)
	end
	if type(a) ~= "table" then
		if a == b then
			return true
		end
		return false, path .. ": " .. fmt(a) .. " vs " .. fmt(b)
	end
	for k, v in pairs(a) do
		local ok, why = H.deepEq(v, b[k], path .. "." .. tostring(k))
		if not ok then
			return false, why
		end
	end
	for k in pairs(b) do
		if a[k] == nil then
			return false, path .. "." .. tostring(k) .. ": missing on left"
		end
	end
	return true
end

return H
