--!nonstrict
--[[
	Runner — executes one run_segment (docs/protocol.md) sequentially on this node.

	Per step: `if` skip → step.started → coerce params → action (with timeout) or condition
	(signal-first wait; `wait` = until true within timeoutMs, `expect` = instant or within withinMs)
	→ step.passed / step.failed (reason, expected, actual, error). Non-soft failure aborts the rest
	(step.skipped reason "aborted"). `cancel` flips the segment's cancel flag and fires its signal so
	waits and running actions stop promptly.
]]

local Env = if script then require(script.Parent.Env) else require("./Env")
local Errors = if script then require(script.Parent.Errors) else require("./Errors")
local Json = if script then require(script.Parent.Json) else require("./Json")
local Resolve = if script then require(script.Parent.Resolve) else require("./Resolve")
local Conditions = if script then require(script.Parent.Conditions) else require("./Conditions")
local Serialize = if script then require(script.Parent.Serialize) else require("./Serialize")
local Signal = if script then require(script.Parent.Signal) else require("./Signal")
local Lua = if script then require(script.Parent.Actions.Lua) else require("./Actions/Lua")

local Runner = {}
Runner.__index = Runner

function Runner.new(node)
	return setmetatable({ node = node, active = {} }, Runner)
end

local function ms(seconds: number): number
	return math.floor(seconds * 1000 + 0.5)
end

local function fmtSeconds(s: number): string
	if s >= 1 and s == math.floor(s) then
		return string.format("%ds", s)
	end
	return string.format("%gs", math.floor(s * 1000 + 0.5) / 1000)
end

local function falsy(v: any): boolean
	return v == nil or v == false or v == 0 or v == "" or v == Json.null
end

--- Cancel a segment id or "all". Returns the ids that were running.
function Runner:cancel(segmentId: string): { string }
	local out = Json.array({})
	for id, seg in pairs(self.active) do
		if segmentId == "all" or segmentId == id then
			seg.cancelled = true
			seg.cancelSignal:Fire()
			table.insert(out, id)
		end
	end
	return out
end

--- Run fn in its own thread; stop waiting at the budget or on cancel.
local function runWithBudget(seg, fn: () -> any, seconds: number): (boolean, any)
	local task = Env.task()
	local done, ok, res = false, false, nil
	local doneSignal = Signal.new()
	local worker = task.spawn(function()
		ok, res = pcall(fn)
		done = true
		doneSignal:Fire()
	end)
	if done then
		return ok, res
	end
	local status = Conditions.waitUntil(function()
		return done, nil
	end, {
		timeout = seconds,
		signals = function()
			return { doneSignal }
		end,
		cancelled = function()
			return seg.cancelled
		end,
		cancelSignal = seg.cancelSignal,
		pollInterval = 1,
	})
	if done then
		return ok, res
	end
	pcall(task.cancel, worker)
	if status == "cancelled" then
		return false, Errors.new("CANCELLED", "cancelled")
	end
	return false, Errors.new("TIMEOUT", "action exceeded timeout " .. fmtSeconds(seconds))
end

function Runner:_ctx(seg, step, vars)
	local node = self.node
	local task = Env.task()
	local ctx = {
		node = node,
		role = node.role,
		vars = vars,
		stepId = step.id,
		actor = step.actor,
		budget = (tonumber(step.timeoutMs) or 10000) / 1000,
		cancelSignal = seg.cancelSignal,
		raw = nil,
	}
	ctx.cancelled = function()
		return seg.cancelled
	end
	ctx.playerFor = function(name: string)
		return node:playerFor(name, step.actor, seg.actors)
	end
	ctx.player = function(required: boolean?)
		local p = node:actorPlayer(step.actor)
		if p == nil and required ~= false then
			if step.actor then
				Errors.throw(
					"RESOLVE_FAILED",
					"actor "
						.. tostring(step.actor.name)
						.. " (player "
						.. tostring(step.actor.playerIndex)
						.. ") has no Player on this node"
				)
			end
			Errors.throw("RESOLVE_FAILED", "step needs an actor (`as`) on the " .. node.role .. " node")
		end
		return p
	end
	ctx.character = function()
		local p = ctx.player()
		local c = p.Character
		if not c then
			Errors.throw("RESOLVE_FAILED", p.Name .. " has no character")
		end
		return c
	end
	ctx.humanoid = function()
		local c = ctx.character()
		local h = c:FindFirstChildOfClass("Humanoid")
		if not h then
			Errors.throw("RESOLVE_FAILED", c:GetFullName() .. " has no Humanoid")
		end
		return h
	end
	ctx.resolve = function(sel)
		return Resolve.one(sel, ctx)
	end
	ctx.resolveAll = function(sel, allowEmpty: boolean?)
		return (Resolve.all(sel, ctx, { allowEmpty = allowEmpty }))
	end
	ctx.sleep = function(seconds: number)
		local deadline = Env.clock() + (seconds or 0)
		repeat
			if seg.cancelled then
				Errors.throw("CANCELLED", "cancelled")
			end
			Conditions.waitForWake({}, math.max(0, deadline - Env.clock()), seg.cancelSignal)
		until Env.clock() >= deadline or seg.cancelled
		if seg.cancelled then
			Errors.throw("CANCELLED", "cancelled")
		end
	end
	ctx.frame = function()
		local rs = Env.service("RunService")
		if rs then
			rs.Heartbeat:Wait()
		else
			task.wait()
		end
	end
	return ctx
end

-- expected payload for step.failed: substituted params, selectors shown as resolved paths.
local function expectedOf(ctx, raw: any): any
	local out = {}
	if type(raw) == "table" then
		for k, v in pairs(raw) do
			out[k] = Serialize.value(v)
		end
		for _, key in ipairs({ "target" }) do
			if type(raw[key]) == "string" then
				local ok, inst = pcall(ctx.resolve, raw[key])
				if ok and inst then
					out[key] = Serialize.value(inst)
				end
			end
		end
	end
	if out.value == nil then
		out.value = true
	end
	return Json.object(out)
end

-- Returns (ok, value, failure) where failure = { reason, expected, actual, error }
function Runner:_runStep(seg, step, vars)
	local node = self.node
	local verb = step.verb
	local ctx = self:_ctx(seg, step, vars)
	local timeout = (tonumber(step.timeoutMs) or 10000) / 1000
	local rawParams = step.params or {}

	local function fail(err, reason, expected, actual)
		local e = Errors.from(err, "ACTION_ERROR")
		e.stepId = step.id
		return false,
			nil,
			{
				reason = reason or e.message,
				expected = expected,
				actual = actual,
				error = e,
			}
	end

	if verb == "lua" then
		local okCode, code = pcall(Lua.code, rawParams)
		if not okCode then
			return fail(code)
		end
		local ok, res = runWithBudget(seg, function()
			return Lua.run(ctx, code)
		end, timeout)
		if not ok then
			return fail(Errors.from(res, "LUA_ERROR"))
		end
		return true, res, nil
	end

	if verb ~= "do" and verb ~= "wait" and verb ~= "expect" then
		return fail(Errors.new("BAD_PARAMS", "unknown verb " .. tostring(verb)))
	end

	local name = step.name
	local isLuaCondition = name == "lua" and verb ~= "do"
	local entry = nil
	if not isLuaCondition then
		entry = node.registry:get(name)
		if not entry then
			return fail(
				Errors.new(
					"UNKNOWN_ACTION",
					"unknown " .. (if verb == "do" then "action" else "condition") .. " '" .. tostring(name) .. "'"
				)
			)
		end
		local wantKind = if verb == "do" then "action" else "condition"
		if entry.meta.kind ~= wantKind then
			return fail(
				Errors.new(
					"UNKNOWN_ACTION",
					tostring(name) .. " is a " .. entry.meta.kind .. ", not usable with `" .. verb .. "`"
				)
			)
		end
	end

	ctx.raw = Resolve.substitute(rawParams, vars)
	local params
	if isLuaCondition then
		local okCode, code = pcall(Lua.code, rawParams)
		if not okCode then
			return fail(code)
		end
		params = { code = code }
	else
		local okP, res = pcall(Resolve.applyParams, entry.meta.params, rawParams, vars)
		if not okP then
			return fail(Errors.from(res, "BAD_PARAMS"))
		end
		params = res
	end

	if verb == "do" then
		local ok, res = runWithBudget(seg, function()
			return entry.run(ctx, params)
		end, timeout)
		if not ok then
			return fail(res)
		end
		return true, res, nil
	end

	-- wait / expect
	local check, signals
	if isLuaCondition then
		check = function()
			local v = Lua.run(ctx, params.code)
			return (v ~= nil and v ~= false), { value = Serialize.value(v) }
		end
	else
		check = function()
			return entry.run(ctx, params)
		end
		if entry.signals then
			signals = function()
				return entry.signals(ctx, params)
			end
		end
	end
	local budget
	if verb == "wait" then
		budget = timeout
	elseif step.withinMs ~= nil and step.withinMs ~= Json.null then
		budget = math.min(tonumber(step.withinMs) / 1000, timeout)
	else
		budget = 0
	end
	local status, actual, lastErr = Conditions.waitUntil(check, {
		timeout = budget,
		signals = signals,
		cancelled = ctx.cancelled,
		cancelSignal = seg.cancelSignal,
	})
	if status == "passed" then
		return true, nil, nil
	elseif status == "cancelled" then
		return fail(Errors.new("CANCELLED", "cancelled"))
	end
	local label = "condition " .. tostring(name)
	local reason
	if budget > 0 then
		reason = label .. " not true within " .. fmtSeconds(budget)
	else
		reason = label .. " is false"
	end
	local code
	if lastErr and lastErr.code ~= "ACTION_ERROR" then
		code = lastErr.code
	elseif lastErr then
		code = if isLuaCondition then "LUA_ERROR" else "ACTION_ERROR"
	else
		code = if verb == "wait" then "TIMEOUT" else "ASSERTION_FAILED"
	end
	local message = if lastErr then reason .. ": " .. lastErr.message else reason
	return fail(
		Errors.new(code, message, lastErr and lastErr.details),
		reason,
		expectedOf(ctx, ctx.raw),
		Serialize.value(actual)
	)
end

--- Execute a run_segment command. Returns the protocol result table.
function Runner:runSegment(params: any): any
	local node = self.node
	local segId = params.segmentId or "seg_?"
	local runId = params.runId
	local seg = {
		id = segId,
		runId = runId,
		cancelled = false,
		cancelSignal = Signal.new(),
		actors = params.actors, -- {name → playerIndex}; always sent by the daemon (protocol.md run_segment)
	}
	self.active[segId] = seg
	if node.logCapture then
		node.logCapture:markRun(runId)
	end
	local vars = table.clone(params.vars or {})
	local function ev(t, extra)
		local e = { type = t, runId = runId, segmentId = segId }
		for k, v in pairs(extra or {}) do
			e[k] = v
		end
		node:emit(e)
	end
	ev("segment.started")

	local results = Json.array({})
	local status = "passed"
	local aborted = false
	for _, step in ipairs(params.steps or {}) do
		local stepId = step.id
		if seg.cancelled then
			table.insert(results, { id = stepId, status = "cancelled", durationMs = 0 })
			status = "cancelled"
			continue
		end
		if aborted then
			table.insert(results, { id = stepId, status = "skipped", durationMs = 0 })
			ev("step.skipped", { stepId = stepId, reason = "aborted" })
			continue
		end
		local cond = step["if"]
		if cond ~= nil and cond ~= Json.null then
			local varName = if type(cond) == "string" then (cond:match("^%$([%a_][%w_]*)$") or cond) else nil
			local v = if varName then vars[varName] else cond
			if falsy(v) then
				table.insert(results, { id = stepId, status = "skipped", durationMs = 0 })
				ev("step.skipped", { stepId = stepId, reason = "if" })
				continue
			end
		end

		local t0 = Env.clock()
		ev("step.started", { stepId = stepId })
		if node.logCapture then
			node.logCapture:setStep(stepId)
		end
		local okRun, ok, value, failure = pcall(self._runStep, self, seg, step, vars)
		if not okRun then
			ok, value, failure =
				false, nil, {
					reason = "internal error: " .. tostring(ok),
					error = { code = "INTERNAL", message = tostring(ok), stepId = stepId },
				}
		end
		if node.logCapture then
			node.logCapture:setStep(nil)
		end
		local dur = ms(Env.clock() - t0)

		if ok then
			local entry = { id = stepId, status = "passed", durationMs = dur }
			local extra = { stepId = stepId, durationMs = dur }
			if step.save ~= nil and step.save ~= Json.null then
				local sv = Serialize.value(value)
				vars[step.save] = sv
				entry.value = if sv == nil then Json.null else sv
				extra.value = entry.value
			end
			table.insert(results, entry)
			ev("step.passed", extra)
		elseif failure.error.code == "CANCELLED" or seg.cancelled then
			table.insert(results, { id = stepId, status = "cancelled", durationMs = dur })
			ev("step.failed", {
				stepId = stepId,
				durationMs = dur,
				reason = "cancelled",
				expected = Json.null,
				actual = Json.null,
				error = { code = "CANCELLED", message = "cancelled", stepId = stepId },
			})
			status = "cancelled"
			seg.cancelled = true
		else
			table.insert(results, { id = stepId, status = "failed", durationMs = dur })
			ev("step.failed", {
				stepId = stepId,
				durationMs = dur,
				reason = failure.reason,
				expected = if failure.expected == nil then Json.null else failure.expected,
				actual = if failure.actual == nil then Json.null else failure.actual,
				error = failure.error,
			})
			if not step.soft then
				aborted = true
				status = "failed"
			end
		end
	end

	self.active[segId] = nil
	ev("segment.finished", { status = status })
	local outVars = {}
	for k, v in pairs(vars) do
		outVars[k] = Serialize.value(v)
	end
	return Json.ordered({ "segmentId", "status", "steps", "vars" }, {
		segmentId = segId,
		status = status,
		steps = results,
		vars = Json.object(outVars),
	})
end

return Runner
