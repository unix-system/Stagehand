--!nonstrict
-- `inspect` command: { path? | tag? | className?, depth = 1, limit = 200 } → { nodes, truncated }

local Env = require(script.Parent.Env)
local Errors = require(script.Parent.Errors)
local Json = require(script.Parent.Json)
local Resolve = require(script.Parent.Resolve)
local Serialize = require(script.Parent.Serialize)

local Inspect = {}

local function describe(inst, depth: number, budget: { n: number, truncated: boolean }): any
	budget.n -= 1
	local attrs = {}
	local okA, map = pcall(function()
		return inst:GetAttributes()
	end)
	if okA then
		for k, v in pairs(map) do
			attrs[k] = Serialize.value(v)
		end
	end
	local okT, tags = pcall(function()
		return inst:GetTags()
	end)
	local okP, path = pcall(function()
		return inst:GetFullName()
	end)
	local node = {
		path = if okP then path else inst.Name,
		className = inst.ClassName,
		name = inst.Name,
		attributes = Json.object(attrs),
		tags = Json.array(if okT then table.clone(tags) else {}),
	}
	if depth > 0 then
		local children = Json.array({})
		local okC, list = pcall(function()
			return inst:GetChildren()
		end)
		for _, c in ipairs(if okC then list else {}) do
			if budget.n <= 0 then
				budget.truncated = true
				break
			end
			table.insert(children, describe(c, depth - 1, budget))
		end
		node.children = children
	end
	return node
end

function Inspect.run(params: any, ctx: any): any
	params = params or {}
	local depth = tonumber(params.depth) or 1
	local limit = tonumber(params.limit) or 200
	local given = 0
	for _, k in ipairs({ "path", "tag", "className" }) do
		if params[k] ~= nil then
			given += 1
		end
	end
	if given ~= 1 then
		Errors.throw("BAD_PARAMS", "inspect needs exactly one of path, tag, className")
	end
	local roots
	if params.path then
		roots = Resolve.all(params.path, ctx)
	elseif params.tag then
		roots = Resolve.all("tag:" .. params.tag .. "[]", ctx, { allowEmpty = true })
	else
		roots = {}
		local g = Env.game()
		local ok, all = pcall(function()
			return g:GetDescendants()
		end)
		for _, inst in ipairs(if ok then all else {}) do
			local okIs, is = pcall(function()
				return inst:IsA(params.className)
			end)
			if okIs and is then
				table.insert(roots, inst)
				if #roots > limit then
					break
				end
			end
		end
	end
	local budget = { n = limit, truncated = false }
	local nodes = Json.array({})
	for _, inst in ipairs(roots) do
		if budget.n <= 0 then
			budget.truncated = true
			break
		end
		table.insert(nodes, describe(inst, depth, budget))
	end
	return Json.ordered({ "nodes", "truncated" }, { nodes = nodes, truncated = budget.truncated })
end

return Inspect
