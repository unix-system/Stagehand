--!strict
-- Structured errors (docs/protocol.md "Error object"). Thrown as tables and normalised by Runner/Node.

export type ErrorObject = { code: string, message: string, stepId: string?, details: any? }

local Errors = {}

local MARK = {}

function Errors.new(code: string, message: string, details: any?): ErrorObject
	return setmetatable({ code = code, message = message, details = details }, {
		__index = { [MARK] = true },
		__tostring = function(self: any)
			return self.code .. ": " .. self.message
		end,
	}) :: any
end

function Errors.throw(code: string, message: string, details: any?): never
	error(Errors.new(code, message, details), 0)
end

function Errors.is(e: any): boolean
	return type(e) == "table" and type(e.code) == "string" and type(e.message) == "string"
end

--- Normalise anything caught by pcall into a plain ErrorObject (no metatable, JSON-safe).
function Errors.from(e: any, fallbackCode: string?): ErrorObject
	if Errors.is(e) then
		return { code = e.code, message = e.message, details = e.details }
	end
	local msg = tostring(e)
	return { code = fallbackCode or "INTERNAL", message = msg }
end

return Errors
