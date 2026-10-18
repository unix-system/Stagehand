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

	it("launch_session passes the node's own daemon port and transport to the launcher", function()
		Setup.world()
		local tr = fakeTransport()
		tr.port = 38493
		tr.commands =
			{ { id = "c_1", type = "launch_session", params = { sessionId = "s_9", mode = "play", players = 1 } } }
		local got = nil
		local launcher = {
			launch = function(_self, params, port, transport)
				got = { params = params, port = port, transport = transport }
				return { accepted = true }
			end,
		}
		local node = Node.new({ role = "edit", transport = tr, version = "0.1.0", launcher = launcher })
		node:start()
		truthy(
			waitFor(function()
				return #tr.results >= 1
			end, 2),
			"launch result"
		)
		node:stop()
		eq(tr.results[1].ok, true)
		eq(got.params.sessionId, "s_9")
		eq(got.port, 38493)
		eq(got.transport, tr)
	end)

	-- Fake Players service: the Lune stub has no GetPlayers/PlayerAdded.
	local function fakePlayers(list)
		local signal = {
			Connect = function()
				return { Disconnect = function() end }
			end,
		}
		return {
			CharacterAutoLoads = true,
			PlayerAdded = signal,
			PlayerRemoving = signal,
			GetPlayers = function()
				return list
			end,
		}
	end

	local function sessionReady(tr)
		for _, e in ipairs(tr.events) do
			if e.type == "session.ready" then
				return e
			end
		end
		return nil
	end

	it("server node emits session.ready once every player's character has a Humanoid", function()
		local _, Instance = Setup.dataModel()
		local char = Instance.new("Model")
		Instance.new("Humanoid").Parent = char
		local Env = H.require(H.src.Env)
		Env.override({ ["service:Players"] = fakePlayers({ { Name = "Alice", UserId = 1, Character = char } }) })
		local tr = fakeTransport()
		local node = Node.new({ role = "server", transport = tr, sessionId = "s_1", expectedPlayers = 1 })
		node:start()
		truthy(
			waitFor(function()
				return sessionReady(tr) ~= nil
			end, 2),
			"session.ready emitted"
		)
		node:stop()
		local ev = sessionReady(tr)
		eq(ev.sessionId, "s_1")
		eq(ev.charactersLoaded, true)
		eq(ev.players[1].name, "Alice")
		eq(ev.players[1].userId, 1)
	end)

	-- `character`: what Alice has (nil = no model at all); the graces are shrunk for the test.
	local function graceCase(sessionId: string, character: any, expectAfter: number, notBefore: number)
		local Env = H.require(H.src.Env)
		Env.override({ ["service:Players"] = fakePlayers({ { Name = "Alice", UserId = 1, Character = character } }) })
		local tr = fakeTransport()
		local grace, noGrace = Node.CHARACTER_GRACE, Node.NO_CHARACTER_GRACE
		Node.CHARACTER_GRACE, Node.NO_CHARACTER_GRACE = 0.8, 0.3
		local node = Node.new({ role = "server", transport = tr, sessionId = sessionId, expectedPlayers = 1 })
		local t0 = os.clock()
		node:start()
		task.wait(notBefore)
		eq(sessionReady(tr), nil) -- still inside the grace period
		truthy(
			waitFor(function()
				return sessionReady(tr) ~= nil
			end, 3),
			"session.ready emitted after the grace period"
		)
		node:stop()
		Node.CHARACTER_GRACE, Node.NO_CHARACTER_GRACE = grace, noGrace
		local ev = sessionReady(tr)
		truthy(os.clock() - t0 >= expectAfter, "waited for the grace period")
		eq(ev.charactersLoaded, false)
		eq(ev.players[1].name, "Alice")
		return os.clock() - t0
	end

	it("server node gives up after NO_CHARACTER_GRACE when no character exists (menu-driven spawns)", function()
		Setup.dataModel()
		local took = graceCase("s_2", nil, 0.3, 0.15)
		truthy(took < 0.8, "did not wait the full CHARACTER_GRACE")
	end)

	it("server node waits CHARACTER_GRACE for a character that is still loading", function()
		local _, Instance = Setup.dataModel()
		graceCase("s_3", Instance.new("Model"), 0.8, 0.5) -- a model with no Humanoid yet
	end)
end)
