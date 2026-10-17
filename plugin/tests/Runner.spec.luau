local H = require("./harness")
local Setup = require("./setup")
local Runner = H.require(H.src.Runner)
local Registry = H.require(H.src.Registry)
local LogCapture = H.require(H.src.LogCapture)

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

local function fakeNode()
	local node = {
		role = "server",
		registry = Registry.new("server"),
		logCapture = LogCapture.new(),
		events = {},
	}
	function node:emit(e)
		table.insert(self.events, e)
	end
	function node:actorPlayer()
		return nil
	end
	function node:playerFor()
		return nil
	end
	return node
end

local function step(id, verb, name, params, extra)
	local s = {
		id = id,
		verb = verb,
		name = name,
		params = params or {},
		timeoutMs = 1000,
		withinMs = nil,
		soft = false,
		actor = nil,
		label = nil,
		save = nil,
	}
	for k, v in pairs(extra or {}) do
		s[k] = v
	end
	return s
end

local function types(events)
	local out = {}
	for _, e in ipairs(events) do
		table.insert(out, e.type .. (if e.stepId then ":" .. e.stepId else ""))
	end
	return table.concat(out, " ")
end

describe("Runner.runSegment", function()
	it("runs actions, conditions, lua with save and vars", function()
		local _, w = Setup.world()
		local node = fakeNode()
		local runner = Runner.new(node)
		local res = runner:runSegment({
			runId = "r_1",
			segmentId = "seg_1",
			vars = { lamp = "Workspace.Map.Lamps.Lamp2" },
			steps = {
				step(
					"steps.0",
					"do",
					"instance.setAttribute",
					{ target = "Workspace.Map", name = "Night", value = true }
				),
				step(
					"steps.1",
					"expect",
					"instance.attribute",
					{ target = "Workspace.Map", name = "Night", value = true }
				),
				step("steps.2", "do", "instance.addTag", { target = "Workspace.Map.Lamps.*[]", tag = "Lit" }),
				step("steps.3", "wait", "instance.hasTag", { target = "Workspace.Map.Lamps.*[]", tag = "Lit" }),
				step(
					"steps.4",
					"lua",
					nil,
					{ code = "return #game.Workspace.Map.Lamps:GetChildren()" },
					{ save = "n" }
				),
				step("steps.5", "expect", "lua", { code = "return vars.n == 3" }),
				step("steps.6", "expect", "instance.exists", { target = "$lamp" }),
				step("steps.7", "do", "instance.clone", { target = "$lamp", parent = "Workspace", name = "Copy" }, {
					save = "copy",
				}),
				step(
					"steps.8",
					"expect",
					"instance.childCount",
					{ target = "Workspace.Map.Lamps", op = "eq", value = 3 }
				),
			},
		})
		eq(res.status, "passed", types(node.events))
		eq(#res.steps, 9)
		eq(res.vars.n, 3)
		eq(res.vars.copy, "Workspace.Copy")
		eq(res.steps[5].value, 3)
		truthy(w.map:GetAttribute("Night") == true)
		eq(node.events[1].type, "segment.started")
		eq(node.events[#node.events].type, "segment.finished")
	end)

	it("fails with expected/actual, aborts the rest, honours soft and if", function()
		Setup.world()
		local node = fakeNode()
		local runner = Runner.new(node)
		local res = runner:runSegment({
			runId = "r_2",
			segmentId = "seg_2",
			vars = { flag = false },
			steps = {
				step(
					"steps.0",
					"expect",
					"instance.hasTag",
					{ target = "Workspace.Map", tag = "Nope" },
					{ soft = true }
				),
				step("steps.1", "do", "session.wait", { duration = "10ms" }, { ["if"] = "$flag" }),
				step("steps.2", "expect", "instance.hasTag", { target = "Workspace.Map", tag = "Nope" }, {
					withinMs = 100,
				}),
				step("steps.3", "do", "session.wait", { duration = "10ms" }),
				step(
					"steps.4",
					"expect",
					"instance.attribute",
					{ target = "Workspace.Map", name = "Missing", value = true },
					{ soft = true }
				),
			},
		})
		eq(res.status, "failed")
		eq(res.steps[1].status, "failed")
		eq(res.steps[2].status, "skipped")
		eq(res.steps[3].status, "failed")
		eq(res.steps[4].status, "skipped")
		-- the result entry carries the failure details too (protocol.md "Result")
		truthy(res.steps[3].reason:find("within 0.1s"), res.steps[3].reason)
		eq(res.steps[3].expected.tag, "Nope")
		eq(res.steps[3].actual.value, false)
		eq(res.steps[3].error.code, "ASSERTION_FAILED")
		eq(res.steps[1].error.code, "ASSERTION_FAILED")
		-- steps.4 is skipped (aborted by steps.2); run the unset-attribute check in its own segment
		local res2 = runner:runSegment({
			runId = "r_2b",
			segmentId = "seg_2b",
			steps = {
				step("a", "expect", "instance.attribute", { target = "Workspace.Map", name = "Missing", value = true }),
			},
		})
		eq(res2.steps[1].status, "failed")
		eq(res2.steps[1].actual.set, false)
		eq(res2.steps[1].actual.value, nil)
		local failed
		for _, e in ipairs(node.events) do
			if e.type == "step.failed" and e.stepId == "steps.2" then
				failed = e
			end
		end
		truthy(failed, "step.failed event")
		eq(failed.error.code, "ASSERTION_FAILED")
		eq(failed.expected.target, "Workspace.Map")
		eq(failed.expected.tag, "Nope")
		eq(failed.actual.value, false)
		truthy(failed.reason:find("within 0.1s"), failed.reason)
		local reasons = {}
		for _, e in ipairs(node.events) do
			if e.type == "step.skipped" then
				reasons[e.stepId] = e.reason
			end
		end
		eq(reasons["steps.1"], "if")
		eq(reasons["steps.3"], "aborted")
	end)

	it("maps errors to protocol codes", function()
		Setup.world()
		local node = fakeNode()
		local runner = Runner.new(node)
		local res = runner:runSegment({
			segmentId = "seg_3",
			steps = {
				step("a", "do", "nope.nope", {}, { soft = true }),
				step("b", "do", "session.wait", { bogus = 1 }, { soft = true }),
				step("c", "do", "instance.destroy", { target = "Workspace.Missing" }, { soft = true }),
				step("d", "lua", nil, { code = "error('boom')" }, { soft = true }),
				step("e", "wait", "instance.exists", { target = "Workspace.Later" }, { soft = true, timeoutMs = 50 }),
				step("f", "do", "session.wait", { duration = "5s" }, { soft = true, timeoutMs = 50 }),
			},
		})
		local codes = {}
		for _, e in ipairs(node.events) do
			if e.type == "step.failed" then
				codes[e.stepId] = e.error.code
			end
		end
		eq(codes.a, "UNKNOWN_ACTION")
		eq(codes.b, "BAD_PARAMS")
		eq(codes.c, "RESOLVE_FAILED")
		eq(codes.d, "LUA_ERROR")
		eq(codes.e, "TIMEOUT")
		eq(codes.f, "TIMEOUT")
		eq(res.status, "passed") -- all soft
	end)

	it("cancels a running segment", function()
		Setup.world()
		local task = require("@lune/task")
		local node = fakeNode()
		local runner = Runner.new(node)
		task.delay(0.05, function()
			runner:cancel("seg_4")
		end)
		local res = runner:runSegment({
			segmentId = "seg_4",
			steps = {
				step("a", "do", "session.wait", { duration = "5s" }, { timeoutMs = 10000 }),
				step("b", "do", "session.wait", { duration = "5s" }),
			},
		})
		eq(res.status, "cancelled")
		eq(res.steps[1].status, "cancelled")
		eq(res.steps[2].status, "cancelled")
	end)
end)
