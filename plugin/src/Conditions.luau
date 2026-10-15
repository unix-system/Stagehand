--!nonstrict
--[[
	Conditions — comparison ops and the signal-first wait loop.

	waitUntil re-evaluates `check` whenever one of the signals returned by `signals()` fires, and at
	least every `pollInterval` (Heartbeat-rate polling, ≤60 Hz, when a predicate has no signals).
	Signals are rebuilt after every evaluation because the instances they hang off can change
	(respawned characters, re-created GUIs).
]]

local Env = if script then require(script.Parent.Env) else require("./Env")
local Errors = if script then require(script.Parent.Errors) else require("./Errors")
local Serialize = if script then require(script.Parent.Serialize) else require("./Serialize")

local Conditions = {}

Conditions.POLL_NO_SIGNALS = 1 / 60
Conditions.POLL_WITH_SIGNALS = 0.25

local function same(a: any, b: any): boolean
	if a == b then
		return true
	end
	local ta, tb = Env.typeof(a), Env.typeof(b)
	if ta == "number" and tb == "number" then
		return math.abs(a - b) <= 1e-6 * math.max(1, math.abs(a), math.abs(b))
	elseif ta == "Instance" and tb == "string" then
		local ok, full = pcall(function()
			return a:GetFullName()
		end)
		return a.Name == b or (ok and full == b)
	elseif ta == "EnumItem" and tb == "string" then
		return a.Name == b or tostring(a) == b
	elseif ta == "EnumItem" and tb == "number" then
		return a.Value == b
	elseif (ta == "Vector3" or ta == "Vector2") and ta == tb then
		return (a - b).Magnitude <= 1e-4
	elseif ta == "nil" or tb == "nil" then
		return false
	end
	-- userdata vs JSON form (Color3 vs "#hex", Vector3 vs [x,y,z], CFrame vs {pos,look}), tables deep
	local sa, sb = Serialize.value(a), Serialize.value(b)
	if type(sa) == "table" and type(sb) == "table" then
		for k, v in pairs(sa) do
			if not same(v, sb[k]) then
				return false
			end
		end
		for k in pairs(sb) do
			if sa[k] == nil then
				return false
			end
		end
		return true
	end
	if type(sa) == "number" and type(sb) == "number" then
		return same(sa, sb)
	end
	return sa == sb
end
Conditions.same = same

local function toNumber(v: any): number?
	if type(v) == "number" then
		return v
	elseif type(v) == "string" then
		return tonumber(v)
	end
	return nil
end

--- Compare actual against expected with op ∈ eq ne gt gte lt lte contains matches.
function Conditions.compare(op: string?, actual: any, expected: any): boolean
	op = op or "eq"
	if op == "eq" then
		return same(actual, expected)
	elseif op == "ne" then
		return not same(actual, expected)
	elseif op == "gt" or op == "gte" or op == "lt" or op == "lte" then
		local a, b = toNumber(actual), toNumber(expected)
		if a == nil or b == nil then
			if type(actual) == "string" and type(expected) == "string" then
				if op == "gt" then
					return actual > expected
				elseif op == "gte" then
					return actual >= expected
				elseif op == "lt" then
					return actual < expected
				end
				return actual <= expected
			end
			return false
		end
		if op == "gt" then
			return a > b
		elseif op == "gte" then
			return a >= b
		elseif op == "lt" then
			return a < b
		end
		return a <= b
	elseif op == "contains" then
		if type(actual) == "string" then
			return string.find(actual, tostring(expected), 1, true) ~= nil
		elseif type(actual) == "table" then
			for _, x in pairs(actual) do
				if same(x, expected) then
					return true
				end
			end
			return false
		end
		return false
	elseif op == "matches" then
		if actual == nil then
			return false
		end
		local ok, res = pcall(string.match, tostring(Serialize.value(actual)), tostring(expected))
		return ok and res ~= nil
	end
	Errors.throw("BAD_PARAMS", "unknown op '" .. tostring(op) .. "'")
end

--- Yield until any of `signals` fires, `maxWait` elapses, or `cancel` (a signal) fires.
function Conditions.waitForWake(signals: { any }, maxWait: number, cancel: any?)
	local task = Env.task()
	local thread = coroutine.running()
	local done = false
	local conns = {}
	local delayThread
	local function finish()
		if done then
			return
		end
		done = true
		for _, c in ipairs(conns) do
			pcall(function()
				c:Disconnect()
			end)
		end
		if delayThread and coroutine.running() ~= delayThread then
			pcall(task.cancel, delayThread)
		end
		task.spawn(thread)
	end
	for _, s in ipairs(signals) do
		local ok, c = pcall(function()
			return s:Connect(finish)
		end)
		if ok and c then
			table.insert(conns, c)
		end
	end
	if cancel then
		local ok, c = pcall(function()
			return cancel:Connect(finish)
		end)
		if ok and c then
			table.insert(conns, c)
		end
	end
	delayThread = task.delay(math.max(maxWait, 0), finish)
	coroutine.yield()
end

export type WaitOptions = {
	timeout: number, -- seconds; 0 = single evaluation
	signals: (() -> { any })?,
	cancelled: (() -> boolean)?,
	cancelSignal: any?,
	pollInterval: number?,
}

--- Evaluate `check` (returns ok, actual) until it returns true or the budget ends.
--- Returns (status, actual, lastError) where status ∈ "passed" | "failed" | "cancelled".
function Conditions.waitUntil(check: () -> (boolean, any), opts: WaitOptions): (string, any, any)
	local deadline = Env.clock() + (opts.timeout or 0)
	local lastActual, lastErr
	while true do
		if opts.cancelled and opts.cancelled() then
			return "cancelled", lastActual, lastErr
		end
		local ok, res, actual = pcall(check)
		if ok then
			lastErr = nil
			lastActual = actual
			if res then
				return "passed", actual, nil
			end
		else
			lastErr = Errors.from(res, "ACTION_ERROR")
			lastActual = { error = lastErr.message }
		end
		local remaining = deadline - Env.clock()
		if remaining <= 0 then
			return "failed", lastActual, lastErr
		end
		local sigs = {}
		if opts.signals then
			local okS, list = pcall(opts.signals)
			if okS and type(list) == "table" then
				sigs = list
			end
		end
		local interval = opts.pollInterval
			or (if #sigs > 0 then Conditions.POLL_WITH_SIGNALS else Conditions.POLL_NO_SIGNALS)
		Conditions.waitForWake(sigs, math.min(interval, remaining), opts.cancelSignal)
	end
end

return Conditions
