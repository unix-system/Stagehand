--!nonstrict
--[[
	"Stagehand Progress" dock widget, one per Studio window of a test: the edit node's covers the
	main window, and each multiplayer client node shows its own (steps it runs are marked YOU). The
	daemon pushes a snapshot with the `progress` command (docs/protocol.md); this shows the run name
	and status, a progress bar, a per-client summary (Server / P1 / P2 …) and the step list tagged with
	where each step runs, with failure reasons inline. Nothing is drawn in the game. The widget opens
	itself when a new run starts.

	Live feedback: the running step pulses, counts its elapsed time against its budget (a thin bar that
	turns amber past 75 %), and finished steps show their duration. In a client window the runs of steps
	that execute elsewhere (server, other players) fold into one clickable group row each; the group
	holding the running or first failed step expands itself. "All / Mine" in the header turns that off.

	All layout decisions live in ProgressModel (pure, unit-tested); this file only draws them.
]]

local Env = require(script.Parent.Parent.Env)
local Model = require(script.Parent.ProgressModel)

local Progress = {}
Progress.__index = Progress

local C = {
	bg = Color3.fromRGB(20, 22, 27),
	row = Color3.fromRGB(255, 255, 255),
	text = Color3.fromRGB(236, 238, 242),
	muted = Color3.fromRGB(148, 154, 166),
	running = Color3.fromRGB(86, 156, 255),
	passed = Color3.fromRGB(64, 196, 120),
	failed = Color3.fromRGB(240, 88, 88),
	skipped = Color3.fromRGB(110, 116, 128),
	warn = Color3.fromRGB(240, 170, 60),
	track = Color3.fromRGB(52, 56, 66),
}
C.pending = C.muted
C.cancelled = C.skipped
C.error = C.failed

local RUN_LABEL = {
	running = "Running",
	passed = "Passed",
	failed = "Failed",
	cancelled = "Cancelled",
	error = "Error",
}

local HEADER_H = 96 -- header + title + subtitle + summary + bar, incl. padding
local PULSE_PERIOD = 0.9

local function new(className: string, props: { [string]: any }, children: { Instance }?): Instance
	local inst = Instance.new(className)
	for k, v in pairs(props) do
		if k ~= "Parent" then
			inst[k] = v
		end
	end
	for _, c in ipairs(children or {}) do
		c.Parent = inst
	end
	inst.Parent = props.Parent
	return inst
end

local function corner(r: number): UICorner
	return new("UICorner", { CornerRadius = UDim.new(0, r) }) :: UICorner
end

local function text(props: { [string]: any }): TextLabel
	props.BackgroundTransparency = 1
	props.Font = props.Font or Enum.Font.GothamMedium
	props.TextColor3 = props.TextColor3 or C.text
	props.TextXAlignment = props.TextXAlignment or Enum.TextXAlignment.Left
	return new("TextLabel", props) :: TextLabel
end

local function hex(c: Color3): string
	return c:ToHex()
end

-- Re-export the pure helpers so existing callers (and tests) keep working.
Progress.tag = Model.tag
Progress.summarize = Model.summarize

function Progress.new(plugin: Plugin)
	local self = setmetatable({
		rows = {}, -- step rows by step index
		groups = {}, -- group rows by group key
		runId = nil,
		expanded = {}, -- group key → boolean (user choice for this run)
		showAll = false, -- "All": never fold other targets
		snapshot = nil,
		receivedAt = 0, -- os.clock() when the snapshot arrived (elapsed counters count on from it)
		mine = nil,
		heartbeat = nil,
		pulseTween = nil,
		pillTween = nil,
	}, Progress)
	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 460, 260, 220)
	self.widget = plugin:CreateDockWidgetPluginGui("StagehandProgress", info)
	self.widget.Title = "Stagehand Progress"
	self.widget.Name = "StagehandProgress"

	local root = new("Frame", {
		Size = UDim2.fromScale(1, 1),
		BackgroundColor3 = C.bg,
		BorderSizePixel = 0,
		Parent = self.widget,
	}, {
		new("UIPadding", {
			PaddingLeft = UDim.new(0, 12),
			PaddingRight = UDim.new(0, 12),
			PaddingTop = UDim.new(0, 10),
			PaddingBottom = UDim.new(0, 10),
		}),
	})

	local head = new("Frame", {
		Size = UDim2.new(1, 0, 0, HEADER_H - 10),
		BackgroundTransparency = 1,
		Parent = root,
	}, { new("UIListLayout", { SortOrder = Enum.SortOrder.LayoutOrder, Padding = UDim.new(0, 5) }) })

	local brand =
		new("Frame", { Size = UDim2.new(1, 0, 0, 18), BackgroundTransparency = 1, LayoutOrder = 1, Parent = head })
	text({
		Text = "STAGEHAND",
		TextSize = 11,
		TextColor3 = C.muted,
		Font = Enum.Font.GothamBold,
		Size = UDim2.fromScale(0.5, 1),
		Parent = brand,
	})
	self.pill = new("TextLabel", {
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.fromScale(1, 0.5),
		Size = UDim2.fromOffset(0, 18),
		AutomaticSize = Enum.AutomaticSize.X,
		BackgroundColor3 = C.muted,
		BackgroundTransparency = 0.8,
		Font = Enum.Font.GothamBold,
		TextSize = 11,
		TextColor3 = C.muted,
		Text = "Idle",
		Parent = brand,
	}, { corner(9), new("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8) }) }) :: TextLabel
	-- "All / Mine" toggle, shown only in client windows (where folding applies)
	self.scopeButton = new("TextButton", {
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -62, 0.5, 0),
		Size = UDim2.fromOffset(0, 18),
		AutomaticSize = Enum.AutomaticSize.X,
		BackgroundColor3 = C.track,
		Font = Enum.Font.GothamBold,
		TextSize = 10,
		TextColor3 = C.muted,
		Text = "MINE",
		Visible = false,
		Parent = brand,
	}, { corner(9), new("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8) }) }) :: TextButton
	self.scopeButton.Activated:Connect(function()
		self.showAll = not self.showAll
		self:_render()
	end)

	self.title = text({
		Text = "No run yet",
		TextSize = 15,
		Font = Enum.Font.GothamBold,
		Size = UDim2.new(1, 0, 0, 18),
		TextTruncate = Enum.TextTruncate.AtEnd,
		LayoutOrder = 2,
		Parent = head,
	})
	self.subtitle = text({
		Text = "Runs started by the agent show up here.",
		TextSize = 12,
		TextColor3 = C.muted,
		Font = Enum.Font.Gotham,
		Size = UDim2.new(1, 0, 0, 14),
		TextTruncate = Enum.TextTruncate.AtEnd,
		LayoutOrder = 3,
		Parent = head,
	})
	self.summary = text({
		Text = "",
		RichText = true,
		TextSize = 11,
		Font = Enum.Font.GothamBold,
		TextColor3 = C.muted,
		Size = UDim2.new(1, 0, 0, 14),
		TextTruncate = Enum.TextTruncate.AtEnd,
		LayoutOrder = 4,
		Parent = head,
	})
	local track = new(
		"Frame",
		{ Size = UDim2.new(1, 0, 0, 4), BackgroundColor3 = C.track, LayoutOrder = 5, Parent = head },
		{ corner(2) }
	)
	self.bar = new(
		"Frame",
		{ Size = UDim2.fromScale(0, 1), BackgroundColor3 = C.running, Parent = track },
		{ corner(2) }
	)

	self.list = new("ScrollingFrame", {
		Name = "Steps",
		Position = UDim2.fromOffset(0, HEADER_H),
		Size = UDim2.new(1, 0, 1, -HEADER_H),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ScrollBarThickness = 4,
		ScrollBarImageColor3 = C.muted,
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		CanvasSize = UDim2.new(),
		Parent = root,
	}, { new("UIListLayout", { SortOrder = Enum.SortOrder.LayoutOrder, Padding = UDim.new(0, 2) }) }) :: ScrollingFrame

	return self
end

-- Rows -----------------------------------------------------------------------------------------

function Progress:_row(i: number)
	local row = self.rows[i]
	if row then
		return row
	end
	local frame = new("Frame", {
		Size = UDim2.new(1, -6, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = C.row,
		BackgroundTransparency = 1,
		Parent = self.list,
	}, {
		corner(6),
		new("UIPadding", {
			PaddingLeft = UDim.new(0, 6),
			PaddingRight = UDim.new(0, 6),
			PaddingTop = UDim.new(0, 4),
			PaddingBottom = UDim.new(0, 4),
		}),
	})
	local dot = new(
		"Frame",
		{ Position = UDim2.fromOffset(0, 4), Size = UDim2.fromOffset(8, 8), Parent = frame },
		{ corner(4) }
	)
	local dotStroke = new("UIStroke", { Thickness = 1.5, Parent = dot })
	local label = text({
		Position = UDim2.fromOffset(16, 0),
		Size = UDim2.new(1, -110, 0, 16),
		TextSize = 12,
		Font = Enum.Font.Gotham,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = frame,
	})
	-- elapsed / duration, right of the label, left of the tag
	local time = text({
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -50, 0, 0),
		Size = UDim2.fromOffset(60, 16),
		TextSize = 10,
		Font = Enum.Font.Code,
		TextColor3 = C.muted,
		TextXAlignment = Enum.TextXAlignment.Right,
		Parent = frame,
	})
	local tag = text({
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.fromScale(1, 0),
		Size = UDim2.fromOffset(46, 16),
		TextSize = 10,
		Font = Enum.Font.GothamBold,
		TextXAlignment = Enum.TextXAlignment.Right,
		Parent = frame,
	})
	-- budget bar under the label while the step runs
	local budgetTrack = new("Frame", {
		Position = UDim2.fromOffset(16, 17),
		Size = UDim2.new(1, -16, 0, 2),
		BackgroundColor3 = C.track,
		BorderSizePixel = 0,
		Visible = false,
		Parent = frame,
	}, { corner(1) })
	local budget = new(
		"Frame",
		{ Size = UDim2.fromScale(0, 1), BackgroundColor3 = C.running, BorderSizePixel = 0, Parent = budgetTrack },
		{ corner(1) }
	)
	local reason = text({
		Position = UDim2.fromOffset(16, 20),
		Size = UDim2.new(1, -16, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		TextSize = 11,
		Font = Enum.Font.Gotham,
		TextColor3 = C.failed,
		TextWrapped = true,
		Visible = false,
		Parent = frame,
	})
	row = {
		frame = frame,
		dot = dot,
		dotStroke = dotStroke,
		label = label,
		time = time,
		tag = tag,
		budgetTrack = budgetTrack,
		budget = budget,
		reason = reason,
	}
	self.rows[i] = row
	return row
end

function Progress:_groupRow(key: string)
	local row = self.groups[key]
	if row then
		return row
	end
	local frame = new("TextButton", {
		Size = UDim2.new(1, -6, 0, 24),
		BackgroundColor3 = C.row,
		BackgroundTransparency = 0.96,
		Text = "",
		AutoButtonColor = false,
		Parent = self.list,
	}, {
		corner(6),
		new("UIPadding", {
			PaddingLeft = UDim.new(0, 6),
			PaddingRight = UDim.new(0, 6),
			PaddingTop = UDim.new(0, 4),
			PaddingBottom = UDim.new(0, 4),
		}),
	}) :: TextButton
	local chevron = text({
		Position = UDim2.fromOffset(0, 0),
		Size = UDim2.fromOffset(12, 16),
		TextSize = 11,
		Font = Enum.Font.GothamBold,
		TextColor3 = C.muted,
		Text = "▸",
		Parent = frame,
	})
	local dot = new(
		"Frame",
		{ Position = UDim2.fromOffset(14, 4), Size = UDim2.fromOffset(8, 8), Parent = frame },
		{ corner(4) }
	)
	local dotStroke = new("UIStroke", { Thickness = 1.5, Parent = dot })
	local label = text({
		Position = UDim2.fromOffset(30, 0),
		Size = UDim2.new(1, -30, 0, 16),
		TextSize = 11,
		Font = Enum.Font.Gotham,
		TextColor3 = C.muted,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = frame,
	})
	frame.Activated:Connect(function()
		local cur = self.expanded[key]
		if cur == nil then
			cur = self._autoExpanded and self._autoExpanded[key] or false
		end
		self.expanded[key] = not cur
		self:_render()
	end)
	row = { frame = frame, chevron = chevron, dot = dot, dotStroke = dotStroke, label = label }
	self.groups[key] = row
	return row
end

-- Live effects -----------------------------------------------------------------------------------

local function tweenService()
	local ok, ts = pcall(function()
		return game:GetService("TweenService")
	end)
	return if ok then ts else nil
end

function Progress:_pulse(dot: Instance?, color: Color3?)
	if self.pulseTween then
		pcall(function()
			self.pulseTween:Cancel()
		end)
		self.pulseTween = nil
	end
	if self.pulseTarget and self.pulseTarget ~= dot then
		pcall(function()
			self.pulseTarget.BackgroundTransparency = 0
			self.pulseTarget.Size = UDim2.fromOffset(8, 8)
		end)
	end
	self.pulseTarget = dot
	local ts = tweenService()
	if not dot or not ts then
		return
	end
	pcall(function()
		dot.BackgroundColor3 = color or C.running
		local info = TweenInfo.new(PULSE_PERIOD / 2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true)
		self.pulseTween = ts:Create(dot, info, { BackgroundTransparency = 0.6, Size = UDim2.fromOffset(10, 10) })
		self.pulseTween:Play()
	end)
end

function Progress:_pillPulse(on: boolean, color: Color3)
	if self.pillTween then
		pcall(function()
			self.pillTween:Cancel()
		end)
		self.pillTween = nil
	end
	self.pill.BackgroundTransparency = 0.8
	local ts = tweenService()
	if not on or not ts then
		return
	end
	pcall(function()
		local info = TweenInfo.new(PULSE_PERIOD, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true)
		self.pillTween = ts:Create(self.pill, info, { BackgroundTransparency = 0.5 })
		self.pill.BackgroundColor3 = color
		self.pillTween:Play()
	end)
end

--- Elapsed ms of a running step right now (snapshot value plus time since the snapshot arrived).
function Progress:_elapsed(step): number
	local base = tonumber(step.elapsedMs) or 0
	return base + (os.clock() - self.receivedAt) * 1000
end

function Progress:_tick()
	local snap = self.snapshot
	if not snap or snap.status ~= "running" then
		self:_stopHeartbeat()
		return
	end
	for i, s in ipairs(snap.steps or {}) do
		if tostring(s.status) == "running" then
			local row = self.rows[i]
			if row and row.frame.Visible then
				local elapsed = self:_elapsed(s)
				row.time.Text = Model.elapsedText(elapsed, tonumber(s.timeoutMs))
				local f, warn = Model.budget(elapsed, tonumber(s.timeoutMs))
				row.budget.Size = UDim2.fromScale(f, 1)
				row.budget.BackgroundColor3 = if warn then C.warn else C.running
				row.time.TextColor3 = if warn then C.warn else C.muted
			end
		end
	end
end

function Progress:_startHeartbeat()
	if self.heartbeat then
		return
	end
	local ok, rs = pcall(function()
		return game:GetService("RunService")
	end)
	if not ok or not rs then
		return
	end
	local acc = 0
	self.heartbeat = rs.Heartbeat:Connect(function(dt)
		acc += dt
		if acc >= 0.1 then
			acc = 0
			self:_tick()
		end
	end)
end

function Progress:_stopHeartbeat()
	if self.heartbeat then
		self.heartbeat:Disconnect()
		self.heartbeat = nil
	end
end

-- Rendering --------------------------------------------------------------------------------------

function Progress:_renderStep(order: number, i: number, s, mine: string?, running: boolean)
	local st = tostring(s.status)
	local isMine = mine ~= nil and s.target == mine
	local row = self:_row(i)
	row.frame.Visible = true
	row.frame.LayoutOrder = order
	row.frame.BackgroundTransparency = if st == "running" then 0.88 elseif isMine then 0.96 else 1
	row.label.Text = tostring(s.display or s.id)
	row.label.TextColor3 = if st == "pending" or st == "skipped" or st == "cancelled" then C.muted else C.text
	row.label.Font = if st == "running" then Enum.Font.GothamMedium else Enum.Font.Gotham
	row.tag.Text = if isMine then "YOU" else Model.tag(tostring(s.target))
	row.tag.TextColor3 = if isMine or st == "running" then C.running else C.muted
	local dotColor = C[st] or C.muted
	row.dot.BackgroundColor3 = dotColor
	row.dot.BackgroundTransparency = if st == "pending" then 1 else 0
	row.dotStroke.Color = dotColor
	if st == "running" then
		row.time.Text = Model.elapsedText(self:_elapsed(s), tonumber(s.timeoutMs))
		row.time.TextColor3 = C.muted
		row.budgetTrack.Visible = true
		local f = Model.budget(self:_elapsed(s), tonumber(s.timeoutMs))
		row.budget.Size = UDim2.fromScale(f, 1)
		row.budget.BackgroundColor3 = C.running
	else
		row.budgetTrack.Visible = false
		row.time.Text = if s.durationMs ~= nil and (st == "passed" or st == "failed")
			then Model.fmtSeconds(tonumber(s.durationMs) or 0)
			else ""
		row.time.TextColor3 = C.muted
	end
	row.reason.Position = UDim2.fromOffset(16, if st == "running" then 22 else 18)
	row.reason.Text = if st == "failed" and s.reason then tostring(s.reason) else ""
	row.reason.Visible = row.reason.Text ~= ""
	if st == "running" and running then
		self:_pulse(row.dot, C.running)
	elseif self.pulseTarget == row.dot then
		self:_pulse(nil)
	end
end

function Progress:_render()
	local snap = self.snapshot
	if not snap then
		return
	end
	local steps = type(snap.steps) == "table" and snap.steps or {}
	local mine = self.mine
	local status = tostring(snap.status or "running")
	local fold = mine ~= nil and not self.showAll
	self.scopeButton.Visible = mine ~= nil
	self.scopeButton.Text = if self.showAll then "ALL" else "MINE"
	self.scopeButton.TextColor3 = if self.showAll then C.text else C.running

	local rows = Model.group(steps, if fold then mine else nil)
	self._autoExpanded = {}
	local order = 0
	local shownSteps, shownGroups = {}, {}
	local current = nil
	local pulsed = false
	for _, r in ipairs(rows) do
		order += 1
		if r.kind == "step" then
			shownSteps[r.index] = true
			self:_renderStep(order, r.index, r.step, mine, not pulsed)
			local st = tostring(r.step.status)
			if st == "running" then
				pulsed = true
			end
			if current == nil and (st == "running" or st == "failed") then
				current = r.index
			end
		else
			local g = r
			self._autoExpanded[g.key] = g.autoExpand
			local expanded = self.expanded[g.key]
			if expanded == nil then
				expanded = g.autoExpand
			end
			shownGroups[g.key] = true
			local row = self:_groupRow(g.key)
			row.frame.Visible = true
			row.frame.LayoutOrder = order
			row.chevron.Text = if expanded then "▾" else "▸"
			row.label.Text = Model.groupLabel(g)
			local color = C[g.status] or C.muted
			row.dot.BackgroundColor3 = color
			row.dot.BackgroundTransparency = if g.status == "pending" then 1 else 0
			row.dotStroke.Color = color
			row.label.TextColor3 = if g.status == "running" then C.text else C.muted
			if expanded then
				for k, s in ipairs(g.steps) do
					order += 1
					local idx = g.first + k - 1
					shownSteps[idx] = true
					self:_renderStep(order, idx, s, mine, not pulsed)
					local st = tostring(s.status)
					if st == "running" then
						pulsed = true
					end
					if current == nil and (st == "running" or st == "failed") then
						current = idx
					end
				end
			elseif g.status == "running" and not pulsed then
				self:_pulse(row.dot, C.running)
				pulsed = true
			end
			if current == nil and (g.status == "running" or g.status == "failed") then
				current = g.first
			end
		end
	end
	for i, row in pairs(self.rows) do
		if not shownSteps[i] then
			row.frame.Visible = false
		end
	end
	for key, row in pairs(self.groups) do
		if not shownGroups[key] then
			row.frame.Visible = false
		end
	end
	if not pulsed then
		self:_pulse(nil)
	end

	-- keep the current (or first failed) step in view
	if current then
		local target = (self.rows[current] and self.rows[current].frame.Visible) and self.rows[current].frame or nil
		if not target then
			for key, row in pairs(self.groups) do
				local g = nil
				for _, r in ipairs(rows) do
					if r.kind == "group" and r.key == key then
						g = r
					end
				end
				if g and current >= g.first and current <= g.last and row.frame.Visible then
					target = row.frame
				end
			end
		end
		if target then
			Env.task().defer(function()
				local list = self.list
				local y = target.AbsolutePosition.Y - list.AbsolutePosition.Y + list.CanvasPosition.Y
				list.CanvasPosition = Vector2.new(0, math.max(0, y - list.AbsoluteSize.Y / 3))
			end)
		end
	end

	if status == "running" then
		self:_startHeartbeat()
	else
		self:_stopHeartbeat()
	end
end

--- Apply a progress snapshot. `mine` ("client#N") marks this window's own steps as YOU.
function Progress:update(snap: any, mine: string?)
	local steps = type(snap.steps) == "table" and snap.steps or {}
	local total = tonumber(snap.total) or #steps
	local finished = tonumber(snap.finished) or 0
	local status = tostring(snap.status or "running")
	local color = C[status] or C.running

	if snap.runId ~= self.runId then
		self.runId = snap.runId
		self.expanded = {} -- user choices are per run
		self.widget.Enabled = true -- surface each new run; closing it mid-run sticks
	end
	self.snapshot = snap
	self.receivedAt = os.clock()
	self.mine = mine

	self.title.Text = tostring(snap.name or "playtest")
	self.pill.Text = RUN_LABEL[status] or status
	self.pill.TextColor3, self.pill.BackgroundColor3 = color, color
	self:_pillPulse(status == "running", color)
	self.bar.BackgroundColor3 = color
	self.bar.Size = UDim2.fromScale(if total > 0 then finished / total else 0, 1)
	local runningStep = nil
	for _, s in ipairs(steps) do
		if tostring(s.status) == "running" then
			runningStep = s
			break
		end
	end
	if status == "running" then
		self.subtitle.Text = `Step {math.min(finished + 1, total)} of {total}`
			.. (if runningStep then ` · {tostring(runningStep.display or runningStep.id)}` else "")
	else
		self.subtitle.Text = `{finished} of {total} steps`
	end
	if mine then
		self.subtitle.Text ..= ` · you are {Model.tag(mine)}`
	end

	local parts = {}
	for _, e in ipairs(Model.summarize(steps)) do
		local c = if e.failed then C.failed elseif e.done == e.total then C.passed else C.text
		table.insert(parts, `<font color="#{hex(c)}">{e.tag} {e.done}/{e.total}</font>`)
	end
	self.summary.Text = table.concat(parts, "   ")

	self:_render()
end

function Progress:destroy()
	self:_stopHeartbeat()
	self:_pulse(nil)
	self:_pillPulse(false, C.muted)
	if self.widget then
		self.widget:Destroy()
	end
end

return Progress
