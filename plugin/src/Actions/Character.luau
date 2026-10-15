--!nonstrict
-- character.* actions and conditions

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")
local Env = if script then require(script.Parent.Parent.Env) else require("../Env")
local Errors = if script then require(script.Parent.Parent.Errors) else require("../Errors")
local Resolve = if script then require(script.Parent.Parent.Resolve) else require("../Resolve")
local Conditions = if script then require(script.Parent.Parent.Conditions) else require("../Conditions")

local S = Meta.S
local SC = { "server", "client" }

local function posOrSelector(description: string)
	return S.oneOf(description, { S.vec(3), S.selector() })
end

local TOOL_DESC = "Tool name (searched in Backpack, then character) or selector"

-- Returns (tool, where) where where ∈ "backpack" | "character" | nil
local function findTool(ctx, player, tool: string)
	if Resolve.looksLikeSelector(tool) then
		local list = Resolve.all(tool, ctx, { allowEmpty = true })
		local inst = list[1]
		if not inst then
			return nil, nil
		end
		if player.Character and inst:IsDescendantOf(player.Character) then
			return inst, "character"
		end
		return inst, "backpack"
	end
	local backpack = player:FindFirstChildOfClass("Backpack")
	local inBackpack = backpack and backpack:FindFirstChild(tool)
	if inBackpack and inBackpack:IsA("Tool") then
		return inBackpack, "backpack"
	end
	local char = player.Character
	local inChar = char and char:FindFirstChild(tool)
	if inChar and inChar:IsA("Tool") then
		return inChar, "character"
	end
	return nil, nil
end

local function loadedState(player)
	local char = player and player.Character
	if not char then
		return false, nil, "no character"
	end
	local hum = char:FindFirstChildOfClass("Humanoid")
	local root = char:FindFirstChild("HumanoidRootPart")
	local ws = Env.service("Workspace")
	local inWorld = ws ~= nil and char:IsDescendantOf(ws)
	if hum and root and inWorld then
		return true, hum, nil
	end
	return false,
		hum,
		string.format(
			"humanoid=%s rootPart=%s inWorkspace=%s",
			tostring(hum ~= nil),
			tostring(root ~= nil),
			tostring(inWorld)
		)
end

local function characterSignals(ctx)
	local player = ctx.player(false)
	if not player then
		return {}
	end
	local list = { player.CharacterAdded, player.CharacterRemoving }
	local char = player.Character
	if char then
		table.insert(list, char.ChildAdded)
		table.insert(list, char.ChildRemoved)
		table.insert(list, char.AncestryChanged)
		local hum = char:FindFirstChildOfClass("Humanoid")
		if hum then
			table.insert(list, hum.HealthChanged)
		end
	end
	return list
end

return {
	entries = {
		Meta.define({
			name = "character.teleport",
			kind = "action",
			contexts = SC,
			default = "server",
			summary = "PivotTo the actor's character.",
			actor = "required",
			params = S.params({
				{
					"to",
					S.oneOf("Vector3, CFrame {pos,look} or selector (uses its position/pivot)", {
						S.vec(3),
						{
							type = "object",
							properties = S.props({ { "pos", S.vec(3) }, { "look", S.vec(3) } }),
							required = Meta.arr({ "pos" }),
							additionalProperties = false,
						},
						S.selector(),
					}),
				},
			}, { "to" }),
		}, {
			run = function(ctx, p)
				local char = ctx.character()
				local target
				local v3 = Resolve.vector3(p.to)
				if v3 then
					-- keep the current facing when only a position is given
					local pivot = char:GetPivot()
					target = Env.datatype("CFrame").new(v3) * (pivot - pivot.Position)
				else
					target = Resolve.toCFrame(p.to, ctx)
				end
				char:PivotTo(target)
				local root = char:FindFirstChild("HumanoidRootPart")
				if root then
					root.AssemblyLinearVelocity = Env.datatype("Vector3").zero
				end
				return target
			end,
		}),

		Meta.define({
			name = "character.moveTo",
			kind = "action",
			contexts = SC,
			default = "server",
			summary = "Humanoid:MoveTo and wait for MoveToFinished; fails if not reached within the step timeout. Client alternative: input.move.",
			actor = "required",
			params = S.params({ { "to", posOrSelector("Vector3 or selector (uses its position)") } }, { "to" }),
			notes = "Uses the step `timeout` as its budget; no timeout param.",
		}, {
			run = function(ctx, p)
				local hum = ctx.humanoid()
				local goal = Resolve.toVector3(p.to, ctx)
				local deadline = Env.clock() + ctx.budget
				local reached = false
				-- Humanoid:MoveTo gives up after 8 s; re-issue until the step budget is spent.
				while not reached and Env.clock() < deadline do
					if ctx.cancelled() then
						Errors.throw("CANCELLED", "cancelled")
					end
					local finished, result = false, false
					local conn = hum.MoveToFinished:Connect(function(r)
						finished, result = true, r
					end)
					hum:MoveTo(goal)
					local status = Conditions.waitUntil(function()
						return finished, nil
					end, {
						timeout = math.max(0, deadline - Env.clock()),
						signals = function()
							return { hum.MoveToFinished }
						end,
						cancelled = ctx.cancelled,
						cancelSignal = ctx.cancelSignal,
					})
					conn:Disconnect()
					if status == "cancelled" then
						Errors.throw("CANCELLED", "cancelled")
					end
					reached = finished and result
				end
				if not reached then
					local root = ctx.character():FindFirstChild("HumanoidRootPart")
					Errors.throw("TIMEOUT", "MoveTo did not reach the goal within the step timeout", {
						goal = { goal.X, goal.Y, goal.Z },
						distance = root and (root.Position - goal).Magnitude or nil,
					})
				end
				return nil
			end,
		}),

		Meta.define({
			name = "character.jump",
			kind = "action",
			contexts = SC,
			default = "server",
			summary = "Make the actor's Humanoid jump.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local hum = ctx.humanoid()
				hum.Jump = true
				pcall(function()
					hum:ChangeState(Env.Enum().HumanoidStateType.Jumping)
				end)
				return nil
			end,
		}),

		Meta.define({
			name = "character.equipTool",
			kind = "action",
			contexts = SC,
			default = "server",
			summary = "Equip a Tool from the actor's Backpack (Humanoid:EquipTool).",
			actor = "required",
			params = S.params({ { "tool", S.string(TOOL_DESC) } }, { "tool" }),
		}, {
			run = function(ctx, p)
				local player = ctx.player()
				local hum = ctx.humanoid()
				local tool, where
				local status = Conditions.waitUntil(function()
					tool, where = findTool(ctx, player, p.tool)
					return tool ~= nil, nil
				end, {
					timeout = math.min(ctx.budget, 2),
					cancelled = ctx.cancelled,
					cancelSignal = ctx.cancelSignal,
				})
				if status ~= "passed" or not tool then
					Errors.throw("RESOLVE_FAILED", "actor has no Tool '" .. p.tool .. "' in Backpack or character")
				end
				if where ~= "character" then
					hum:EquipTool(tool)
				end
				return tool
			end,
		}),

		Meta.define({
			name = "character.unequip",
			kind = "action",
			contexts = SC,
			default = "server",
			summary = "Unequip all tools (Humanoid:UnequipTools).",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				ctx.humanoid():UnequipTools()
				return nil
			end,
		}),

		Meta.define({
			name = "character.setHealth",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Set Humanoid.Health.",
			actor = "required",
			params = S.params({ { "value", S.number() } }, { "value" }),
		}, {
			run = function(ctx, p)
				ctx.humanoid().Health = p.value
				return nil
			end,
		}),

		Meta.define({
			name = "character.kill",
			kind = "action",
			contexts = { "server" },
			default = "server",
			summary = "Set Humanoid.Health to 0.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				ctx.humanoid().Health = 0
				return nil
			end,
		}),

		Meta.define({
			name = "character.loaded",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Actor has a character with a Humanoid and HumanoidRootPart, parented to Workspace.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local ok, _, why = loadedState(ctx.player(false))
				return ok, { loaded = ok, detail = why }
			end,
			signals = characterSignals,
		}),

		Meta.define({
			name = "character.alive",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Character loaded and Humanoid.Health > 0.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local ok, hum, why = loadedState(ctx.player(false))
				local health = hum and hum.Health or nil
				return ok and health ~= nil and health > 0, { health = health, detail = why }
			end,
			signals = characterSignals,
		}),

		Meta.define({
			name = "character.dead",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "No character, or Humanoid.Health <= 0.",
			actor = "required",
			params = S.params(),
		}, {
			run = function(ctx, _p)
				local player = ctx.player(false)
				local char = player and player.Character
				local hum = char and char:FindFirstChildOfClass("Humanoid")
				if not hum then
					return true, { character = char ~= nil }
				end
				return hum.Health <= 0, { health = hum.Health }
			end,
			signals = characterSignals,
		}),

		Meta.define({
			name = "character.near",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "HumanoidRootPart within radius studs of to.",
			actor = "required",
			params = S.params({
				{ "to", posOrSelector("Vector3 or selector (uses its position)") },
				{ "radius", { type = "number", exclusiveMinimum = 0, default = 5 } },
			}, { "to" }),
		}, {
			run = function(ctx, p)
				local char = ctx.character()
				local root = char:FindFirstChild("HumanoidRootPart")
				if not root then
					return false, { detail = "no HumanoidRootPart" }
				end
				local goal = Resolve.toVector3(p.to, ctx)
				local d = (root.Position - goal).Magnitude
				return d <= p.radius, { distance = d, position = root.Position }
			end,
			-- position has no useful signal; Heartbeat polling
		}),

		Meta.define({
			name = "character.hasTool",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Actor has the tool (Backpack or character); with equipped: true, it must be in the character.",
			actor = "required",
			params = S.params({
				{ "tool", S.string(TOOL_DESC) },
				{ "equipped", S.boolean(false) },
			}, { "tool" }),
		}, {
			run = function(ctx, p)
				local tool, where = findTool(ctx, ctx.player(), p.tool)
				local ok = tool ~= nil and (not p.equipped or where == "character")
				return ok, { found = tool ~= nil, where = where }
			end,
			signals = function(ctx)
				local player = ctx.player()
				local list = characterSignals(ctx)
				local backpack = player:FindFirstChildOfClass("Backpack")
				if backpack then
					table.insert(list, backpack.ChildAdded)
					table.insert(list, backpack.ChildRemoved)
				end
				return list
			end,
		}),

		Meta.define({
			name = "character.health",
			kind = "condition",
			contexts = SC,
			default = "server",
			summary = "Compare Humanoid.Health with value.",
			actor = "required",
			params = S.params({ { "op", S.op() }, { "value", S.number() } }, { "value" }),
		}, {
			run = function(ctx, p)
				local health = ctx.humanoid().Health
				return Conditions.compare(p.op, health, p.value), { value = health }
			end,
			signals = characterSignals,
		}),
	},
}
