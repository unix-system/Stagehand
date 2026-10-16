--!nonstrict
--[[
	input.* actions (client only) via VirtualInput.

	The VirtualInput object is obtained once per node with UserInputService:CreateVirtualInput()
	and cached (each DataModel loads its own copy of this module). Calls use the documented signatures:
	  SendKey(isPressed: boolean, keyCode: Enum.KeyCode, isRepeatedKey: boolean = false)
	  SendMouseButton(position: Vector2, button: Enum.UserInputType, isDown: boolean, repeatCount: number = 0)
	  SendMouseDelta(positionDelta: Vector2)
	  SendMousePosition(position: Vector2)
	  SendTextInput(text: string)
]]

local Meta = require(script.Parent.Parent.Meta)
local Env = require(script.Parent.Parent.Env)
local Errors = require(script.Parent.Parent.Errors)
local Resolve = require(script.Parent.Parent.Resolve)

local S = Meta.S
local C = { "client" }

local Input = {}

local cached = nil
function Input.virtual()
	if cached then
		return cached
	end
	local uis = Env.service("UserInputService")
	if not uis then
		Errors.throw("ACTION_ERROR", "UserInputService unavailable")
	end
	local ok, vi = pcall(function()
		return uis:CreateVirtualInput()
	end)
	if not ok or not vi then
		Errors.throw("ACTION_ERROR", "UserInputService:CreateVirtualInput() failed: " .. tostring(vi))
	end
	cached = vi
	return vi
end

local function call(method: string, ...)
	local vi = Input.virtual()
	local args = table.pack(...)
	local ok, err = pcall(function()
		vi[method](vi, table.unpack(args, 1, args.n))
	end)
	if not ok then
		Errors.throw("ACTION_ERROR", "VirtualInput:" .. method .. " failed: " .. tostring(err))
	end
end

function Input.key(down: boolean, keyCode)
	call("SendKey", down, keyCode, false)
end

local BUTTONS = { Left = "MouseButton1", Right = "MouseButton2", Middle = "MouseButton3" }

function Input.mouseButton(position, button: string, down: boolean)
	local E = Env.Enum()
	local uit = E.UserInputType[BUTTONS[button] or "MouseButton1"]
	call("SendMouseButton", position, uit, down, 0)
end

function Input.mousePosition(position)
	call("SendMousePosition", position)
end

function Input.mouseDelta(delta)
	call("SendMouseDelta", delta)
end

function Input.text(text: string)
	call("SendTextInput", text)
end

function Input.click(ctx, position, button: string)
	Input.mousePosition(position)
	Input.mouseButton(position, button, true)
	ctx.frame()
	Input.mouseButton(position, button, false)
end

function Input.keyCode(code: string)
	local E = Env.Enum()
	local name = code:match("^Enum%.KeyCode%.([%w_]+)$") or code
	local ok, kc = pcall(function()
		return E.KeyCode[name]
	end)
	if ok and kc then
		return kc
	end
	-- "e" → E, "space" → Space
	local alt = name:sub(1, 1):upper() .. name:sub(2)
	ok, kc = pcall(function()
		return E.KeyCode[alt]
	end)
	if ok and kc then
		return kc
	end
	return Errors.throw("BAD_PARAMS", "unknown KeyCode '" .. code .. "'")
end

--- Screen-space centre (viewport pixels, inset included) of a GuiObject or BasePart.
function Input.screenPoint(inst)
	local V2 = Env.datatype("Vector2")
	if inst:IsA("GuiObject") then
		local centre = inst.AbsolutePosition + inst.AbsoluteSize / 2
		local sg = inst:FindFirstAncestorWhichIsA("ScreenGui")
		if sg and not sg.IgnoreGuiInset then
			local gs = Env.service("GuiService")
			if gs then
				local ok, topLeft = pcall(function()
					return gs:GetGuiInset()
				end)
				if ok and topLeft then
					centre += topLeft
				end
			end
		end
		return V2.new(centre.X, centre.Y)
	end
	local ws = Env.service("Workspace")
	local cam = ws and ws.CurrentCamera
	if not cam then
		Errors.throw("ACTION_ERROR", "no CurrentCamera")
	end
	local pos = Resolve.toVector3(inst, nil)
	local vp, onScreen = cam:WorldToViewportPoint(pos)
	if not onScreen then
		Errors.throw("ACTION_ERROR", inst:GetFullName() .. " is not on screen")
	end
	return V2.new(vp.X, vp.Y)
end

local KEYS = { forward = "W", back = "S", left = "A", right = "D" }

local function keysForDirection(direction): { string }
	if type(direction) == "string" then
		return { KEYS[direction] }
	end
	local v = Resolve.vector3(direction)
	if not v or v.Magnitude == 0 then
		Errors.throw("BAD_PARAMS", "direction must be forward|back|left|right or a non-zero Vector3")
	end
	local ws = Env.service("Workspace")
	local cam = ws and ws.CurrentCamera
	local V3 = Env.datatype("Vector3")
	local look = cam and cam.CFrame.LookVector or V3.new(0, 0, -1)
	local right = cam and cam.CFrame.RightVector or V3.new(1, 0, 0)
	look = V3.new(look.X, 0, look.Z)
	right = V3.new(right.X, 0, right.Z)
	local flat = V3.new(v.X, 0, v.Z)
	if flat.Magnitude == 0 then
		return {}
	end
	flat = flat.Unit
	local keys = {}
	local f = if look.Magnitude > 0 then flat:Dot(look.Unit) else 0
	local r = if right.Magnitude > 0 then flat:Dot(right.Unit) else 0
	if f > 0.38 then
		table.insert(keys, "W")
	elseif f < -0.38 then
		table.insert(keys, "S")
	end
	if r > 0.38 then
		table.insert(keys, "D")
	elseif r < -0.38 then
		table.insert(keys, "A")
	end
	return keys
end

local function vec2(t)
	return Env.datatype("Vector2").new(t[1], t[2])
end

Input.entries = {
	Meta.define({
		name = "input.key",
		kind = "action",
		contexts = C,
		default = "client",
		summary = "Press a key via VirtualInput (down, hold, up).",
		actor = "required",
		params = S.params({
			{ "code", S.string('KeyCode name, e.g. "E", "Space" or "Enum.KeyCode.E"') },
			{ "hold", S.duration("How long to hold; default one frame") },
		}, { "code" }),
	}, {
		run = function(ctx, p)
			local kc = Input.keyCode(p.code)
			Input.key(true, kc)
			local ok, err = pcall(function()
				if p.hold and p.hold > 0 then
					ctx.sleep(p.hold)
				else
					ctx.frame()
				end
			end)
			Input.key(false, kc)
			if not ok then
				error(err, 0)
			end
			return nil
		end,
	}),

	Meta.define({
		name = "input.click",
		kind = "action",
		contexts = C,
		default = "client",
		summary = "Mouse click at a GuiObject's centre / BasePart's screen position, or at a screen position.",
		actor = "required",
		params = S.params({
			{ "target", S.selector() },
			{ "position", S.vec(2, "Screen [x,y] in pixels") },
			{ "button", S.enum({ "Left", "Right", "Middle" }, "Left") },
		}, {}, { S.requires("target"), S.requires("position") }),
	}, {
		run = function(ctx, p)
			local pos
			if p.target then
				pos = Input.screenPoint(ctx.resolve(p.target))
			else
				pos = vec2(p.position)
			end
			Input.click(ctx, pos, p.button or "Left")
			return { pos.X, pos.Y }
		end,
	}),

	Meta.define({
		name = "input.mouseMove",
		kind = "action",
		contexts = C,
		default = "client",
		summary = "Move the mouse to a screen position or by a delta.",
		actor = "required",
		params = S.params({
			{ "position", S.vec(2, "Screen [x,y]") },
			{ "delta", S.vec(2, "[dx,dy]") },
		}, {}, { S.requires("position"), S.requires("delta") }),
	}, {
		run = function(_ctx, p)
			if p.position then
				Input.mousePosition(vec2(p.position))
			else
				Input.mouseDelta(vec2(p.delta))
			end
			return nil
		end,
	}),

	Meta.define({
		name = "input.text",
		kind = "action",
		contexts = C,
		default = "client",
		summary = "Type text into the focused TextBox (VirtualInput:SendTextInput).",
		actor = "required",
		params = S.params({ { "text", S.string() } }, { "text" }),
	}, {
		run = function(_ctx, p)
			Input.text(p.text)
			return nil
		end,
	}),

	Meta.define({
		name = "input.move",
		kind = "action",
		contexts = C,
		default = "client",
		summary = "Hold movement keys (WASD relative to the camera) for a duration.",
		actor = "required",
		params = S.params({
			{
				"direction",
				S.oneOf("forward|back|left|right or a world-space Vector3 direction", {
					{ type = "string", enum = Meta.arr({ "forward", "back", "left", "right" }) },
					S.vec(3),
				}),
			},
			{ "duration", S.duration() },
		}, { "direction", "duration" }),
	}, {
		run = function(ctx, p)
			local codes = {}
			for _, k in ipairs(keysForDirection(p.direction)) do
				table.insert(codes, Input.keyCode(k))
			end
			for _, kc in ipairs(codes) do
				Input.key(true, kc)
			end
			local ok, err = pcall(ctx.sleep, p.duration)
			for _, kc in ipairs(codes) do
				Input.key(false, kc)
			end
			if not ok then
				error(err, 0)
			end
			return nil
		end,
	}),
}

return Input
