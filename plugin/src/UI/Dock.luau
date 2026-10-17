--!nonstrict
--[[
	Edit-mode dock widget + toolbar toggle. Shows daemon connection status, the current/last
	session, the last segment result and a live log of step/log events. Purely observational: tests
	are run from the agent via the daemon.
]]

local Config = require(script.Parent.Parent.Config)

local Dock = {}
Dock.__index = Dock

Dock.MAX_LINES = 200

local function themeColor(name: string, fallback: Color3): Color3
	local ok, c = pcall(function()
		return settings().Studio.Theme:GetColor(Enum.StudioStyleGuideColor[name])
	end)
	return if ok and c then c else fallback
end

local function label(parent, name: string, order: number, height: number?): TextLabel
	local l = Instance.new("TextLabel")
	l.Name = name
	l.LayoutOrder = order
	l.Size = UDim2.new(1, 0, 0, height or 18)
	l.BackgroundTransparency = 1
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextTruncate = Enum.TextTruncate.AtEnd
	l.Font = Enum.Font.SourceSans
	l.TextSize = 14
	l.TextColor3 = themeColor("MainText", Color3.fromRGB(220, 220, 220))
	l.Text = ""
	l.Parent = parent
	return l
end

--- `nodes`: every edit node of this DataModel (one per daemon port, see init.server.luau).
function Dock.new(plugin: Plugin, nodes: { any }, launcher: any, basePort: number)
	local self = setmetatable({ nodes = nodes, launcher = launcher, basePort = basePort, lines = 0 }, Dock)

	local toolbar = plugin:CreateToolbar("Stagehand")
	local button = toolbar:CreateButton("Stagehand", "Show the Stagehand dock (daemon status, live log)", Config.LOGO)
	button.ClickableWhenViewportHidden = true

	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 360, 240, 200)
	local widget = plugin:CreateDockWidgetPluginGui("StagehandDock", info)
	widget.Title = "Stagehand"
	self.widget = widget

	button.Click:Connect(function()
		widget.Enabled = not widget.Enabled
	end)
	widget:GetPropertyChangedSignal("Enabled"):Connect(function()
		button:SetActive(widget.Enabled)
	end)

	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = themeColor("MainBackground", Color3.fromRGB(46, 46, 46))
	root.BorderSizePixel = 0
	root.Parent = widget
	local pad = Instance.new("UIPadding")
	pad.PaddingLeft, pad.PaddingRight, pad.PaddingTop = UDim.new(0, 8), UDim.new(0, 8), UDim.new(0, 6)
	pad.Parent = root

	local header = Instance.new("Frame")
	header.Size = UDim2.new(1, 0, 0, 104)
	header.BackgroundTransparency = 1
	header.Parent = root
	local hl = Instance.new("UIListLayout")
	hl.SortOrder = Enum.SortOrder.LayoutOrder
	hl.Parent = header

	local brand = Instance.new("Frame")
	brand.LayoutOrder = 0
	brand.Size = UDim2.new(1, 0, 0, 24)
	brand.BackgroundTransparency = 1
	brand.Parent = header
	local logo = Instance.new("ImageLabel")
	logo.Size = UDim2.fromOffset(20, 20)
	logo.BackgroundTransparency = 1
	logo.Image = Config.LOGO
	logo.ScaleType = Enum.ScaleType.Fit
	logo.Parent = brand
	local name = label(brand, "Title", 0, 20)
	name.Position = UDim2.fromOffset(26, 0)
	name.Size = UDim2.new(1, -26, 0, 20)
	name.Font = Enum.Font.SourceSansBold
	name.TextSize = 16
	name.Text = "Stagehand"

	self.status = label(header, "Status", 1)
	self.session = label(header, "Session", 2)
	self.lastRun = label(header, "LastRun", 3)
	self.current = label(header, "Current", 4)

	local log = Instance.new("ScrollingFrame")
	log.Name = "Log"
	log.Position = UDim2.fromOffset(0, 108)
	log.Size = UDim2.new(1, 0, 1, -114)
	log.BackgroundColor3 = themeColor("InputFieldBackground", Color3.fromRGB(37, 37, 37))
	log.BorderSizePixel = 0
	log.ScrollBarThickness = 6
	log.AutomaticCanvasSize = Enum.AutomaticSize.Y
	log.CanvasSize = UDim2.new()
	log.Parent = root
	local ll = Instance.new("UIListLayout")
	ll.SortOrder = Enum.SortOrder.LayoutOrder
	ll.Parent = log
	self.log = log

	for i, node in ipairs(nodes) do
		node.statusChanged:Connect(function()
			self:refresh()
		end)
		node.eventEmitted:Connect(function(e)
			-- every node captures the same Output; show log lines from the first one only
			if e.type ~= "log" or i == 1 then
				self:onEvent(e, node)
			end
		end)
	end
	if launcher then
		launcher.changed:Connect(function()
			self:refresh()
		end)
	end
	self:refresh()
	return self
end

function Dock:append(text: string, color: Color3?)
	self.lines += 1
	local l = label(self.log, "Line", self.lines)
	l.TextTruncate = Enum.TextTruncate.None
	l.TextWrapped = true
	l.AutomaticSize = Enum.AutomaticSize.Y
	l.Size = UDim2.new(1, -8, 0, 0)
	l.Font = Enum.Font.Code
	l.TextSize = 12
	l.Text = text
	if color then
		l.TextColor3 = color
	end
	local children = self.log:GetChildren()
	local count = 0
	for _, c in ipairs(children) do
		if c:IsA("TextLabel") then
			count += 1
		end
	end
	if count > Dock.MAX_LINES then
		local oldest
		for _, c in ipairs(children) do
			if c:IsA("TextLabel") and (not oldest or c.LayoutOrder < oldest.LayoutOrder) then
				oldest = c
			end
		end
		if oldest then
			oldest:Destroy()
		end
	end
	self.log.CanvasPosition = Vector2.new(0, 1e6)
end

function Dock:refresh()
	local attached = {}
	local stopped = 0
	for _, node in ipairs(self.nodes) do
		if node.state == "attached" then
			table.insert(attached, ":" .. tostring(node.transport.port) .. " (" .. tostring(node.nodeId) .. ")")
		elseif node.state == "stopped" then
			stopped += 1
		end
	end
	local range = ":" .. self.basePort .. "–:" .. (self.basePort + #self.nodes - 1)
	if #attached > 0 then
		self.status.Text = "Daemons: " .. table.concat(attached, ", ")
		self.status.TextColor3 = Color3.fromRGB(90, 200, 120)
	elseif stopped == #self.nodes then
		self.status.Text = "Daemons: stopped"
		self.status.TextColor3 = Color3.fromRGB(200, 90, 90)
	else
		self.status.Text = "Daemons: none yet · scanning 127.0.0.1" .. range
		self.status.TextColor3 = Color3.fromRGB(230, 180, 60)
	end
	local l = self.launcher
	if l and l.current then
		self.session.Text = string.format(
			"Session: %s (%s, %d players) running",
			l.current.sessionId,
			l.current.mode,
			l.current.players
		)
	elseif l and l.last then
		self.session.Text =
			string.format("Session: none · last %s %s", l.last.sessionId, if l.last.ok then "ended" else "failed")
	else
		self.session.Text = "Session: none"
	end
	if self.lastRun.Text == "" then
		self.lastRun.Text = "Last segment: —"
	end
end

local COLORS = {
	["step.passed"] = Color3.fromRGB(90, 200, 120),
	["step.failed"] = Color3.fromRGB(230, 90, 90),
	["step.skipped"] = Color3.fromRGB(150, 150, 150),
	warn = Color3.fromRGB(230, 180, 60),
	error = Color3.fromRGB(230, 90, 90),
}

function Dock:onEvent(e, node)
	local t = e.type
	if t == "segment.started" then
		self.current.Text = "Running " .. tostring(e.segmentId) .. " of " .. tostring(e.runId)
	elseif t == "segment.finished" then
		self.current.Text = ""
		self.lastRun.Text = "Last segment: "
			.. tostring(e.segmentId)
			.. " "
			.. tostring(e.status)
			.. " ("
			.. tostring(e.runId)
			.. ")"
	elseif t == "step.started" then
		self.current.Text = "Step " .. tostring(e.stepId)
	elseif t == "step.passed" then
		self:append(string.format("✓ %s (%d ms)", e.stepId, e.durationMs or 0), COLORS[t])
	elseif t == "step.failed" then
		self:append(string.format("✗ %s: %s", e.stepId, tostring(e.reason)), COLORS[t])
	elseif t == "step.skipped" then
		self:append(string.format("– %s skipped (%s)", e.stepId, tostring(e.reason)), COLORS[t])
	elseif t == "log" then
		self:append(e.message, COLORS[e.level])
	elseif t == "node.ready" then
		self:append("attached to :" .. tostring(node.transport.port) .. " as " .. tostring(node.nodeId))
	end
end

return Dock
