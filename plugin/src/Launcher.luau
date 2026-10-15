--!nonstrict
--[[
	Launcher — edit node only. Starts Studio test sessions with StudioTestService and reports how
	they ended.

	launch_session: write plugin setting Stagehand.Session (fallback channel for nodes that cannot
	read GetTestArgs), then in a new thread call ExecuteRunModeAsync / ExecutePlayModeAsync /
	ExecuteMultiplayerTestAsync(players, args) with args = { stagehand = { sessionId, port, mode,
	players } }. Execute*Async yields until EndTest; the setting is cleared afterwards.

	Run mode simulates inside the edit DataModel (no new DataModel, so no plugin reload): when the
	edit DataModel starts running for a "run" launch, `onRunModeStarted(sessionId)` lets init start
	an in-process server node.
]]

local Env = if script then require(script.Parent.Env) else require("./Env")
local Errors = if script then require(script.Parent.Errors) else require("./Errors")
local Signal = if script then require(script.Parent.Signal) else require("./Signal")

local Launcher = {}
Launcher.__index = Launcher

Launcher.SETTING = "Stagehand.Session"

function Launcher.new(opts: {
	plugin: any,
	port: number,
	onRunModeStarted: ((string) -> ())?,
	onSessionEnded: ((string, boolean, any) -> ())?,
})
	return setmetatable({
		plugin = opts.plugin,
		port = opts.port,
		onRunModeStarted = opts.onRunModeStarted,
		onSessionEnded = opts.onSessionEnded,
		current = nil, -- { sessionId, mode, players, startedAt }
		last = nil, -- { sessionId, ok, result, endedAt }
		changed = Signal.new(),
	}, Launcher)
end

function Launcher:_setSetting(value: any)
	if self.plugin then
		pcall(function()
			self.plugin:SetSetting(Launcher.SETTING, value)
		end)
	end
end

function Launcher:launch(params: { [string]: any }): any
	local sessionId, mode = params.sessionId, params.mode
	local players = tonumber(params.players) or 0
	if type(sessionId) ~= "string" or sessionId == "" then
		Errors.throw("BAD_PARAMS", "launch_session needs sessionId")
	end
	if mode ~= "run" and mode ~= "play" and mode ~= "multiplayer" then
		Errors.throw("BAD_PARAMS", "mode must be run | play | multiplayer")
	end
	if self.current then
		Errors.throw("SESSION_ERROR", "a session is already running: " .. self.current.sessionId)
	end
	local sts = Env.service("StudioTestService")
	if not sts then
		Errors.throw("SESSION_ERROR", "StudioTestService is not available")
	end
	local rs = Env.service("RunService")
	local okRunning, running = pcall(function()
		return rs:IsRunning()
	end)
	if okRunning and running then
		Errors.throw("SESSION_ERROR", "Studio is already running a test; stop it first")
	end

	self:_setSetting(sessionId)
	local args = { stagehand = { sessionId = sessionId, port = self.port, mode = mode, players = players } }
	self.current = { sessionId = sessionId, mode = mode, players = players, startedAt = os.time() }
	self.changed:Fire()

	local task = Env.task()
	task.spawn(function()
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
				local okR, isRunning = pcall(function()
					return rs:IsRunning()
				end)
				if okR and isRunning then
					self.onRunModeStarted(sessionId)
					return
				end
				task.wait(0.1)
			end
		end)
	end
	return { accepted = true }
end

function Launcher:_ended(sessionId: string, ok: boolean, result: any)
	if self.current and self.current.sessionId == sessionId then
		self.current = nil
	end
	self:_setSetting(nil)
	self.last = { sessionId = sessionId, ok = ok, result = result, endedAt = os.time() }
	self.changed:Fire()
	if ok then
		print("[Stagehand] session " .. sessionId .. " ended: " .. tostring(result))
	else
		warn("[Stagehand] session " .. sessionId .. " failed: " .. tostring(result))
	end
	if self.onSessionEnded then
		self.onSessionEnded(sessionId, ok, result)
	end
end

--- end_session fallback on the edit node: RunService:Stop().
function Launcher:stop(_sessionId: string?): any
	local rs = Env.service("RunService")
	local ok, err = pcall(function()
		rs:Stop()
	end)
	self:_setSetting(nil)
	if not ok then
		Errors.throw("SESSION_ERROR", "RunService:Stop() failed: " .. tostring(err))
	end
	return { ended = true, via = "RunService.Stop" }
end

return Launcher
