--!nonstrict
--[[
	Node — one per DataModel. attach → long-poll → dispatch → result, plus a batched event stream
	(flushed every 50 ms, immediately on step.passed/failed/skipped). docs/protocol.md is the contract.

	  410 on poll/result/events → re-attach (seq restarts at 1, unsent events are dropped)
	  connection failure        → exponential backoff (0.5 s … 10 s), then re-attach
]]

local Env = require(script.Parent.Env)
local Errors = require(script.Parent.Errors)
local Json = require(script.Parent.Json)
local Registry = require(script.Parent.Registry)
local Runner = require(script.Parent.Runner)
local Conditions = require(script.Parent.Conditions)
local Inspect = require(script.Parent.Inspect)
local Serialize = require(script.Parent.Serialize)
local Signal = require(script.Parent.Signal)
local Lua = require(script.Parent.Actions.Lua)

local Node = {}
Node.__index = Node

Node.PROTOCOL_VERSION = 1
Node.FLUSH_INTERVAL = 0.05
Node.MAX_QUEUE = 5000
Node.SESSION_QUIET = 1.5 -- seconds without PlayerAdded before session.ready when the count is unknown

local TERMINAL = { ["step.passed"] = true, ["step.failed"] = true, ["step.skipped"] = true }

local function orNull(v: any): any
	if v == nil then
		return Json.null
	end
	return v
end

function Node.new(opts: { [string]: any })
	local self = setmetatable({
		role = opts.role,
		plugin = opts.plugin,
		transport = opts.transport,
		sessionId = opts.sessionId,
		expectedPlayers = opts.expectedPlayers,
		version = opts.version or "0.1.0",
		logCapture = opts.logCapture,
		launcher = opts.launcher,
		registry = opts.registry or Registry.new(opts.role),
		nodeId = nil,
		playerIndex = nil,
		seq = 0,
		queue = {},
		state = "idle", -- idle | connecting | attached | stopped
		lastError = nil,
		sessionPlayers = nil,
		running = false,
		busy = {},
		statusChanged = Signal.new(),
		eventEmitted = Signal.new(),
		_flushNow = Signal.new(),
		_generation = 0,
	}, Node)
	self.runner = Runner.new(self)
	if self.logCapture then
		self.logCapture.onLog = function(entry)
			self:emit({
				type = "log",
				level = entry.level,
				message = entry.message,
				node = orNull(self.nodeId),
				stepId = orNull(entry.stepId),
			})
		end
	end
	return self
end

function Node:_setState(state: string, err: string?)
	self.state = state
	self.lastError = err
	self.statusChanged:Fire(state, err)
end

-- Events -------------------------------------------------------------------------------------

function Node:emit(event: { [string]: any })
	self.seq += 1
	event.seq = self.seq
	event.t = Env.clock() * 1000
	table.insert(self.queue, event)
	if #self.queue > Node.MAX_QUEUE then
		-- drop the oldest log line first, else the oldest event
		local dropAt = 1
		for i, e in ipairs(self.queue) do
			if e.type == "log" then
				dropAt = i
				break
			end
		end
		table.remove(self.queue, dropAt)
	end
	self.eventEmitted:Fire(event)
	if TERMINAL[event.type] then
		self._flushNow:Fire()
	end
end

function Node:_flushOnce(): boolean
	if #self.queue == 0 or not self.nodeId then
		return true
	end
	local batch = Json.array(table.clone(self.queue))
	local last = batch[#batch].seq
	local status, data = self.transport:request("POST", "/events", { node = self.nodeId, events = batch })
	if status == 200 then
		local ack = (type(data) == "table" and tonumber(data.ack)) or last
		local keep = {}
		for _, e in ipairs(self.queue) do
			if e.seq > ack then
				table.insert(keep, e)
			end
		end
		self.queue = keep
		return true
	elseif status == 410 then
		self:_reattach("events: unknown node")
	end
	return false
end

function Node:_flushLoop(gen: number)
	local task = Env.task()
	while self.running and gen == self._generation do
		local ok = self:_flushOnce()
		if #self.queue == 0 then
			Conditions.waitForWake({ self._flushNow }, Node.FLUSH_INTERVAL, nil)
		else
			task.wait(if ok then Node.FLUSH_INTERVAL else 0.5)
		end
	end
end

-- Attach / poll ------------------------------------------------------------------------------

function Node:_identity(): (string?, number?)
	if self.role ~= "client" then
		return nil, nil
	end
	local players = Env.service("Players")
	local lp = players and players.LocalPlayer
	local t0 = Env.clock()
	while not lp and Env.clock() - t0 < 10 do
		Env.task().wait(0.1)
		lp = players and players.LocalPlayer
	end
	if lp then
		return lp.Name, lp.UserId
	end
	return nil, nil
end

function Node:_attachOnce(): (boolean, string?)
	local g = Env.game()
	local playerName, userId = self:_identity()
	local okId, placeId = pcall(function()
		return g.PlaceId
	end)
	local okName, placeName = pcall(function()
		return g.Name
	end)
	placeId = if okId and type(placeId) == "number" then placeId else 0
	placeName = if okName and type(placeName) == "string" then placeName else ""
	local body = Json.ordered({
		"protocolVersion",
		"role",
		"placeId",
		"placeName",
		"sessionId",
		"playerName",
		"userId",
		"playerIndex",
		"pluginVersion",
		"transport",
	}, {
		protocolVersion = Node.PROTOCOL_VERSION,
		role = self.role,
		placeId = placeId,
		placeName = placeName,
		sessionId = orNull(self.sessionId),
		playerName = orNull(playerName),
		userId = orNull(userId),
		playerIndex = Json.null,
		pluginVersion = self.version,
		transport = self.transport.kind or "http",
	})
	local status, data, err = self.transport:request("POST", "/attach", body)
	if status == 200 and type(data) == "table" and data.nodeId then
		self.nodeId = data.nodeId
		self.playerIndex = data.playerIndex
		if tonumber(data.eventFlushMs) then
			Node.FLUSH_INTERVAL = math.max(0.01, tonumber(data.eventFlushMs) / 1000)
		end
		return true, nil
	end
	if status == 0 then
		return false, err or "connection failed"
	end
	local msg = type(data) == "table" and type(data.error) == "table" and data.error.message or ("HTTP " .. status)
	return false, msg
end

function Node:_attachLoop(): boolean
	local task = Env.task()
	local backoff = 0.5
	self:_setState("connecting", self.lastError)
	while self.running do
		local ok, err = self:_attachOnce()
		if ok then
			-- seq restarts at 1 per attach; unsent events are renumbered after node.ready
			local pending = self.queue
			self.seq = 0
			self.queue = {}
			self:_setState("attached", nil)
			self:emit({
				type = "node.ready",
				role = self.role,
				catalogHash = Registry.hash(self.registry:catalog()),
			})
			for _, e in ipairs(pending) do
				if e.type ~= "node.ready" then
					if e.type == "log" then
						e.node = self.nodeId
					end
					local t = e.t
					self:emit(e)
					e.t = t
				end
			end
			if self.role == "server" and self.sessionId then
				self:_scheduleSessionReady()
			end
			return true
		end
		self:_setState("connecting", err)
		task.wait(backoff)
		backoff = math.min(backoff * 2, 10)
	end
	return false
end

function Node:_reattach(reason: string)
	if self.nodeId == nil then
		return
	end
	self.nodeId = nil
	self.lastError = reason
end

function Node:_pollLoop(gen: number)
	local task = Env.task()
	local failures = 0
	while self.running and gen == self._generation do
		if not self.nodeId then
			if not self:_attachLoop() then
				return
			end
			failures = 0
		end
		local status, data, err = self.transport:request("GET", "/poll?node=" .. tostring(self.nodeId))
		if status == 200 and type(data) == "table" and type(data.command) == "table" then
			failures = 0
			self:_dispatch(data.command)
		elseif status == 204 or status == 200 then
			failures = 0
		elseif status == 410 then
			self:_reattach("poll: unknown node")
		else
			failures += 1
			self:_setState(if status == 0 then "connecting" else self.state, err or ("HTTP " .. tostring(status)))
			if failures >= 3 then
				self:_reattach("poll failed: " .. tostring(err or status))
			else
				task.wait(math.min(0.5 * 2 ^ failures, 10))
			end
		end
	end
end

function Node:start()
	if self.running then
		return
	end
	self.running = true
	self._generation += 1
	local gen = self._generation
	local task = Env.task()
	if self.logCapture then
		self.logCapture:start()
	end
	-- loops restart after an unexpected error instead of silently dying
	local function supervise(name: string, fn: () -> ())
		task.spawn(function()
			while self.running and gen == self._generation do
				local ok, err = pcall(fn)
				if ok then
					return
				end
				Env.warn("[Stagehand] " .. name .. " loop error: " .. tostring(err))
				task.wait(1)
			end
		end)
	end
	supervise("poll", function()
		self:_pollLoop(gen)
	end)
	supervise("flush", function()
		self:_flushLoop(gen)
	end)
end

function Node:stop()
	self.running = false
	self._generation += 1
	self.runner:cancel("all")
	if self.logCapture then
		self.logCapture:stop()
	end
	self:_setState("stopped", nil)
end

-- Results ------------------------------------------------------------------------------------

function Node:_postResult(commandId: string, ok: boolean, payload: any)
	local body = { node = self.nodeId, commandId = commandId, ok = ok }
	if ok then
		body.result = if payload == nil then Json.object({}) else payload
	else
		body.error = payload
	end
	for attempt = 1, 3 do
		local status = self.transport:request("POST", "/result", body)
		if status == 200 or status == 404 then
			return
		elseif status == 410 then
			self:_reattach("result: unknown node")
			return
		end
		Env.task().wait(0.25 * attempt)
	end
end

-- Players ------------------------------------------------------------------------------------

function Node:playerByIndex(index: number?, stepActor: any?): any
	local players = Env.service("Players")
	if not players or not index then
		return nil
	end
	if self.role == "client" then
		local lp = players.LocalPlayer
		if stepActor == nil or stepActor.playerIndex == index then
			return lp
		end
	end
	local entry = self.sessionPlayers and self.sessionPlayers[index]
	if entry then
		local p = (entry.userId and players:GetPlayerByUserId(entry.userId)) or players:FindFirstChild(entry.name)
		if p then
			return p
		end
	end
	return players:GetPlayers()[index]
end

--- The Player a step's actor means on this node (client → LocalPlayer, server → by playerIndex).
function Node:actorPlayer(actor: any?): any
	local players = Env.service("Players")
	if not players then
		return nil
	end
	if self.role == "client" then
		return players.LocalPlayer
	end
	if self.role == "server" and actor and actor ~= Json.null then
		return self:playerByIndex(tonumber(actor.playerIndex), actor)
	end
	return nil
end

--- Resolve an actor name used inside a selector (@p2, @red) to a Player.
function Node:playerFor(name: string, stepActor: any?, actors: any?): any
	if stepActor and stepActor ~= Json.null and stepActor.name == name then
		if self.role == "client" then
			return self:actorPlayer(stepActor)
		end
		return self:playerByIndex(tonumber(stepActor.playerIndex), stepActor)
	end
	local index = type(actors) == "table" and tonumber(actors[name]) or tonumber(name:match("^p(%d+)$"))
	if index then
		return self:playerByIndex(index, if self.role == "client" then stepActor else nil)
	end
	return nil
end

-- session.ready (server node) ----------------------------------------------------------------

function Node:_playersSnapshot(): ({ any }, boolean)
	local players = Env.service("Players")
	local list = Json.array({})
	local allLoaded = true
	if not players then
		return list, true
	end
	local autoLoads = true
	pcall(function()
		autoLoads = players.CharacterAutoLoads
	end)
	for _, p in ipairs(players:GetPlayers()) do
		table.insert(list, Json.ordered({ "name", "userId" }, { name = p.Name, userId = p.UserId }))
		if autoLoads then
			local c = p.Character
			if not (c and c:FindFirstChildOfClass("Humanoid")) then
				allLoaded = false
			end
		end
	end
	return list, allLoaded
end

function Node:onPlayersRequested(count: number)
	if self.expectedPlayers then
		self.expectedPlayers += count
	end
end

function Node:_scheduleSessionReady()
	if self._sessionWatcher then
		self._sessionReadyKey = nil -- force a re-emit after re-attach
		return
	end
	local task = Env.task()
	local players = Env.service("Players")
	local lastChange = Env.clock()
	if players then
		pcall(function()
			players.PlayerAdded:Connect(function()
				lastChange = Env.clock()
			end)
			players.PlayerRemoving:Connect(function()
				lastChange = Env.clock()
			end)
		end)
	end
	self._sessionWatcher = task.spawn(function()
		while self.running do
			local list, loaded = self:_playersSnapshot()
			local enough
			if self.expectedPlayers then
				enough = #list >= self.expectedPlayers
			else
				enough = Env.clock() - lastChange >= Node.SESSION_QUIET
			end
			local keys = {}
			for _, p in ipairs(list) do
				table.insert(keys, tostring(p.userId))
			end
			local key = table.concat(keys, ",")
			if enough and loaded and self.nodeId and key ~= self._sessionReadyKey then
				self._sessionReadyKey = key
				self.sessionPlayers = list
				self:emit({ type = "session.ready", sessionId = self.sessionId, players = list })
			end
			task.wait(0.25)
		end
	end)
end

-- Commands -----------------------------------------------------------------------------------

local handlers = {}

function handlers.ping(_self, _params)
	return { pong = true, t = Env.clock() * 1000 }
end

function handlers.cancel(self, params)
	return { cancelled = self.runner:cancel(params and params.segmentId or "all") }
end

function handlers.catalog(self, _params)
	return { entries = self.registry:catalog() }
end

function handlers.inspect(self, params)
	local ctx = {
		vars = {},
		playerFor = function(name)
			return self:playerFor(name, nil, nil)
		end,
	}
	return Inspect.run(params, ctx)
end

function handlers.eval(self, params)
	local env = (params and params.env) or {}
	local actor = env.actor
	local vars = env.vars or {}
	local ctx = {
		node = self,
		role = self.role,
		vars = vars,
		player = function(required)
			local p = self:actorPlayer(actor)
			if p == nil and required ~= false then
				Errors.throw("RESOLVE_FAILED", "eval: no actor Player on this node")
			end
			return p
		end,
	}
	local from = self.logCapture and (self.logCapture:count() + 1) or 1
	local value = Lua.run(ctx, params.code)
	Env.task().wait() -- let MessageOut deliver prints from the code
	local logs = Json.array({})
	if self.logCapture then
		for _, e in ipairs(self.logCapture:since(from)) do
			table.insert(logs, { level = e.level, message = e.message, t = e.t })
		end
	end
	return { value = orNull(Serialize.value(value)), logs = logs }
end

function handlers.run_segment(self, params)
	return self.runner:runSegment(params or {})
end

function handlers.launch_session(self, params)
	if self.role ~= "edit" or not self.launcher then
		Errors.throw("UNKNOWN_COMMAND", "launch_session is only supported by the edit node")
	end
	return self.launcher:launch(params or {})
end

function handlers.end_session(self, params)
	if self.role == "edit" and self.launcher then
		return self.launcher:stop(params and params.sessionId)
	end
	if self.role ~= "server" then
		Errors.throw("UNKNOWN_COMMAND", "end_session is handled by the server node (edit fallback)")
	end
	local sts = Env.service("StudioTestService")
	local result = params and params.result or "passed"
	-- reply first, then tear the DataModel down
	return { ended = true, via = "EndTest" }, function()
		Env.task().wait(0.3)
		local ok = sts ~= nil and pcall(function()
			sts:EndTest(result)
		end)
		if not ok then
			pcall(function()
				Env.service("RunService"):Stop()
			end)
		end
	end
end

function handlers.add_players(self, params)
	if self.role ~= "server" then
		Errors.throw("UNKNOWN_COMMAND", "add_players is only supported by the server node")
	end
	local count = tonumber(params and params.count)
	if not count or count < 1 or count > 7 then
		Errors.throw("BAD_PARAMS", "count must be 1..7")
	end
	local sts = Env.service("StudioTestService")
	local ok, err = pcall(function()
		sts:AddPlayers(count)
	end)
	if not ok then
		Errors.throw("SESSION_ERROR", "AddPlayers failed: " .. tostring(err))
	end
	self:onPlayersRequested(count)
	return { requested = count }
end

Node.handlers = handlers

local IMMEDIATE = { cancel = true, ping = true }

function Node:_dispatch(command: any)
	local task = Env.task()
	local id, kind = command.id, command.type
	local handler = handlers[kind]
	if not handler then
		task.spawn(function()
			self:_postResult(
				id,
				false,
				{ code = "UNKNOWN_COMMAND", message = "unsupported command " .. tostring(kind) }
			)
		end)
		return
	end
	task.spawn(function()
		if not IMMEDIATE[kind] then
			-- one command at a time per type
			while self.busy[kind] do
				task.wait(0.05)
			end
			self.busy[kind] = true
		end
		local ok, result, after = pcall(handler, self, command.params or {})
		if not IMMEDIATE[kind] then
			self.busy[kind] = nil
		end
		if ok then
			self:_postResult(id, true, result)
			if after then
				task.spawn(after)
			end
		else
			local e = Errors.from(result, if kind == "eval" then "LUA_ERROR" else "INTERNAL")
			self:_postResult(id, false, e)
		end
	end)
end

return Node
