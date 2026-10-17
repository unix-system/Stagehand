--!nonstrict
--[[
	Launcher — edit node only. Starts Studio test sessions with StudioTestService and reports how
	they ended.

	launch_session: write plugin settings Stagehand.Session / Stagehand.SessionPort (fallback channel
	for nodes that cannot read GetTestArgs), then in a new thread call ExecuteRunModeAsync /
	ExecutePlayModeAsync / ExecuteMultiplayerTestAsync(players, args) with
	args = { stagehand = { sessionId, port, mode, players } }, where port is the port of the daemon
	whose edit node received the command, so the session's nodes attach to that daemon only.
	Execute*Async yields until EndTest; the settings are cleared afterwards.

	Run mode simulates inside the edit DataModel (no new DataModel, so no plugin reload): when the
	edit DataModel starts running for a "run" launch, `onRunModeStarted(sessionId, transport)` lets
	init start an in-process server node on the launching node's transport.
]]

local Env = require(script.Parent.Env)
local Errors = require(script.Parent.Errors)
local Signal = require(script.Parent.Signal)

local Launcher = {}
Launcher.__index = Launcher

Launcher.SETTING = "Stagehand.Session"
Launcher.SETTING_PORT = "Stagehand.SessionPort"
Launcher.STOP_GRACE = 10 -- seconds to wait for a stopping test before launch_session fails

function Launcher.new(opts: {
	plugin: any,
	onRunModeStarted: ((string, any) -> ())?,
	onSessionEnded: ((string, boolean, any) -> ())?,
})
	return setmetatable({
		plugin = opts.plugin,
		onRunModeStarted = opts.onRunModeStarted,
		onSessionEnded = opts.onSessionEnded,
		current = nil, -- { sessionId, mode, players, port, startedAt }
		last = nil, -- { sessionId, ok, result, endedAt }
		changed = Signal.new(),
	}, Launcher)
end

function Launcher:_setSetting(sessionId: any, port: any)
	if self.plugin then
		pcall(function()
			self.plugin:SetSetting(Launcher.SETTING, sessionId)
			self.plugin:SetSetting(Launcher.SETTING_PORT, port)
		end)
	end
end

--- `port`/`transport` belong to the edit node that received the command (= the launching daemon).
function Launcher:launch(params: { [string]: any }, port: number?, transport: any?): any
	local sessionId, mode = params.sessionId, params.mode
	local players = tonumber(params.players) or 0
	if type(sessionId) ~= "string" or sessionId == "" then
		Errors.throw("BAD_PARAMS", "launch_session needs sessionId")
	end
	if type(port) ~= "number" then
		Errors.throw("BAD_PARAMS", "launch_session needs the launching daemon's port")
	end
	if mode ~= "run" and mode ~= "play" and mode ~= "multiplayer" then
		Errors.throw("BAD_PARAMS", "mode must be run | play | multiplayer")
	end
	local sts = Env.service("StudioTestService")
	if not sts then
		Errors.throw("SESSION_ERROR", "StudioTestService is not available")
	end
	local rs = Env.service("RunService")
	local function studioRunning(): boolean
		local okRunning, running = pcall(function()
			return rs:IsRunning()
		end)
		return okRunning and running == true
	end
	-- A test that was just ended (stray from a restarted daemon, EndTest, Stop) takes Studio a few
	-- seconds to tear down; wait for that instead of failing on the race.
	local task = Env.task()
	local waitStart = Env.clock()
	while (self.current or studioRunning()) and Env.clock() - waitStart < Launcher.STOP_GRACE do
		task.wait(0.25)
	end
	if self.current then
		Errors.throw(
			"SESSION_ERROR",
			"Studio is already running test session "
				.. self.current.sessionId
				.. " for the daemon on port "
				.. tostring(self.current.port)
				.. "; stop it from that daemon (stop_session) or in Studio"
		)
	end
	if studioRunning() then
		Errors.throw("SESSION_ERROR", "Studio is already running a test; stop it first")
	end

	self:_setSetting(sessionId, port)
	local args = { stagehand = { sessionId = sessionId, port = port, mode = mode, players = players } }
	self.current = { sessionId = sessionId, mode = mode, players = players, port = port, startedAt = os.time() }
	self.changed:Fire()

	-- defer, not spawn, so the handler returns `accepted` before Execute*Async runs at all: it may not
	-- yield promptly (a launch right after a stop once produced no result for 15 s).
	task.defer(function()
		local ok, result = pcall(function()
			if mode == "run" then
				return sts:ExecuteRunModeAsync(args)
			elseif mode == "play" then
				return sts:ExecutePlayModeAsync(args)
			end
			return sts:ExecuteMultiplayerTestAsync(players, args)
		end)
		self:_ended(sessionId, ok, result)
	end)

	if mode == "run" and self.onRunModeStarted then
		task.spawn(function()
			local t0 = os.clock()
			while self.current and self.current.sessionId == sessionId and os.clock() - t0 < 15 do
				if studioRunning() then
					self.onRunModeStarted(sessionId, transport)
					return
				end
				task.wait(0.1)
			end
		end)
	end
	return { accepted = true }
end

function Launcher:_ended(sessionId: string, ok: boolean, result: any)
	local elapsedMs = nil
	if self.current and self.current.sessionId == sessionId then
		elapsedMs = math.floor((os.time() - (self.current.startedAt or os.time())) * 1000)
		self.current = nil
	end
	self:_setSetting(nil, nil)
	self.last = { sessionId = sessionId, ok = ok, result = result, endedAt = os.time(), elapsedMs = elapsedMs }
	self.changed:Fire()
	if ok then
		print("[Stagehand] session " .. sessionId .. " ended: " .. tostring(result))
	else
		warn("[Stagehand] session " .. sessionId .. " failed: " .. tostring(result))
	end
	if self.onSessionEnded then
		self.onSessionEnded(sessionId, ok, result, elapsedMs)
	end
end

--- end_session fallback on the edit node: RunService:Stop(). Only ends Run mode (which simulates in
--- this DataModel); a Play/multiplayer test lives in its own DataModel and ignores it (verified live),
--- so the daemon relies on EndTest from the test's server node for those. The answer says so honestly
--- (`ended = false`) instead of claiming the test stopped.
function Launcher:stop(_sessionId: string?): any
	local current = self.current
	if current and current.mode ~= "run" then
		return {
			ended = false,
			via = "RunService.Stop",
			reason = "Studio is running "
				.. current.mode
				.. " test session "
				.. tostring(current.sessionId)
				.. ", which RunService:Stop() cannot end; EndTest from the test's server node is required (or Stop in Studio)",
		}
	end
	local rs = Env.service("RunService")
	local ok, err = pcall(function()
		rs:Stop()
	end)
	self:_setSetting(nil, nil)
	if not ok then
		Errors.throw("SESSION_ERROR", "RunService:Stop() failed: " .. tostring(err))
	end
	return { ended = true, via = "RunService.Stop" }
end

--- launcher_status: what this (shared) Launcher believes Studio is running, for any daemon.
function Launcher:status(): any
	local function copy(t)
		if not t then
			return nil
		end
		local out = {}
		for k, v in pairs(t) do
			out[k] = if k == "result" then tostring(v) else v
		end
		return out
	end
	return { current = copy(self.current), last = copy(self.last) }
end

return Launcher
