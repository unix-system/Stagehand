--!nonstrict
--[[
	Resolve — selector grammar and value coercion (docs/spec.md "Selectors" / "Values").

	Selectors are parsed into an AST and resolved lazily on every evaluation (conditions re-resolve
	while polling). `ctx` supplies `vars` and `playerFor(actorName) -> Player?`.

	Filter semantics (spec: "children matching property equality"):
	  Name[k=v]  → children of Name that match   (Workspace.Enemies[Name=Boss] → Enemies.Boss)
	  *[k=v]     → children that match           (Workspace.*[@Team=Red])
	  **[k=v]    → descendants that match
	Name matching is exact; the first segment of a path falls back to game:GetService(name).
]]

local Env = require(script.Parent.Env)
local Errors = require(script.Parent.Errors)

local Resolve = {}

export type Pred = { attr: boolean, key: string, value: any }
export type Segment = { name: string?, wild: string?, filters: { Pred } }
export type Ast = {
	kind: string, -- "path" | "actor" | "tag" | "var"
	all: boolean,
	name: string?, -- var name
	tag: string?,
	actor: string?,
	root: string?, -- player | character | gui | backpack
	segments: { Segment },
	source: string,
}

local ACTOR_ROOTS = { player = true, character = true, gui = true, backpack = true }

local function parseLiteral(raw: string): any
	local s = raw:match("^%s*(.-)%s*$") :: string
	if s == "true" then
		return true
	elseif s == "false" then
		return false
	end
	local q = s:match("^'(.*)'$") or s:match('^"(.*)"$')
	if q then
		return q
	end
	local n = tonumber(s)
	if n ~= nil then
		return n
	end
	return s
end

-- Parses `segment { "." segment }` starting at i. Returns segments or raises a parse error string.
local function parseSegments(s: string, i: number, src: string): { Segment }
	local segments = {}
	local n = #s
	if i > n then
		return segments
	end
	while true do
		local seg: Segment = { filters = {} }
		local c = s:sub(i, i)
		if c == "'" then
			local close = s:find("'", i + 1, true)
			if not close then
				error("unterminated quoted name in " .. src, 0)
			end
			seg.name = s:sub(i + 1, close - 1)
			i = close + 1
		elseif s:sub(i, i + 1) == "**" then
			seg.wild = "**"
			i += 2
		elseif c == "*" then
			seg.wild = "*"
			i += 1
		else
			local name = s:match("^[^%.%[%]']+", i)
			if not name then
				error("expected a name at position " .. i .. " in " .. src, 0)
			end
			seg.name = name
			i += #name
		end
		if s:sub(i, i) == "[" then
			local close = s:find("]", i, true)
			if not close then
				error("unterminated filter in " .. src, 0)
			end
			local body = s:sub(i + 1, close - 1)
			if body == "" then
				error("empty filter [] is only allowed at the end of " .. src, 0)
			end
			for part in (body .. ","):gmatch("([^,]*),") do
				local attr, key, lit = part:match("^%s*(@?)([%a_][%w_]*)%s*=(.*)$")
				if not key then
					error("bad filter predicate '" .. part .. "' in " .. src, 0)
				end
				table.insert(seg.filters, { attr = attr == "@", key = key, value = parseLiteral(lit) })
			end
			i = close + 1
		end
		table.insert(segments, seg)
		if i > n then
			break
		end
		if s:sub(i, i) ~= "." then
			error("expected '.' at position " .. i .. " in " .. src, 0)
		end
		i += 1
		if i > n then
			error("trailing '.' in " .. src, 0)
		end
	end
	return segments
end

--- Parse a selector string. Returns (ast) or (nil, message).
function Resolve.parse(selector: string): (Ast?, string?)
	if type(selector) ~= "string" then
		return nil, "selector must be a string"
	end
	local src = selector
	local s = selector:match("^%s*(.-)%s*$") :: string
	if s == "" then
		return nil, "empty selector"
	end
	local ast: Ast = { kind = "path", all = false, segments = {}, source = src }
	if s:sub(-2) == "[]" then
		ast.all = true
		s = s:sub(1, -3)
	end
	local ok, err = pcall(function()
		local first = s:sub(1, 1)
		if first == "$" then
			local name = s:match("^%$([%a_][%w_]*)$")
			if not name then
				error("bad var reference " .. src, 0)
			end
			ast.kind = "var"
			ast.name = name
		elseif s:sub(1, 4) == "tag:" then
			local tag = s:sub(5)
			if tag == "" or tag:find("[", 1, true) then
				error("bad tag selector " .. src, 0)
			end
			ast.kind = "tag"
			ast.tag = tag
		elseif first == "@" then
			local name = s:match("^@([%a_][%w_]*)")
			if not name then
				error("bad actor selector " .. src, 0)
			end
			ast.kind = "actor"
			ast.actor = name
			local i = 2 + #name
			if i <= #s then
				if s:sub(i, i) ~= "." then
					error("expected '.' after @" .. name .. " in " .. src, 0)
				end
				local root = s:match("^([%a_][%w_]*)", i + 1)
				if not root or not ACTOR_ROOTS[root] then
					error("actor root must be player|character|gui|backpack in " .. src, 0)
				end
				ast.root = root
				i += 1 + #root
				if i <= #s then
					if s:sub(i, i) ~= "." then
						error("expected '.' after @" .. name .. "." .. root .. " in " .. src, 0)
					end
					ast.segments = parseSegments(s, i + 1, src)
				end
			end
		else
			ast.kind = "path"
			if s == "game" then
				ast.segments = {}
			else
				if s:sub(1, 5) == "game." then
					s = s:sub(6)
				end
				ast.segments = parseSegments(s, 1, src)
			end
		end
	end)
	if not ok then
		return nil, tostring(err)
	end
	return ast, nil
end

--- True if a string looks like a selector rather than a bare name (used for "name or selector" params).
function Resolve.looksLikeSelector(s: any): boolean
	if type(s) ~= "string" then
		return false
	end
	return s:find("[%.@%$%*%[]") ~= nil or s:sub(1, 4) == "tag:"
end

-- Resolution --------------------------------------------------------------------------------

local function literalEquals(actual: any, lit: any): boolean
	if actual == lit then
		return true
	end
	local t = Env.typeof(actual)
	if t == "Instance" then
		return actual.Name == tostring(lit)
	elseif t == "EnumItem" then
		return actual.Name == tostring(lit) or tostring(actual) == tostring(lit)
	elseif t == "number" and type(lit) == "number" then
		return math.abs(actual - lit) < 1e-6
	end
	if actual == nil then
		return false
	end
	return tostring(actual) == tostring(lit)
end

local function matchesFilters(inst: any, filters: { Pred }): boolean
	for _, f in ipairs(filters) do
		local actual
		if f.attr then
			local ok, v = pcall(function()
				return inst:GetAttribute(f.key)
			end)
			actual = if ok then v else nil
		else
			local ok, v = pcall(function()
				return inst[f.key]
			end)
			actual = if ok then v else nil
		end
		if not literalEquals(actual, f.value) then
			return false
		end
	end
	return true
end

local function children(inst: any): { any }
	local ok, list = pcall(function()
		return inst:GetChildren()
	end)
	return if ok then list else {}
end

local function descendantsInto(inst: any, out: { any })
	for _, c in ipairs(children(inst)) do
		table.insert(out, c)
		descendantsInto(c, out)
	end
end

local function step(nodes: { any }, seg: Segment, isFirstPathSeg: boolean, isLast: boolean): { any }
	local out, seen = {}, {}
	local function add(x, filtered: boolean)
		if not seen[x] and (not filtered or matchesFilters(x, seg.filters)) then
			seen[x] = true
			table.insert(out, x)
		end
	end
	local hasFilters = #seg.filters > 0
	for _, node in ipairs(nodes) do
		if seg.wild == "*" then
			for _, c in ipairs(children(node)) do
				add(c, hasFilters)
			end
		elseif seg.wild == "**" then
			if not isLast and not hasFilters then
				add(node, false)
			end
			local d = {}
			descendantsInto(node, d)
			for _, c in ipairs(d) do
				add(c, hasFilters)
			end
		else
			local named = {}
			for _, c in ipairs(children(node)) do
				if c.Name == seg.name then
					table.insert(named, c)
				end
			end
			if #named == 0 and isFirstPathSeg then
				local svcName = if seg.name == "workspace" then "Workspace" else seg.name
				local svc = Env.service(svcName :: string)
				if svc then
					table.insert(named, svc)
				end
			end
			for _, m in ipairs(named) do
				if hasFilters then
					-- Name[k=v] selects Name's children that match
					for _, c in ipairs(children(m)) do
						add(c, true)
					end
				else
					add(m, false)
				end
			end
		end
	end
	return out
end

local function walk(roots: { any }, segments: { Segment }, isPath: boolean): { any }
	local nodes = roots
	for i, seg in ipairs(segments) do
		nodes = step(nodes, seg, isPath and i == 1, i == #segments)
		if #nodes == 0 then
			break
		end
	end
	return nodes
end

local function tagged(tag: string): { any }
	local cs = Env.service("CollectionService")
	if cs then
		local ok, list = pcall(function()
			return cs:GetTagged(tag)
		end)
		if ok and type(list) == "table" then
			return list
		end
	end
	-- fallback (stub DataModels): scan for HasTag
	local out = {}
	local g = Env.game()
	if g then
		local all = {}
		descendantsInto(g, all)
		for _, inst in ipairs(all) do
			local ok, has = pcall(function()
				return inst:HasTag(tag)
			end)
			if ok and has then
				table.insert(out, inst)
			end
		end
	end
	return out
end

local function actorRoot(player: any, root: string?): any
	if root == nil or root == "player" then
		return player
	elseif root == "character" then
		return player.Character
	elseif root == "gui" then
		return player:FindFirstChildOfClass("PlayerGui") or player:FindFirstChild("PlayerGui")
	elseif root == "backpack" then
		return player:FindFirstChildOfClass("Backpack") or player:FindFirstChild("Backpack")
	end
	return nil
end

local resolveAst

local function resolveValue(v: any, ctx: any, depth: number): { any }
	if Env.isInstance(v) then
		return { v }
	elseif type(v) == "string" then
		local ast, err = Resolve.parse(v)
		if not ast then
			return Errors.throw("RESOLVE_FAILED", err :: string, { selector = v })
		end
		return resolveAst(ast, ctx, depth + 1)
	elseif type(v) == "table" then
		local out = {}
		for _, x in ipairs(v) do
			for _, inst in ipairs(resolveValue(x, ctx, depth + 1)) do
				table.insert(out, inst)
			end
		end
		return out
	end
	return Errors.throw("RESOLVE_FAILED", "value is not a selector or instance: " .. tostring(v))
end

resolveAst = function(ast: Ast, ctx: any, depth: number?): { any }
	depth = depth or 0
	if (depth :: number) > 8 then
		Errors.throw("RESOLVE_FAILED", "selector var recursion too deep: " .. ast.source)
	end
	local vars = (ctx and ctx.vars) or {}
	if ast.kind == "var" then
		local v = vars[ast.name]
		if v == nil then
			Errors.throw("RESOLVE_FAILED", "var $" .. tostring(ast.name) .. " is not set", { selector = ast.source })
		end
		return resolveValue(v, ctx, depth :: number)
	elseif ast.kind == "tag" then
		return tagged(ast.tag :: string)
	elseif ast.kind == "actor" then
		local player = ctx and ctx.playerFor and ctx.playerFor(ast.actor)
		if not player then
			Errors.throw("RESOLVE_FAILED", "actor @" .. tostring(ast.actor) .. " has no Player on this node", {
				selector = ast.source,
			})
		end
		local root = actorRoot(player, ast.root)
		if not root then
			return {}
		end
		return walk({ root }, ast.segments, false)
	else
		local g = Env.game()
		if not g then
			Errors.throw("RESOLVE_FAILED", "no DataModel available")
		end
		if #ast.segments == 0 then
			return { g }
		end
		return walk({ g }, ast.segments, true)
	end
end

--- Resolve to a list of instances. Raises RESOLVE_FAILED on parse errors, and on zero matches unless
--- opts.allowEmpty. Non-`[]` selectors return at most one instance (the first match).
function Resolve.all(selector: any, ctx: any, opts: { allowEmpty: boolean? }?): ({ any }, boolean)
	local list
	local isAll = false
	if type(selector) == "string" then
		local ast, err = Resolve.parse(selector)
		if not ast then
			Errors.throw("RESOLVE_FAILED", err :: string, { selector = selector })
		end
		isAll = ast.all
		list = resolveAst(ast, ctx)
		if ast.kind == "var" and not isAll and #list > 1 then
			-- a var holding a list behaves like a `[]` selector
			local v = ctx and ctx.vars and ctx.vars[ast.name]
			if type(v) == "table" then
				isAll = true
			end
		end
	else
		list = resolveValue(selector, ctx, 0)
		isAll = type(selector) == "table" and not Env.isInstance(selector)
	end
	if not isAll and #list > 1 then
		list = { list[1] }
	end
	if #list == 0 and not (opts and opts.allowEmpty) then
		Errors.throw("RESOLVE_FAILED", "selector " .. tostring(selector) .. " matched nothing", {
			selector = tostring(selector),
		})
	end
	return list, isAll
end

--- Resolve to exactly one instance (first match).
function Resolve.one(selector: any, ctx: any): any
	return (Resolve.all(selector, ctx))[1]
end

-- Values ------------------------------------------------------------------------------------

--- Duration → seconds. Accepts numbers (seconds) and "250ms" | "10s" | "1.5m".
function Resolve.duration(v: any): (number?, string?)
	if type(v) == "number" then
		if v < 0 then
			return nil, "duration must be >= 0"
		end
		return v, nil
	end
	if type(v) ~= "string" then
		return nil, "duration must be a string or number"
	end
	local num, unit = v:match("^(%d+%.?%d*)(m?s?)$")
	if num and num:sub(-1) ~= "." and (unit == "ms" or unit == "s" or unit == "m") then
		local n = tonumber(num) :: number
		if unit == "ms" then
			return n / 1000, nil
		elseif unit == "m" then
			return n * 60, nil
		end
		return n, nil
	end
	local bare = tonumber(v)
	if bare and bare >= 0 then
		return bare, nil
	end
	return nil, "bad duration '" .. v .. "' (expected e.g. 250ms, 10s, 1.5m)"
end

local function isNumberList(t: any, n: number): boolean
	if type(t) ~= "table" or #t ~= n then
		return false
	end
	for i = 1, n do
		if type(t[i]) ~= "number" then
			return false
		end
	end
	local count = 0
	for _ in pairs(t) do
		count += 1
	end
	return count == n
end

function Resolve.vector3(t: any): any
	local V3 = Env.datatype("Vector3")
	if Env.typeof(t) == "Vector3" then
		return t
	end
	if isNumberList(t, 3) and V3 then
		return V3.new(t[1], t[2], t[3])
	end
	return nil
end

function Resolve.cframe(t: any): any
	local CF = Env.datatype("CFrame")
	if Env.typeof(t) == "CFrame" then
		return t
	end
	if type(t) == "table" and isNumberList(t.pos, 3) and CF then
		local pos = Resolve.vector3(t.pos)
		local look = t.look and Resolve.vector3(t.look)
		if look and look.Magnitude > 0 then
			return CF.lookAt(pos, pos + look)
		end
		return CF.new(pos)
	end
	return nil
end

function Resolve.enumItem(s: string): any
	local E = Env.Enum()
	local enumName, itemName = s:match("^Enum%.([%w_]+)%.([%w_]+)$")
	if not enumName or not E then
		return nil
	end
	local ok, item = pcall(function()
		return E[enumName][itemName]
	end)
	return if ok then item else nil
end

function Resolve.color3(s: string): any
	local C3 = Env.datatype("Color3")
	if type(s) ~= "string" or not s:match("^#%x%x%x%x%x%x$") or not C3 then
		return nil
	end
	local r, g, b = tonumber(s:sub(2, 3), 16), tonumber(s:sub(4, 5), 16), tonumber(s:sub(6, 7), 16)
	return C3.fromRGB(r, g, b)
end

--- Generic coercion for untyped params (spec "Values" table).
function Resolve.coerceGeneric(v: any): any
	if type(v) == "table" then
		local v3 = isNumberList(v, 3) and Resolve.vector3(v)
		if v3 then
			return v3
		end
		if v.pos ~= nil then
			local cf = Resolve.cframe(v)
			if cf then
				return cf
			end
		end
		return v
	elseif type(v) == "string" then
		if v:sub(1, 1) == "#" then
			local c = Resolve.color3(v)
			if c then
				return c
			end
		elseif v:sub(1, 5) == "Enum." then
			local e = Resolve.enumItem(v)
			if e then
				return e
			end
		end
	end
	return v
end

--- Whole-value `$name` substitution (deep, copies tables). Unknown vars are left as-is.
function Resolve.substitute(v: any, vars: { [string]: any }?): any
	if type(v) == "string" then
		local name = v:match("^%$([%a_][%w_]*)$")
		if name and vars and vars[name] ~= nil then
			return vars[name]
		end
		return v
	elseif type(v) == "table" and not Env.isInstance(v) then
		local out = {}
		for k, x in pairs(v) do
			out[k] = Resolve.substitute(x, vars)
		end
		return out
	end
	return v
end

local function deepCopy(v: any): any
	if type(v) ~= "table" then
		return v
	end
	local out = {}
	for k, x in pairs(v) do
		out[k] = deepCopy(x)
	end
	return out
end

local function isAnySchema(schema: any): boolean
	return type(schema) == "table" and schema.type == nil and schema.oneOf == nil and schema.format == nil
end

--- Coerce one param per its catalog schema.
function Resolve.coerceParam(v: any, schema: any): any
	if type(schema) ~= "table" then
		return v
	end
	if schema.format == "duration" then
		local d, err = Resolve.duration(v)
		if d == nil then
			Errors.throw("BAD_PARAMS", err :: string)
		end
		return d
	end
	if schema.format == "selector" or schema.oneOf then
		return v -- resolved lazily by the action (conditions re-resolve while polling)
	end
	local t = schema.type
	if t == nil then
		return Resolve.coerceGeneric(v)
	elseif t == "array" then
		if type(v) ~= "table" then
			Errors.throw("BAD_PARAMS", "expected an array, got " .. Env.typeof(v))
		end
		if schema.minItems == 3 and schema.maxItems == 3 and schema.items and schema.items.type == "number" then
			local v3 = Resolve.vector3(v)
			if v3 then
				return v3
			end
		end
		if schema.items and schema.items.type == "number" then
			return v
		end
		local out = {}
		for i, x in ipairs(v) do
			out[i] = Resolve.coerceGeneric(x)
		end
		return out
	elseif t == "number" or t == "integer" then
		if type(v) == "string" and tonumber(v) then
			return tonumber(v)
		end
		if type(v) ~= "number" then
			Errors.throw("BAD_PARAMS", "expected a number, got " .. Env.typeof(v))
		end
		return v
	elseif t == "boolean" then
		if type(v) ~= "boolean" then
			Errors.throw("BAD_PARAMS", "expected a boolean, got " .. Env.typeof(v))
		end
		return v
	elseif t == "string" then
		if type(v) == "number" then
			return tostring(v)
		end
		if type(v) ~= "string" then
			Errors.throw("BAD_PARAMS", "expected a string, got " .. Env.typeof(v))
		end
		return v
	end
	return v
end

--- Validate + default + coerce a raw params map against a catalog params schema.
function Resolve.applyParams(schema: any, raw: { [string]: any }?, vars: { [string]: any }?): { [string]: any }
	local p = Resolve.substitute(raw or {}, vars)
	if type(p) ~= "table" then
		Errors.throw("BAD_PARAMS", "params must be an object")
	end
	if type(schema) ~= "table" or schema.type ~= "object" then
		return p
	end
	local props = schema.properties or {}
	if schema.additionalProperties == false then
		for k in pairs(p) do
			if props[k] == nil then
				Errors.throw("BAD_PARAMS", "unknown param '" .. tostring(k) .. "'", { param = k })
			end
		end
	end
	for k, ps in pairs(props) do
		if p[k] == nil and type(ps) == "table" and ps.default ~= nil then
			p[k] = deepCopy(ps.default)
		end
	end
	for _, k in ipairs(schema.required or {}) do
		-- JSON null arrives as nil; untyped params (e.g. setAttribute value) may legitimately be null
		if p[k] == nil and not isAnySchema(props[k]) then
			Errors.throw("BAD_PARAMS", "missing required param '" .. k .. "'", { param = k })
		end
	end
	if schema.oneOf then
		local okAny = false
		for _, variant in ipairs(schema.oneOf) do
			local all = true
			for _, k in ipairs(variant.required or {}) do
				if p[k] == nil then
					all = false
				end
			end
			if all then
				okAny = true
			end
		end
		if not okAny then
			local names = {}
			for _, variant in ipairs(schema.oneOf) do
				table.insert(names, table.concat(variant.required or {}, "+"))
			end
			Errors.throw("BAD_PARAMS", "one of " .. table.concat(names, " | ") .. " is required")
		end
	end
	local out = {}
	for k, v in pairs(p) do
		local ps = props[k]
		if type(ps) == "table" and ps.enum and type(v) == "string" and not table.find(ps.enum, v) then
			Errors.throw("BAD_PARAMS", "param '" .. k .. "' must be one of " .. table.concat(ps.enum, ", "))
		end
		local ok, res = pcall(Resolve.coerceParam, v, ps)
		if not ok then
			local e = Errors.from(res, "BAD_PARAMS")
			return Errors.throw("BAD_PARAMS", "param '" .. k .. "': " .. e.message, { param = k })
		end
		out[k] = res
	end
	return out
end

--- Position-ish value (Vector3 array, {pos,look}, selector, Instance) → CFrame.
function Resolve.toCFrame(v: any, ctx: any): any
	local CF = Env.datatype("CFrame")
	local cf = Resolve.cframe(v)
	if cf then
		return cf
	end
	local v3 = Resolve.vector3(v)
	if v3 then
		return CF.new(v3)
	end
	local inst = if Env.isInstance(v) then v else Resolve.one(v, ctx)
	local ok, pivot = pcall(function()
		if inst:IsA("PVInstance") then
			return inst:GetPivot()
		elseif inst:IsA("Attachment") then
			return inst.WorldCFrame
		elseif inst:IsA("Player") and inst.Character then
			return inst.Character:GetPivot()
		end
		return nil
	end)
	if ok and pivot then
		return pivot
	end
	return Errors.throw("RESOLVE_FAILED", "cannot get a position from " .. tostring(v))
end

function Resolve.toVector3(v: any, ctx: any): any
	local v3 = Resolve.vector3(v)
	if v3 then
		return v3
	end
	return Resolve.toCFrame(v, ctx).Position
end

--- Coerce a value for assignment to inst[prop] using the current property's type.
function Resolve.coerceForProperty(inst: any, prop: string, value: any, ctx: any): any
	local ok, current = pcall(function()
		return inst[prop]
	end)
	if not ok then
		Errors.throw("BAD_PARAMS", tostring(prop) .. " is not a valid member of " .. inst.ClassName)
	end
	local t = Env.typeof(current)
	if t == "EnumItem" then
		if type(value) == "string" then
			local name = value:match("([%w_]+)$")
			local ok2, item = pcall(function()
				return current.EnumType[name]
			end)
			if ok2 and item then
				return item
			end
		elseif type(value) == "number" then
			for _, item in ipairs(current.EnumType:GetEnumItems()) do
				if item.Value == value then
					return item
				end
			end
		end
	elseif t == "BrickColor" and type(value) == "string" then
		return Env.datatype("BrickColor").new(value)
	elseif t == "Color3" then
		if type(value) == "string" then
			local c = Resolve.color3(value)
			if c then
				return c
			end
		elseif isNumberList(value, 3) then
			local C3 = Env.datatype("Color3")
			if value[1] <= 1 and value[2] <= 1 and value[3] <= 1 then
				return C3.new(value[1], value[2], value[3])
			end
			return C3.fromRGB(value[1], value[2], value[3])
		end
	elseif t == "Vector2" and isNumberList(value, 2) then
		return Env.datatype("Vector2").new(value[1], value[2])
	elseif t == "UDim2" and isNumberList(value, 4) then
		return Env.datatype("UDim2").new(value[1], value[2], value[3], value[4])
	elseif t == "CFrame" and type(value) == "table" then
		local cf = Resolve.cframe(value)
		if cf then
			return cf
		end
		local v3 = Resolve.vector3(value)
		if v3 then
			return Env.datatype("CFrame").new(v3)
		end
	elseif (t == "Instance" or (current == nil and Resolve.looksLikeSelector(value))) and type(value) == "string" then
		return Resolve.one(value, ctx)
	end
	return Resolve.coerceGeneric(value)
end

return Resolve
