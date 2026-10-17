--!nonstrict
--[[
	InputOverlay — draws what the client node's VirtualInput is doing so a watcher can follow a run
	in each client window: a cursor ring, a fading motion trail, click rings and a key strip
	(docs/plugin.md "Input visualisation").

	Studio-only (Roblox globals at the top level); Actions/Input requires it lazily and only inside
	a pcall, so a failure here can never fail a step. One overlay per DataModel: a ScreenGui named
	"StagehandInput" in CoreGui (PlayerGui fallback), IgnoreGuiInset so positions are the raw screen
	pixels VirtualInput uses, every element Active = false so it never intercepts the input it draws.
]]

local Env = require(script.Parent.Parent.Env)

local InputOverlay = {}
InputOverlay.__index = InputOverlay

local GUI_NAME = "StagehandInput"
local CURSOR_SIZE, CURSOR_DOT = 18, 6
local IDLE_FADE_AFTER, IDLE_TRANSPARENCY = 1.5, 0.5
local TRAIL_THICKNESS, TRAIL_FADE, TRAIL_CAP = 3, 0.5, 64
local CLICK_FROM, CLICK_TO, CLICK_TIME = 12, 40, 0.3
local KEY_LINGER, TEXT_LINGER = 0.6, 1
local KEY_LIT, KEY_DIM = 0.1, 0.6

local COLORS = {
	cursor = Color3.fromRGB(86, 156, 255),
	Left = Color3.fromRGB(86, 156, 255),
	Right = Color3.fromRGB(240, 170, 60),
	Middle = Color3.fromRGB(160, 166, 178),
	key = Color3.fromRGB(28, 30, 36),
	keyText = Color3.fromRGB(236, 238, 242),
	keyStroke = Color3.fromRGB(86, 156, 255),
}

local singleton = nil
local creationFailed = false

local function new(className: string, props: { [string]: any }, children: { Instance }?): Instance
	local inst = Instance.new(className)
	for k, v in pairs(props) do
		if k ~= "Parent" then
			inst[k] = v
		end
	end
	if inst:IsA("GuiObject") then
		inst.Active = false
		inst.Selectable = false
	end
	for _, c in ipairs(children or {}) do
		c.Parent = inst
	end
	inst.Parent = props.Parent
	return inst
end

local function corner(r: number): Instance
	return new("UICorner", { CornerRadius = UDim.new(0, r) })
end

local function tween(inst: Instance, seconds: number, props: { [string]: any }, onDone: (() -> ())?)
	local ts = Env.service("TweenService")
	local ok, tw = pcall(function()
		local t = ts:Create(inst, TweenInfo.new(seconds, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), props)
		t:Play()
		return t
	end)
	if ok and tw then
		if onDone then
			tw.Completed:Once(onDone)
		end
	else
		for k, v in pairs(props) do
			pcall(function()
				inst[k] = v
			end)
		end
		if onDone then
			task.delay(seconds, onDone)
		end
	end
end

local function parentGui(gui: ScreenGui): boolean
	local core = Env.service("CoreGui")
	if core then
		local ok = pcall(function()
			gui.Parent = core
		end)
		if ok and gui.Parent == core then
			return true
		end
	end
	local players = Env.service("Players")
	local lp = players and players.LocalPlayer
	local pg = lp and lp:FindFirstChildOfClass("PlayerGui")
	if pg then
		local ok = pcall(function()
			gui.Parent = pg
		end)
		return ok and gui.Parent == pg
	end
	return false
end

local function build()
	local self = setmetatable({ trails = {}, held = {}, caps = {}, moveTick = 0 }, InputOverlay)
	local gui = new("ScreenGui", {
		Name = GUI_NAME,
		IgnoreGuiInset = true,
		DisplayOrder = 2147483647,
		ResetOnSpawn = false,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	}) :: ScreenGui
	if not parentGui(gui) then
		gui:Destroy()
		error("no CoreGui or PlayerGui to parent the overlay to")
	end
	self.gui = gui

	self.cursor = new("Frame", {
		Name = "Cursor",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Size = UDim2.fromOffset(CURSOR_SIZE, CURSOR_SIZE),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		Visible = false,
		ZIndex = 10,
		Parent = gui,
	}, {
		corner(CURSOR_SIZE / 2),
		new("UIStroke", { Thickness = 1.5, Color = COLORS.cursor, Name = "Ring" }),
		new("Frame", {
			Name = "Dot",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.fromScale(0.5, 0.5),
			Size = UDim2.fromOffset(CURSOR_DOT, CURSOR_DOT),
			BackgroundColor3 = COLORS.cursor,
			BorderSizePixel = 0,
		}, { corner(CURSOR_DOT / 2) }),
	})
	self.cursorRing = self.cursor:FindFirstChild("Ring")
	self.cursorDot = self.cursor:FindFirstChild("Dot")

	self.keyStrip = new("Frame", {
		Name = "Keys",
		AnchorPoint = Vector2.new(0.5, 1),
		Position = UDim2.new(0.5, 0, 1, -28),
		Size = UDim2.fromOffset(0, 0),
		AutomaticSize = Enum.AutomaticSize.XY,
		BackgroundTransparency = 1,
		ZIndex = 5,
		Parent = gui,
	}, {
		new("UIListLayout", {
			FillDirection = Enum.FillDirection.Horizontal,
			HorizontalAlignment = Enum.HorizontalAlignment.Center,
			VerticalAlignment = Enum.VerticalAlignment.Bottom,
			SortOrder = Enum.SortOrder.LayoutOrder,
			Padding = UDim.new(0, 6),
		}),
	})
	self.capOrder = 0
	return self
end

--- The overlay for this DataModel, created on first use; nil when it cannot be created.
function InputOverlay.get()
	if singleton and singleton.gui and singleton.gui.Parent then
		return singleton
	end
	if creationFailed then
		return nil
	end
	local ok, result = pcall(build)
	if not ok then
		creationFailed = true
		error(result, 0)
	end
	singleton = result
	return singleton
end

local function setCursorAlpha(self, alpha: number, seconds: number)
	tween(self.cursorRing, seconds, { Transparency = alpha })
	tween(self.cursorDot, seconds, { BackgroundTransparency = alpha })
end

--- Move the cursor ring to `pos` (screen pixels); it fades to half after 1.5 s idle.
function InputOverlay:cursor(pos: Vector2)
	pcall(function()
		self.cursor.Position = UDim2.fromOffset(pos.X, pos.Y)
		self.cursor.Visible = true
		self.cursorRing.Transparency = 0
		self.cursorDot.BackgroundTransparency = 0
		self.moveTick += 1
		local tick = self.moveTick
		task.delay(IDLE_FADE_AFTER, function()
			if self.moveTick == tick and self.cursor and self.cursor.Parent then
				setCursorAlpha(self, IDLE_TRANSPARENCY, 0.3)
			end
		end)
	end)
end

--- A thin segment from `from` to `to` that fades out over 0.5 s (at most 64 live segments).
function InputOverlay:trail(from: Vector2, to: Vector2)
	pcall(function()
		local d = to - from
		local len = d.Magnitude
		if len < 0.5 then
			return
		end
		local mid = (from + to) / 2
		local seg = new("Frame", {
			Name = "Trail",
			AnchorPoint = Vector2.new(0.5, 0.5),
			Position = UDim2.fromOffset(mid.X, mid.Y),
			Size = UDim2.fromOffset(len, TRAIL_THICKNESS),
			Rotation = math.deg(math.atan2(d.Y, d.X)),
			BackgroundColor3 = COLORS.cursor,
			BackgroundTransparency = 0.25,
			BorderSizePixel = 0,
			ZIndex = 2,
			Parent = self.gui,
		}, { corner(TRAIL_THICKNESS / 2) })
		table.insert(self.trails, seg)
		while #self.trails > TRAIL_CAP do
			local oldest = table.remove(self.trails, 1)
			pcall(oldest.Destroy, oldest)
		end
		tween(seg, TRAIL_FADE, { BackgroundTransparency = 1 }, function()
			local i = table.find(self.trails, seg)
			if i then
				table.remove(self.trails, i)
			end
			pcall(seg.Destroy, seg)
		end)
	end)
end

local function ring(self, pos: Vector2, color: Color3, size: number, zIndex: number): Instance
	return new("Frame", {
		Name = "Click",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromOffset(pos.X, pos.Y),
		Size = UDim2.fromOffset(size, size),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ZIndex = zIndex,
		Parent = self.gui,
	}, { corner(size), new("UIStroke", { Thickness = 2, Color = color, Name = "Ring" }) })
end

--- Button press/release at `pos`. `down` draws an expanding ring and keeps a static one until the
--- matching release.
function InputOverlay:click(pos: Vector2, button: string, down: boolean)
	pcall(function()
		local color = COLORS[button] or COLORS.Left
		if down then
			local burst = ring(self, pos, color, CLICK_FROM, 8)
			tween(burst, CLICK_TIME, { Size = UDim2.fromOffset(CLICK_TO, CLICK_TO) })
			tween(burst:FindFirstChild("Ring"), CLICK_TIME, { Transparency = 1 }, function()
				pcall(burst.Destroy, burst)
			end)
			local prev = self.held[button]
			if prev then
				pcall(prev.Destroy, prev)
			end
			self.held[button] = ring(self, pos, color, CURSOR_SIZE + 8, 9)
		else
			local held = self.held[button]
			if held then
				self.held[button] = nil
				tween(held:FindFirstChild("Ring"), 0.15, { Transparency = 1 }, function()
					pcall(held.Destroy, held)
				end)
			end
		end
	end)
end

local function cap(self, label: string, textSize: number): TextLabel
	self.capOrder += 1
	return new("TextLabel", {
		Name = "Key",
		Text = label,
		TextSize = textSize,
		Font = Enum.Font.GothamBold,
		TextColor3 = COLORS.keyText,
		BackgroundColor3 = COLORS.key,
		BackgroundTransparency = KEY_LIT,
		BorderSizePixel = 0,
		AutomaticSize = Enum.AutomaticSize.X,
		Size = UDim2.fromOffset(0, 30),
		LayoutOrder = self.capOrder,
		Parent = self.keyStrip,
	}, {
		corner(6),
		new("UIStroke", { Thickness = 1, Color = COLORS.keyStroke, Transparency = 0.3 }),
		new("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10) }),
	}) :: TextLabel
end

--- Add (or re-light) a key cap in the bottom-centre strip.
function InputOverlay:keyDown(label: string)
	pcall(function()
		local entry = self.caps[label]
		if entry then
			entry.gen += 1
			entry.frame.BackgroundTransparency = KEY_LIT
			entry.frame.TextTransparency = 0
			return
		end
		self.caps[label] = { frame = cap(self, label, 14), gen = 0 }
	end)
end

--- Dim a key cap and remove it 0.6 s later unless pressed again.
function InputOverlay:keyUp(label: string)
	pcall(function()
		local entry = self.caps[label]
		if not entry then
			return
		end
		entry.gen += 1
		local gen = entry.gen
		entry.frame.BackgroundTransparency = KEY_DIM
		entry.frame.TextTransparency = 0.4
		task.delay(KEY_LINGER, function()
			if self.caps[label] == entry and entry.gen == gen then
				self.caps[label] = nil
				pcall(entry.frame.Destroy, entry.frame)
			end
		end)
	end)
end

--- Show `⌨ "str"` in the strip for a second.
function InputOverlay:text(str: string)
	pcall(function()
		local frame = cap(self, string.format('⌨ "%s"', tostring(str)), 13)
		task.delay(TEXT_LINGER, function()
			pcall(frame.Destroy, frame)
		end)
	end)
end

function InputOverlay:destroy()
	pcall(function()
		if self.gui then
			self.gui:Destroy()
		end
	end)
	if singleton == self then
		singleton = nil
	end
end

return InputOverlay
