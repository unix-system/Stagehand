--!nonstrict
--[[
	Stagehand plugin entry. Runs in every DataModel Studio loads the plugin into and becomes a node:
	  RunService:IsEdit()   → edit   (launches sessions, dock UI, edit-mode steps)
	  RunService:IsServer() → server (server steps, session.ready, EndTest)
	  RunService:IsClient() → client (client steps, VirtualInput)
	Never errors on load: every Studio-only call is guarded.

	Several daemons (one per MCP client) may run at once, each on the next free port of the range
	[Stagehand.Port, +PORT_RANGE). The edit DataModel keeps one node per port so every daemon sees this
	Studio; a test session's server/client nodes attach only to the daemon that launched it (its port
	travels in the test args).
]]

local Config = require(script.Config)

local function getSetting(key: string): any
	local ok, v = pcall(function()
		return plugin:GetSetting(key)
	end)
	return if ok then v else nil
end

local function detectRole(): string?
	local ok, role = pcall(function()
		local rs = game:GetService("RunService")
		if rs:IsEdit() then
			return "edit"
		elseif rs:IsServer() then
			return "server"
		elseif rs:IsClient() then
			return "client"
		end
		return nil
	end)
	return if ok then role else nil
end

local function testArgs(): { [string]: any }?
	local ok, args = pcall(function()
		return game:GetService("StudioTestService"):GetTestArgs()
	end)
	if ok and type(args) == "table" and type(args.stagehand) == "table" then
		return args.stagehand
	end
	return nil
end

local function main()
	local role = detectRole()
	if not role then
		return
	end
	local Node = require(script.Node)
	local Http = require(script.Transport.Http)
	local Remote = require(script.Transport.Remote)
	local LogCapture = require(script.LogCapture)

	local basePort = tonumber(getSetting(Config.SETTING_PORT)) or Config.DEFAULT_PORT
	local nodes = {}
	local runModeNode = nil
	-- Shared by every edit node: one "Stagehand Progress" widget per DataModel (widget ids are unique).
	local ui = {}

	if role ~= "edit" then
		local args = testArgs()
		local sessionId = (args and args.sessionId) or getSetting(Config.SETTING_SESSION)
		if type(sessionId) ~= "string" or sessionId == "" then
			sessionId = nil
		end
		-- Attach only to the daemon that launched this session.
		local port = tonumber(args and args.port) or tonumber(getSetting(Config.SETTING_SESSION_PORT)) or basePort
		print(`[Stagehand] {role} node starting (session {sessionId or "none"}, daemon port {port})`)
		local http = Http.new(port)
		local transport = http
		if role == "client" and Config.USE_REMOTE_RELAY then
			transport = Remote.client()
		elseif role == "server" and Config.USE_REMOTE_RELAY then
			Remote.serve(http)
		end
		local node = Node.new({
			role = role,
			plugin = plugin,
			transport = transport,
			sessionId = sessionId,
			expectedPlayers = args and tonumber(args.players) or nil,
			mode = args and args.mode or nil,
			version = Config.VERSION,
			logCapture = LogCapture.new(),
			ui = ui,
		})
		node:start()
		table.insert(nodes, node)
	else
		local Launcher = require(script.Launcher)
		local launcher = Launcher.new({
			plugin = plugin,
			onRunModeStarted = function(sid, transport)
				-- Run mode simulates in this DataModel: host the session's server node in-process,
				-- talking to the daemon that launched it.
				if runModeNode then
					runModeNode:stop()
				end
				runModeNode = Node.new({
					role = "server",
					plugin = plugin,
					transport = transport,
					sessionId = sid,
					expectedPlayers = 0,
					version = Config.VERSION,
					logCapture = LogCapture.new(),
					ui = ui,
				})
				runModeNode:start()
			end,
			onSessionEnded = function(sid, ok, result, elapsedMs)
				if runModeNode then
					runModeNode:stop()
					runModeNode = nil
				end
				-- Tell every daemon the test is over (stopped in Studio, EndTest, or Execute*Async
				-- errored); daemons ignore sessions they did not launch. `result` is what Execute*Async
				-- returned (the EndTest argument, if any) so the daemon can say why it ended.
				for _, node in ipairs(nodes) do
					node:emit({
						type = "session.ended",
						sessionId = sid,
						ok = ok,
						reason = if ok then "ended in Studio" else "Studio test failed: " .. tostring(result),
						result = if result == nil then nil else tostring(result),
						elapsedMs = elapsedMs,
					})
				end
			end,
		})
		for i = 0, Config.PORT_RANGE - 1 do
			local node = Node.new({
				role = "edit",
				plugin = plugin,
				transport = Http.new(basePort + i),
				version = Config.VERSION,
				logCapture = LogCapture.new(),
				launcher = launcher,
				ui = ui,
			})
			node:start()
			table.insert(nodes, node)
		end
		local okUi, err = pcall(function()
			require(script.UI.Dock).new(plugin, nodes, launcher, basePort)
		end)
		if not okUi then
			warn("[Stagehand] dock UI unavailable: " .. tostring(err))
		end
	end

	pcall(function()
		plugin.Unloading:Connect(function()
			for _, node in ipairs(nodes) do
				node:stop()
			end
			if runModeNode then
				runModeNode:stop()
			end
			if ui.progressUI then
				ui.progressUI:destroy()
				ui.progressUI = nil
			end
		end)
	end)
end

local ok, err = pcall(main)
if not ok then
	warn("[Stagehand] failed to start: " .. tostring(err))
end
