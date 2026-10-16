local H = require("./harness")
local Setup = require("./setup")
local Node = H.require(H.src.Node)
local Json = H.require(H.src.Json)
local serde = require("@lune/serde")
local task = require("@lune/task")

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

-- Scripted fake broker: records requests, answers from queues.
local function fakeTransport()
	local t = { kind = "http", requests = {}, attaches = 0, commands = {}, results = {}, events = {}, polls = 0 }
	function t:request(method, path, body)
		-- round-trip through JSON like the wire does
		local decoded = if body ~= nil then serde.decode("json", Json.encode(body)) else nil
		table.insert(self.requests, { method = method, path = path, body = decoded })
		if path == "/attach" then
			self.attaches += 1
			return 200, { nodeId = "n_" .. self.attaches, playerIndex = nil, pollTimeoutMs = 25000, eventFlushMs = 50 }
		elseif path:sub(1, 5) == "/poll" then
			self.polls += 1
			local cmd = table.remove(self.commands, 1)
			if cmd == "410" then
				return 410, { error = { code = "UNKNOWN_NODE", message = "gone" } }
			elseif cmd then
				return 200, { command = cmd }
			end
			task.wait(0.02)
			return 204, nil
		elseif path == "/result" then
			table.insert(self.results, decoded)
			return 200, { ok = true }
		elseif path == "/events" then
			for _, e in ipairs(decoded.events) do
				table.insert(self.events, e)
			end
			return 200, { ack = decoded.events[#decoded.events].seq }
		end
		return 404, nil
	end
	return t
end

local function waitFor(pred, timeout)
	local t0 = os.clock()
	while not pred() and os.clock() - t0 < (timeout or 2) do
		task.wait(0.02)
	end
	return pred()
end

describe("Node", function()
	it("attaches, dispatches commands, posts results and flushes events; re-attaches on 410", function()
		Setup.world()
		local tr = fakeTransport()
		tr.commands = {
			{ id = "c_1", type = "ping", params = {} },
			{
				id = "c_2",
				type = "run_segment",
				params = {
					runId = "r_1",
					segmentId = "seg_1",
					vars = {},
					steps = {
						{
							id = "steps.0",
							verb = "expect",
							name = "instance.exists",
							params = { target = "Workspace.Map" },
							timeoutMs = 1000,
							soft = false,
						},
					},
				},
			},
			{ id = "c_3", type = "inspect", params = { path = "Workspace.Map", depth = 1, limit = 200 } },
			{ id = "c_4", type = "eval", params = { code = "return 1 + 1", env = {} } },
			{ id = "c_5", type = "launch_session", params = { sessionId = "s", mode = "play", players = 1 } },
			{ id = "c_6", type = "bogus", params = {} },
			{ id = "c_7", type = "catalog", params = {} },
			"410",
		}
		local node = Node.new({ role = "edit", transport = tr, version = "0.1.0" })
		node:start()
		truthy(
			waitFor(function()
				return #tr.results >= 7 and tr.attaches >= 2
			end, 3),
			"results: " .. #tr.results .. " attaches: " .. tr.attaches
		)
		node:stop()

		local attach = tr.requests[1]
		eq(attach.path, "/attach")
		eq(attach.body.protocolVersion, 1)
		eq(attach.body.role, "edit")
		eq(attach.body.transport, "http")
		eq(attach.body.pluginVersion, "0.1.0")

		local byId = {}
		for _, r in ipairs(tr.results) do
			byId[r.commandId] = r
		end
		eq(byId.c_1.result.pong, true)
		eq(byId.c_2.ok, true)
		eq(byId.c_2.result.status, "passed")
		eq(byId.c_2.result.steps[1].status, "passed")
		eq(byId.c_3.result.nodes[1].path, "Workspace.Map")
		eq(#byId.c_3.result.nodes[1].children, 2)
		eq(byId.c_4.result.value, 2)
		eq(byId.c_5.ok, false)
		eq(byId.c_5.error.code, "UNKNOWN_COMMAND") -- no launcher in this test
		eq(byId.c_6.error.code, "UNKNOWN_COMMAND")
		truthy(#byId.c_7.result.entries >= 51, "catalog entries")

		local types = {}
		for _, e in ipairs(tr.events) do
			types[e.type] = (types[e.type] or 0) + 1
		end
		truthy(types["node.ready"] and types["node.ready"] >= 1, "node.ready")
		truthy(types["step.started"] == 1 and types["step.passed"] == 1, "step events")
		eq(tr.events[1].type, "node.ready")
		eq(tr.events[1].seq, 1)
		eq(#tr.events[1].catalogHash, 40)
	end)
end)
