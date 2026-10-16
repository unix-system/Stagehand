--!strict
--[[
	Meta — pure helpers for declaring catalog entries. No Roblox APIs: tools/gen-catalog.luau loads
	every Actions module under Lune and serialises the `meta` tables built here.

	Each Actions module returns { entries = { Meta.define(meta, impl), ... } } where
	  meta = { name, kind, contexts, default, summary, actor, params, returns?, notes? }
	  impl = { run = function(ctx, params) ... end, signals = function(ctx, params) ... end? }
	Action run returns the value storable with `save`. Condition run returns (ok, actual, expected?).
]]

local Json = require(script.Parent.Json)

local Meta = {}

Meta.OPS = { "eq", "ne", "gt", "gte", "lt", "lte", "contains", "matches" }
Meta.CONTEXTS = { "edit", "server", "client" }

export type Schema = { [string]: any }
export type EntryMeta = {
	name: string,
	kind: string,
	contexts: { string },
	default: string,
	summary: string,
	actor: string,
	params: Schema,
	returns: Schema?,
	notes: string?,
	source: string?,
}
export type Entry = {
	meta: EntryMeta,
	run: (ctx: any, params: { [string]: any }) -> ...any,
	signals: ((ctx: any, params: { [string]: any }) -> { any })?,
}

function Meta.arr<T>(t: T): T
	return Json.array(t)
end

-- Schema builders -------------------------------------------------------------------------

local S = {}
Meta.S = S

function S.string(description: string?): Schema
	return { type = "string", description = description }
end

function S.number(): Schema
	return { type = "number" }
end

function S.integer(): Schema
	return { type = "integer" }
end

function S.boolean(default: boolean?): Schema
	return { type = "boolean", default = default }
end

function S.any(): Schema
	return Json.object({})
end

function S.selector(description: string?): Schema
	return { type = "string", format = "selector", description = description }
end

function S.duration(description: string?): Schema
	return { type = "string", format = "duration", description = description }
end

function S.enum(values: { string }, default: string?, description: string?): Schema
	return { type = "string", enum = Json.array(table.clone(values)), default = default, description = description }
end

function S.op(): Schema
	return S.enum(Meta.OPS, "eq")
end

function S.vec(n: number, description: string?): Schema
	return {
		type = "array",
		items = { type = "number" },
		minItems = n,
		maxItems = n,
		description = description,
	}
end

function S.args(): Schema
	return { type = "array", default = Json.array({}), description = "Arguments (coerced per Values table)" }
end

function S.oneOf(description: string?, variants: { Schema }): Schema
	return { description = description, oneOf = Json.array(variants) }
end

--- Ordered `properties` map from { {name, schema}, ... }.
function S.props(list: { { any } }): Schema
	local keys = {}
	local t = {}
	for _, pair in ipairs(list) do
		local k = pair[1] :: string
		table.insert(keys, k)
		t[k] = pair[2]
	end
	return Json.ordered(keys, t)
end

--- Params object: list = { {name, schema}, ... }; required = names; oneOf = optional variants.
function S.params(list: { { any } }?, required: { string }?, oneOf: { Schema }?): Schema
	return {
		type = "object",
		properties = S.props(list or {}),
		required = Json.array(table.clone(required or {})),
		additionalProperties = false,
		oneOf = if oneOf then Json.array(oneOf) else nil,
	}
end

function S.requires(name: string): Schema
	return { required = Json.array({ name }) }
end

-- Entries ---------------------------------------------------------------------------------

function Meta.entry(def: { [string]: any }): EntryMeta
	assert(type(def.name) == "string", "entry name")
	assert(def.kind == "action" or def.kind == "condition", "entry kind for " .. def.name)
	local contexts = Json.array(table.clone(def.contexts))
	local default = def.default or contexts[1]
	assert(table.find(contexts, default), "default not in contexts for " .. def.name)
	return {
		name = def.name,
		kind = def.kind,
		contexts = contexts,
		default = default,
		summary = def.summary,
		actor = def.actor or "none",
		params = def.params or S.params(),
		returns = def.returns,
		notes = def.notes,
		source = def.source,
	}
end

function Meta.define(def: { [string]: any }, impl: { [string]: any }): Entry
	return {
		meta = Meta.entry(def),
		run = impl.run,
		signals = impl.signals,
	}
end

return Meta
