--!nonstrict
--[[
	Stagehand plugin entry. Runs in every DataModel Studio loads the plugin into and becomes a node:
	  RunService:IsEdit()   → edit   (launches sessions, dock UI, edit-mode steps)
	  RunService:IsServer() → server (server steps, session.ready, EndTest)
	  RunService:IsClient() → client (client steps, VirtualInput)
	Never errors on load: every Studio-only call is guarded.
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

	local args = if role ~= "edit" then testArgs() else nil
	local sessionId = nil
	if role ~= "edit" then
		sessionId = (args and args.sessionId) or getSetting(Config.SETTING_SESSION)
		if type(sessionId) ~= "string" or sessionId == "" then
			sessionId = nil
		end
	end
	local port = tonumber(args and args.port) or tonumber(getSetting(Config.SETTING_PORT)) or Config.DEFAULT_PORT
	local http = Http.new(port)

	local transport = http
	if role == "client" and Config.USE_REMOTE_RELAY then
		transport = Remote.client()
	elseif role == "server" and Config.USE_REMOTE_RELAY then
		Remote.serve(http)
	end

	local launcher = nil
	local runModeNode = nil
	local node = nil
	if role == "edit" then
		local Launcher = require(script.Launcher)
		launcher = Launcher.new({
			plugin = plugin,
			port = port,
			onRunModeStarted = function(sid)
				-- Run mode simulates in this DataModel: host the session's server node in-process.
				if runModeNode then
					runModeNode:stop()
				end
				runModeNode = Node.new({
					role = "server",
					plugin = plugin,
					transport = http,
					sessionId = sid,
					expectedPlayers = 0,
					version = Config.VERSION,
					logCapture = LogCapture.new(),
				})
				runModeNode:start()
			end,
			onSessionEnded = function(sid, ok, result)
				if runModeNode then
					runModeNode:stop()
					runModeNode = nil
				end
				-- Tell the daemon the test is over (stopped in Studio, EndTest, or Execute*Async errored).
				if node then
					node:emit({
						type = "session.ended",
						sessionId = sid,
						ok = ok,
						reason = if ok then "ended in Studio" else "Studio test failed: " .. tostring(result),
					})
				end
			end,
		})
	end

	node = Node.new({
		role = role,
		plugin = plugin,
		transport = transport,
		sessionId = sessionId,
		expectedPlayers = args and tonumber(args.players) or nil,
		version = Config.VERSION,
		logCapture = LogCapture.new(),
		launcher = launcher,
	})
	node:start()

	if role == "edit" then
		local okUi, err = pcall(function()
			require(script.UI.Dock).new(plugin, node, launcher, port)
		end)
		if not okUi then
			warn("[Stagehand] dock UI unavailable: " .. tostring(err))
		end
	end

	pcall(function()
		plugin.Unloading:Connect(function()
			node:stop()
			if runModeNode then
				runModeNode:stop()
			end
		end)
	end)
end

local ok, err = pcall(main)
if not ok then
	warn("[Stagehand] failed to start: " .. tostring(err))
end
