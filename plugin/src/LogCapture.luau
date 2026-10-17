--!nonstrict
--[[
	LogCapture — LogService.MessageOut → `log` events, attributed to the active step.
	Keeps a bounded buffer for log.* conditions and eval logs. Lines starting with "[Stagehand]"
	(the plugin's own diagnostics) or "[Roblox][" (CoreScript loggers) are kept out of the event
	stream so they never fail a step or clutter a report.
]]

local Env = require(script.Parent.Env)
local Signal = require(script.Parent.Signal)

local LogCapture = {}
LogCapture.__index = LogCapture

LogCapture.MAX = 2000
LogCapture.OWN_PREFIX = "[Stagehand]"

function LogCapture.new()
	return setmetatable({
		entries = {},
		base = 0, -- absolute index of entries[1] - 1
		runStart = 1, -- absolute index where the current run started
		runId = nil,
		stepId = nil,
		running = {}, -- step ids in start order, across concurrent segments
		added = Signal.new(),
		onLog = nil, -- function(entry) set by Node
		_conn = nil,
	}, LogCapture)
end

function LogCapture.levelOf(messageType: any): string
	local name = if type(messageType) == "string" then messageType else (messageType and messageType.Name)
	if name == "MessageWarning" then
		return "warn"
	elseif name == "MessageError" then
		return "error"
	end
	return "info"
end

function LogCapture:start()
	local ls = Env.service("LogService")
	if not ls or self._conn then
		return
	end
	local ok, conn = pcall(function()
		return ls.MessageOut:Connect(function(message, messageType)
			self:push(message, LogCapture.levelOf(messageType))
		end)
	end)
	if ok then
		self._conn = conn
	end
end

function LogCapture:stop()
	if self._conn then
		self._conn:Disconnect()
		self._conn = nil
	end
end

-- Prefixes never attributable to the game: our own diagnostics and Roblox's CoreScript loggers
-- (e.g. "[Roblox][CorePackages...UIBlox] FoundationProvider not found" with a 20-line stack).
LogCapture.IGNORED_PREFIXES = { LogCapture.OWN_PREFIX, "[Roblox][" }

function LogCapture:push(message: string, level: string)
	if type(message) ~= "string" then
		return
	end
	for _, prefix in ipairs(LogCapture.IGNORED_PREFIXES) do
		if message:sub(1, #prefix) == prefix then
			return
		end
	end
	local entry = { level = level, message = message, t = Env.clock() * 1000, stepId = self.stepId }
	table.insert(self.entries, entry)
	if #self.entries > LogCapture.MAX then
		table.remove(self.entries, 1)
		self.base += 1
	end
	if self.onLog then
		Env.task().spawn(self.onLog, entry)
	end
	self.added:Fire(entry)
end

--- Mark `stepId` running. Concurrent segments each mark their own step; logs go to the most
--- recently started one that is still running.
function LogCapture:setStep(stepId: string)
	table.insert(self.running, stepId)
	self.stepId = stepId
end

--- Mark `stepId` finished.
function LogCapture:clearStep(stepId: string)
	local i = table.find(self.running, stepId)
	if i then
		table.remove(self.running, i)
	end
	self.stepId = self.running[#self.running]
end

function LogCapture:markRun(runId: string?)
	if runId ~= nil and runId ~= self.runId then
		self.runId = runId
		self.runStart = self:count() + 1
	end
end

function LogCapture:count(): number
	return self.base + #self.entries
end

--- Entries with absolute index >= from.
function LogCapture:since(from: number): { any }
	local out = {}
	for i = math.max(from - self.base, 1), #self.entries do
		table.insert(out, self.entries[i])
	end
	return out
end

function LogCapture:sinceRunStart(): { any }
	return self:since(self.runStart)
end

function LogCapture:clear()
	self.base += #self.entries
	self.entries = {}
	self.runStart = self.base + 1
end

return LogCapture
