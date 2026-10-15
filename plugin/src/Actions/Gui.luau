--!nonstrict
-- gui.* actions and conditions (client only)

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")
local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")
local Conditions = if script then require(script.Parent.Parent.Conditions) else require("../Conditions")
local Input = if script then require(script.Parent.Input) else require("./Input")

local S = Meta.S
local C = { "client" }

-- Returns (visible, reason)
local function visibility(inst): (boolean, string?)
	if not inst:IsA("GuiObject") then
		return false, inst.ClassName .. " is not a GuiObject"
	end
	local node = inst
	while node do
		if node:IsA("GuiObject") and not node.Visible then
			return false, node:GetFullName() .. ".Visible = false"
		end
		if node:IsA("LayerCollector") then
			if not node.Enabled then
				return false, node:GetFullName() .. ".Enabled = false"
			end
			break
		end
		node = node.Parent
	end
	if not node then
		return false, "not under a ScreenGui/SurfaceGui/BillboardGui"
	end
	if node:IsA("ScreenGui") then
		local pg = node:FindFirstAncestorWhichIsA("PlayerGui")
		if not pg then
			return false, "ScreenGui is not under PlayerGui"
		end
	end
	local size = inst.AbsoluteSize
	if size.X <= 0 or size.Y <= 0 then
		return false, "zero AbsoluteSize"
	end
	local ws = Env.service("Workspace")
	local cam = ws and ws.CurrentCamera
	if cam and node:IsA("ScreenGui") then
		local vp = cam.ViewportSize
		local p = inst.AbsolutePosition
		if p.X + size.X < 0 or p.Y + size.Y < 0 or p.X > vp.X or p.Y > vp.Y then
			return false, "off screen"
		end
	end
	return true, nil
end

local function ancestorSignals(inst)
	local list = {}
	local node = inst
	while node do
		if node:IsA("GuiObject") then
			table.insert(list, node:GetPropertyChangedSignal("Visible"))
		elseif node:IsA("LayerCollector") then
			table.insert(list, node:GetPropertyChangedSignal("Enabled"))
			break
		end
		node = node.Parent
	end
	table.insert(list, inst.AncestryChanged)
	table.insert(list, inst:GetPropertyChangedSignal("AbsoluteSize"))
	table.insert(list, inst:GetPropertyChangedSignal("AbsolutePosition"))
	return list
end

local function guiSignals(ctx, p)
	local list = {}
	local ok, inst = pcall(ctx.resolve, p.target)
	if ok and inst then
		for _, s in ipairs(ancestorSignals(inst)) do
			table.insert(list, s)
		end
		if p.value ~= nil then
			table.insert(list, inst:GetPropertyChangedSignal("Text"))
		end
	else
		local player = ctx.player(false)
		local pg = player and player:FindFirstChildOfClass("PlayerGui")
		if pg then
			table.insert(list, pg.DescendantAdded)
		end
	end
	return list
end

return {
	entries = {
		Meta.define({
			name = "gui.click",
			kind = "action",
			contexts = C,
			default = "client",
			summary = "Activate a GuiButton (fires Activated via VirtualInput click at its centre).",
			actor = "required",
			params = S.params({ { "target", S.selector() } }, { "target" }),
		}, {
			run = function(ctx, p)
				local inst = ctx.resolve(p.target)
				if not inst:IsA("GuiObject") then
					Errors.throw("BAD_PARAMS", inst:GetFullName() .. " is not a GuiObject")
				end
				local visible, why = visibility(inst)
				if not visible then
					Errors.throw("ACTION_ERROR", "cannot click " .. inst:GetFullName() .. ": " .. tostring(why))
				end
				local pos = Input.screenPoint(inst)
				Input.click(ctx, pos, "Left")
				return { pos.X, pos.Y }
			end,
		}),

		Meta.define({
			name = "gui.setText",
			kind = "action",
			contexts = C,
			default = "client",
			summary = "Set a TextBox's Text and fire FocusLost(enterPressed=true).",
			actor = "required",
			params = S.params({ { "target", S.selector() }, { "text", S.string() } }, { "target", "text" }),
		}, {
			run = function(ctx, p)
				local box = ctx.resolve(p.target)
				if not box:IsA("TextBox") then
					Errors.throw("BAD_PARAMS", box:GetFullName() .. " is not a TextBox")
				end
				pcall(function()
					box:CaptureFocus()
				end)
				box.Text = p.text
				-- ReleaseFocus(submitted) fires FocusLost(enterPressed = submitted)
				box:ReleaseFocus(true)
				return nil
			end,
		}),

		Meta.define({
			name = "gui.visible",
			kind = "condition",
			contexts = C,
			default = "client",
			summary = "GuiObject and all ancestors Visible/Enabled, and on screen.",
			actor = "required",
			params = S.params({ { "target", S.selector() } }, { "target" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target, true)
				if #list == 0 then
					return false, { visible = false, reason = "no match" }
				end
				for _, inst in ipairs(list) do
					local ok, why = visibility(inst)
					if not ok then
						return false, { visible = false, target = inst:GetFullName(), reason = why }
					end
				end
				return true, { visible = true }
			end,
			signals = guiSignals,
		}),

		Meta.define({
			name = "gui.text",
			kind = "condition",
			contexts = C,
			default = "client",
			summary = "Compare a TextLabel/TextBox/TextButton Text.",
			actor = "required",
			params = S.params({ { "target", S.selector() }, { "op", S.op() }, { "value", S.string() } }, {
				"target",
				"value",
			}),
		}, {
			run = function(ctx, p)
				local inst = ctx.resolve(p.target)
				local ok, text = pcall(function()
					return inst.Text
				end)
				if not ok then
					Errors.throw("BAD_PARAMS", inst:GetFullName() .. " has no Text property")
				end
				return Conditions.compare(p.op, text, p.value), { value = text }
			end,
			signals = guiSignals,
		}),
	},
}
