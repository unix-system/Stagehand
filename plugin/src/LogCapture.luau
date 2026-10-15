--!nonstrict
--[[
	LogCapture — LogService.MessageOut → `log` events, attributed to the active step.
	Keeps a bounded buffer for log.* conditions and eval logs. Lines starting with "[Stagehand]"
	(the plugin's own diagnostics) are kept out of the event stream so they never fail a step.
]]

local Env = if script then require(script.Parent.Env) else require("./Env")
local Signal = if script then require(script.Parent.Signal) else require("./Signal")

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

function LogCapture:push(message: string, level: string)
	if type(message) ~= "string" or message:sub(1, #LogCapture.OWN_PREFIX) == LogCapture.OWN_PREFIX then
		return
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

function LogCapture:setStep(stepId: string?)
	self.stepId = stepId
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
