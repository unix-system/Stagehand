-- run-in-roblox plugin (Stagehand fork). Generated: {{PORT}} / {{SERVER_ID}} / {{HOLD}} are filled in
-- by the launcher. Protocol (unchanged from upstream rojo-rbx/run-in-roblox 0.3.0):
--   GET  /          -> server id (abort silently if it does not match ours)
--   POST /start     -> we are alive and plugins have loaded
--   POST /messages  -> JSON array of { type = "Output", level, body }
--   POST /stop      -> the script finished (never sent in hold mode)
local PORT = "{{PORT}}"
local SERVER_ID = "{{SERVER_ID}}"
local HOLD = {{HOLD}}

local SERVER_URL = string.format("http://127.0.0.1:%s", PORT)

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")

local pingSuccess, remoteServerId = pcall(function()
	return HttpService:GetAsync(SERVER_URL)
end)

-- If there was a transport error, just abort silently.
--
-- It's possible that the run-in-roblox plugin is erroneously installed, and we
-- should minimize our impact to the user.
if not pingSuccess then
	return
end

-- There is a server running on that port, but it isn't the right run-in-roblox
-- server and might be some other HTTP server.
if remoteServerId ~= SERVER_ID then
	return
end

local queuedMessages = {}
local timeSinceLastSend = 0
local messageSendRate = 0.1

local function flushMessages()
	if #queuedMessages == 0 then
		return
	end

	local encoded = HttpService:JSONEncode(queuedMessages)
	queuedMessages = {}

	timeSinceLastSend = 0
	pcall(HttpService.PostAsync, HttpService, SERVER_URL .. "/messages", encoded)
end

local heartbeatConnection = RunService.Heartbeat:Connect(function(dt)
	timeSinceLastSend = timeSinceLastSend + dt

	if timeSinceLastSend >= messageSendRate then
		flushMessages()
	end
end)

local logTypeToLevel = {
	[Enum.MessageType.MessageOutput] = "Print",
	[Enum.MessageType.MessageInfo] = "Info",
	[Enum.MessageType.MessageWarning] = "Warning",
	[Enum.MessageType.MessageError] = "Error",
}

local logConnection = LogService.MessageOut:Connect(function(body, messageType)
	table.insert(queuedMessages, {
		type = "Output",
		level = logTypeToLevel[messageType] or "Info",
		body = body,
	})
end)

HttpService:PostAsync(SERVER_URL .. "/start", "")

if HOLD then
	-- Hold mode: an external driver (e.g. the Stagehand daemon) talks to its own plugin; we only keep
	-- relaying Studio output until the launcher kills Studio.
	return
end

local loadSuccess, messageOrMain = xpcall(require, debug.traceback, script.Main)

if not loadSuccess then
	local sacrificialEvent = Instance.new("BindableEvent")
	sacrificialEvent.Event:Connect(function()
		error(messageOrMain, 0)
	end)
	sacrificialEvent:Fire()
end

local mainSuccess, message = xpcall(messageOrMain, debug.traceback)

if not mainSuccess then
	local sacrificialEvent = Instance.new("BindableEvent")
	sacrificialEvent.Event:Connect(function()
		error(message, 0)
	end)
	sacrificialEvent:Fire()
end

-- Wait for any remaining messages to be sent to LogService, then flush them
-- explicitly.
task.wait(2 * messageSendRate)
heartbeatConnection:Disconnect()
logConnection:Disconnect()

flushMessages()

HttpService:PostAsync(SERVER_URL .. "/stop", "")
