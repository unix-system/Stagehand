--!nonstrict
--[[
	"Stagehand Progress" dock widget, one per Studio window of a test: the edit node's covers the
	main window, and each multiplayer client node shows its own (steps it runs are marked YOU). The
	daemon pushes a snapshot with the `progress` command (docs/protocol.md); this shows the run name
	and status, a progress bar, a per-client summary (Server / P1 / P2 …) and the step list tagged with
	where each step runs, with failure reasons inline. Nothing is drawn in the game. The widget opens
	itself when a new run starts.
]]

local Env = require(script.Parent.Parent.Env)

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

function Progress.new(plugin: Plugin)
	local self = setmetatable({ rows = {}, runId = nil }, Progress)
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
		Size = UDim2.new(0.5, 0, 1, 0),
		Parent = brand,
	})
	self.pill = new("TextLabel", {
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, 0, 0.5, 0),
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
		LayoutOrder = i,
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
		Size = UDim2.new(1, -66, 0, 16),
		TextSize = 12,
		Font = Enum.Font.Gotham,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Parent = frame,
	})
	local tag = text({
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, 0, 0, 0),
		Size = UDim2.fromOffset(46, 16),
		TextSize = 10,
		Font = Enum.Font.GothamBold,
		TextXAlignment = Enum.TextXAlignment.Right,
		Parent = frame,
	})
	local reason = text({
		Position = UDim2.fromOffset(16, 18),
		Size = UDim2.new(1, -16, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		TextSize = 11,
		Font = Enum.Font.Gotham,
		TextColor3 = C.failed,
		TextWrapped = true,
		Visible = false,
		Parent = frame,
	})
	row = { frame = frame, dot = dot, dotStroke = dotStroke, label = label, tag = tag, reason = reason }
	self.rows[i] = row
	return row
end

--- "client#2" → "P2", "server" → "SERVER".
function Progress.tag(target: string): string
	local n = target:match("^client#(%d+)$")
	return if n then "P" .. n else string.upper(target)
end

--- Per-target counts in first-seen order: { { tag, done, total, failed } }.
function Progress.summarize(steps: { any }): { any }
	local order, by = {}, {}
	for _, s in ipairs(steps) do
		local t = Progress.tag(tostring(s.target))
		local e = by[t]
		if not e then
			e = { tag = t, done = 0, total = 0, failed = false }
			by[t] = e
			table.insert(order, e)
		end
		e.total += 1
		local st = tostring(s.status)
		if st ~= "pending" and st ~= "running" then
			e.done += 1
		end
		if st == "failed" then
			e.failed = true
		end
	end
	return order
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
		self.widget.Enabled = true -- surface each new run; closing it mid-run sticks
	end

	self.title.Text = tostring(snap.name or "playtest")
	self.pill.Text = RUN_LABEL[status] or status
	self.pill.TextColor3, self.pill.BackgroundColor3 = color, color
	self.bar.BackgroundColor3 = color
	self.bar.Size = UDim2.fromScale(if total > 0 then finished / total else 0, 1)
	self.subtitle.Text = if status == "running"
		then `Step {math.min(finished + 1, total)} of {total}`
		else `{finished} of {total} steps`
	if mine then
		self.subtitle.Text ..= ` · you are {Progress.tag(mine)}`
	end

	local parts = {}
	for _, e in ipairs(Progress.summarize(steps)) do
		local c = if e.failed then C.failed elseif e.done == e.total then C.passed else C.text
		table.insert(parts, `<font color="#{hex(c)}">{e.tag} {e.done}/{e.total}</font>`)
	end
	self.summary.Text = table.concat(parts, "   ")

	local current = nil
	for i, s in ipairs(steps) do
		local st = tostring(s.status)
		local isMine = mine ~= nil and s.target == mine
		local row = self:_row(i)
		row.frame.Visible = true
		row.frame.BackgroundTransparency = if st == "running" then 0.9 elseif isMine then 0.96 else 1
		row.label.Text = tostring(s.display or s.id)
		row.label.TextColor3 = if st == "pending" or st == "skipped" or st == "cancelled" then C.muted else C.text
		row.tag.Text = if isMine then "YOU" else Progress.tag(tostring(s.target))
		row.tag.TextColor3 = if isMine or st == "running" then C.running else C.muted
		local dotColor = C[st] or C.muted
		row.dot.BackgroundColor3 = dotColor
		row.dot.BackgroundTransparency = if st == "pending" then 1 else 0
		row.dotStroke.Color = dotColor
		row.reason.Text = if st == "failed" and s.reason then tostring(s.reason) else ""
		row.reason.Visible = row.reason.Text ~= ""
		if current == nil and (st == "running" or st == "failed") then
			current = i
		end
	end
	for i = #steps + 1, #self.rows do
		self.rows[i].frame.Visible = false
	end

	-- keep the current (or first failed) step in view
	if current then
		Env.task().defer(function()
			local list = self.list
			local y = self.rows[current].frame.AbsolutePosition.Y - list.AbsolutePosition.Y + list.CanvasPosition.Y
			list.CanvasPosition = Vector2.new(0, math.max(0, y - list.AbsoluteSize.Y / 3))
		end)
	end
end

function Progress:destroy()
	if self.widget then
		self.widget:Destroy()
	end
end

return Progress
