--!nonstrict
--[[
	Registry — static entries from Actions/* (catalog order) plus live game.* entries from the game's
	stagehand-hooks bridge. Builds the `catalog` command result and the node.ready catalogHash.
]]

local Actions = require(script.Parent.Actions)
local Json = require(script.Parent.Json)
local sha1 = require(script.Parent.Sha1)

local GameHooks = Actions.GameHooks

local Registry = {}
Registry.__index = Registry

function Registry.new(role: string)
	local self = setmetatable({
		role = role,
		static = Actions.static(),
		live = {},
		byName = {},
	}, Registry)
	for _, e in ipairs(self.static) do
		assert(self.byName[e.meta.name] == nil, "duplicate catalog entry " .. e.meta.name)
		self.byName[e.meta.name] = e
	end
	return self
end

--- Static metas in catalog order (pure; usable under Lune).
function Registry.staticMetas(): { any }
	local out = {}
	for _, e in ipairs(Actions.static()) do
		table.insert(out, e.meta)
	end
	return out
end

--- Re-read game.* hooks from the bridge. Returns the live metas.
function Registry:refreshHooks(): { any }
	for name in pairs(self.live) do
		self.byName[name] = nil
	end
	self.live = {}
	local ok, metas = pcall(GameHooks.entries, self.role)
	if ok then
		for _, meta in ipairs(metas) do
			local entry = GameHooks.toEntry(meta)
			self.live[meta.name] = entry
			self.byName[meta.name] = entry
		end
	end
	return if ok then metas else {}
end

function Registry:get(name: string)
	local e = self.byName[name]
	if e == nil and type(name) == "string" and name:sub(1, 5) == "game." then
		self:refreshHooks()
		e = self.byName[name]
	end
	return e
end

--- Catalog command result entries: static + live game.* (refreshed).
function Registry:catalog(): { any }
	local out = Registry.staticMetas()
	for _, meta in ipairs(self:refreshHooks()) do
		table.insert(out, meta)
	end
	return Json.array(out)
end

--- sha1 hex over entries sorted by name; each line = name .. compact params JSON.
function Registry.hash(metas: { any }): string
	local sorted = table.clone(metas)
	table.sort(sorted, function(a, b)
		return a.name < b.name
	end)
	local lines = {}
	for _, m in ipairs(sorted) do
		table.insert(lines, m.name .. Json.encode(m.params))
	end
	return sha1(table.concat(lines, "\n"))
end

--- Full schema/catalog.json document (used by tools/gen-catalog.luau and the parity test).
--- `header` supplies the non-entry fields; see tools/catalog-header.luau.
function Registry.document(header: { [string]: any }): any
	local doc = {
		["$comment"] = header.comment,
		version = header.version,
		ops = Json.array(table.clone(header.ops)),
		contexts = Json.array(table.clone(header.contexts)),
		entryShape = header.entryShape,
		entries = Json.array(Registry.staticMetas()),
		dynamic = Json.ordered({ "description", "game", "lua" }, {
			description = header.dynamic.description,
			game = Json.ordered({ "source", "nameTemplate", "shape", "rules" }, {
				source = header.dynamic.game.source,
				nameTemplate = header.dynamic.game.nameTemplate,
				shape = GameHooks.shape,
				rules = Json.array(table.clone(header.dynamic.game.rules)),
			}),
			lua = Json.ordered({ "description", "shape" }, {
				description = header.dynamic.lua.description,
				shape = Actions.Lua.shape,
			}),
		}),
	}
	return Json.ordered({ "$comment", "version", "ops", "contexts", "entryShape", "entries", "dynamic" }, doc)
end

return Registry
