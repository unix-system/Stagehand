--!nonstrict
-- instance.* actions and conditions

local Meta = require(script.Parent.Parent.Meta)
local Env = require(script.Parent.Parent.Env)
local Errors = require(script.Parent.Parent.Errors)
local Resolve = require(script.Parent.Parent.Resolve)
local Conditions = require(script.Parent.Parent.Conditions)

local S = Meta.S
local ALL = { "edit", "server", "client" }

local function tags(inst): { string }
	local ok, list = pcall(function()
		return inst:GetTags()
	end)
	if ok then
		return list
	end
	local cs = Env.service("CollectionService")
	return cs and cs:GetTags(inst) or {}
end

local function hasTag(inst, tag: string): boolean
	local ok, has = pcall(function()
		return inst:HasTag(tag)
	end)
	if ok then
		return has
	end
	local cs = Env.service("CollectionService")
	return cs ~= nil and cs:HasTag(inst, tag)
end

local function getProp(inst, prop: string)
	local ok, v = pcall(function()
		return inst[prop]
	end)
	if not ok then
		Errors.throw("BAD_PARAMS", tostring(prop) .. " is not a valid member of " .. inst.ClassName)
	end
	return v
end

--- Selector-driven signals: resolve all matches and collect per-instance signals; when nothing
--- matches yet, wake on DescendantAdded of the DataModel.
local function perInstance(fn)
	return function(ctx, p)
		local list = {}
		local ok, insts = pcall(ctx.resolveAll, p.target, true)
		if ok and #insts > 0 then
			for _, inst in ipairs(insts) do
				fn(list, inst, p)
				table.insert(list, inst.AncestryChanged)
			end
		end
		local g = Env.game()
		if g and (not ok or #insts == 0 or (type(p.target) == "string" and p.target:sub(-2) == "[]")) then
			table.insert(list, g.DescendantAdded)
		end
		return list
	end
end

local function targetParams(extra: { { any } }, required: { string })
	local list = { { "target", S.selector() } }
	for _, x in ipairs(extra) do
		table.insert(list, x)
	end
	return S.params(list, required)
end

local function forAll(ctx, target, fn)
	local list = ctx.resolveAll(target)
	for _, inst in ipairs(list) do
		fn(inst)
	end
	return list
end

return {
	entries = {
		Meta.define({
			name = "instance.set",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Set a property.",
			actor = "none",
			params = targetParams({ { "prop", S.string() }, { "value", S.any() } }, { "target", "prop", "value" }),
		}, {
			run = function(ctx, p)
				-- coerce from the uncoerced JSON value using the property's current type
				local raw = if ctx.raw and ctx.raw.value ~= nil then ctx.raw.value else p.value
				forAll(ctx, p.target, function(inst)
					inst[p.prop] = Resolve.coerceForProperty(inst, p.prop, raw, ctx)
				end)
				return nil
			end,
		}),

		Meta.define({
			name = "instance.setAttribute",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Set an attribute (value null removes it).",
			actor = "none",
			params = targetParams({ { "name", S.string() }, { "value", S.any() } }, { "target", "name", "value" }),
		}, {
			run = function(ctx, p)
				forAll(ctx, p.target, function(inst)
					inst:SetAttribute(p.name, p.value)
				end)
				return nil
			end,
		}),

		Meta.define({
			name = "instance.addTag",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "CollectionService:AddTag.",
			actor = "none",
			params = targetParams({ { "tag", S.string() } }, { "target", "tag" }),
		}, {
			run = function(ctx, p)
				forAll(ctx, p.target, function(inst)
					inst:AddTag(p.tag)
				end)
				return nil
			end,
		}),

		Meta.define({
			name = "instance.removeTag",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "CollectionService:RemoveTag.",
			actor = "none",
			params = targetParams({ { "tag", S.string() } }, { "target", "tag" }),
		}, {
			run = function(ctx, p)
				forAll(ctx, p.target, function(inst)
					inst:RemoveTag(p.tag)
				end)
				return nil
			end,
		}),

		Meta.define({
			name = "instance.destroy",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Destroy the instance(s).",
			actor = "none",
			params = targetParams({}, { "target" }),
		}, {
			run = function(ctx, p)
				local list = forAll(ctx, p.target, function(inst)
					inst:Destroy()
				end)
				return #list
			end,
		}),

		Meta.define({
			name = "instance.clone",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Clone target into parent; returns the clone's path.",
			actor = "none",
			params = targetParams({
				{ "parent", S.selector() },
				{ "name", S.string("Rename the clone") },
			}, { "target", "parent" }),
			returns = { type = "string", description = "Full path of the clone" },
		}, {
			run = function(ctx, p)
				local src = ctx.resolve(p.target)
				local parent = ctx.resolve(p.parent)
				local clone = src:Clone()
				if not clone then
					Errors.throw("ACTION_ERROR", src:GetFullName() .. " is not Archivable")
				end
				if p.name then
					clone.Name = p.name
				end
				clone.Parent = parent
				return clone:GetFullName()
			end,
		}),

		Meta.define({
			name = "instance.call",
			kind = "action",
			contexts = ALL,
			default = "server",
			summary = "Call a method: target:method(args...); returns the first result.",
			actor = "none",
			params = targetParams({ { "method", S.string() }, { "args", S.args() } }, { "target", "method" }),
			returns = { description = "First return value" },
		}, {
			run = function(ctx, p)
				local inst = ctx.resolve(p.target)
				local args = {}
				for i, a in ipairs(p.args or {}) do
					if type(a) == "string" and (a:sub(1, 1) == "@" or a:sub(1, 4) == "tag:") then
						args[i] = Resolve.one(a, ctx)
					else
						args[i] = a
					end
				end
				local fn = getProp(inst, p.method)
				if type(fn) ~= "function" then
					Errors.throw("BAD_PARAMS", p.method .. " is not a method of " .. inst.ClassName)
				end
				return (fn(inst, table.unpack(args, 1, #(p.args or {}))))
			end,
		}),

		Meta.define({
			name = "instance.exists",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Selector matches at least one instance.",
			actor = "none",
			params = targetParams({}, { "target" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target, true)
				return #list > 0, { count = #list }
			end,
			signals = perInstance(function() end),
		}),

		Meta.define({
			name = "instance.hasTag",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Instance(s) have the CollectionService tag.",
			actor = "none",
			params = targetParams({ { "tag", S.string() } }, { "target", "tag" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target)
				for _, inst in ipairs(list) do
					if not hasTag(inst, p.tag) then
						return false, { value = false, target = inst, tags = tags(inst) }
					end
				end
				return true, { value = true, count = #list }
			end,
			signals = function(ctx, p)
				local list = perInstance(function() end)(ctx, p)
				local cs = Env.service("CollectionService")
				if cs then
					table.insert(list, cs:GetInstanceAddedSignal(p.tag))
					table.insert(list, cs:GetInstanceRemovedSignal(p.tag))
				end
				return list
			end,
		}),

		Meta.define({
			name = "instance.property",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Compare a property.",
			actor = "none",
			params = targetParams({
				{ "prop", S.string() },
				{ "op", S.op() },
				{ "value", S.any() },
			}, { "target", "prop", "value" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target)
				for _, inst in ipairs(list) do
					local v = getProp(inst, p.prop)
					if not Conditions.compare(p.op, v, p.value) then
						return false, { value = v, target = inst }
					end
				end
				return true, { value = getProp(list[1], p.prop) }
			end,
			signals = perInstance(function(list, inst, p)
				local ok, sig = pcall(function()
					return inst:GetPropertyChangedSignal(p.prop)
				end)
				if ok then
					table.insert(list, sig)
				end
			end),
		}),

		Meta.define({
			name = "instance.attribute",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Compare an attribute.",
			actor = "none",
			params = targetParams({
				{ "name", S.string() },
				{ "op", S.op() },
				{ "value", S.any() },
			}, { "target", "name", "value" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target)
				for _, inst in ipairs(list) do
					local v = inst:GetAttribute(p.name)
					if not Conditions.compare(p.op, v, p.value) then
						return false, { value = v, target = inst }
					end
				end
				return true, { value = list[1]:GetAttribute(p.name) }
			end,
			signals = perInstance(function(list, inst, p)
				table.insert(list, inst:GetAttributeChangedSignal(p.name))
			end),
		}),

		Meta.define({
			name = "instance.childCount",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Compare #GetChildren().",
			actor = "none",
			params = targetParams({ { "op", S.op() }, { "value", S.integer() } }, { "target", "value" }),
		}, {
			run = function(ctx, p)
				local list = ctx.resolveAll(p.target)
				for _, inst in ipairs(list) do
					local n = #inst:GetChildren()
					if not Conditions.compare(p.op, n, p.value) then
						return false, { value = n, target = inst }
					end
				end
				return true, { value = #list[1]:GetChildren() }
			end,
			signals = perInstance(function(list, inst)
				table.insert(list, inst.ChildAdded)
				table.insert(list, inst.ChildRemoved)
			end),
		}),
	},
}
