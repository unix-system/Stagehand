--!nonstrict
-- gui.* actions and conditions (client only)

local Meta = require(script.Parent.Parent.Meta)
local Errors = require(script.Parent.Parent.Errors)
local Conditions = require(script.Parent.Parent.Conditions)
local Input = require(script.Parent.Input)

local S = Meta.S
local C = { "client" }

local function guiSignals(ctx, p)
	return Input.guiSignals(ctx, p.target, p.value ~= nil)
end

return {
	entries = {
		Meta.define({
			name = "gui.click",
			kind = "action",
			contexts = C,
			default = "client",
			summary = "Wait for a GuiButton to appear and be visible (within the step timeout), then activate it with a VirtualInput click at its centre (the cursor glides there along a short curve, visualised in the client window).",
			actor = "required",
			params = S.params({ { "target", S.selector() } }, { "target" }),
		}, {
			run = function(ctx, p)
				local inst = Input.awaitTarget(ctx, p.target, true)
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
			summary = "Wait for a TextBox to appear and be visible, set its Text and fire FocusLost(enterPressed=true).",
			actor = "required",
			params = S.params({ { "target", S.selector() }, { "text", S.string() } }, { "target", "text" }),
		}, {
			run = function(ctx, p)
				local box = Input.awaitTarget(ctx, p.target, true)
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
					local ok, why = Input.visibility(inst)
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
