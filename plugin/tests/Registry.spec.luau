local fs = require("@lune/fs")
local serde = require("@lune/serde")
local H = require("./harness")
local Setup = require("./setup")
local Registry = H.require(H.src.Registry)
local Json = H.require(H.src.Json)
local sha1 = H.require(H.src.Sha1)

local describe, it, eq, truthy = H.describe, H.it, H.eq, H.truthy

local function schemaPath(): string
	for _, p in ipairs({ "schema/catalog.json", "../schema/catalog.json", "../../schema/catalog.json" }) do
		if fs.isFile(p) then
			return p
		end
	end
	error("schema/catalog.json not found")
end

describe("Registry", function()
	Setup.dataModel()
	local raw = fs.readFile(schemaPath())
	local schema = serde.decode("json", raw)
	local metas = Registry.staticMetas()

	it("has every schema entry, in file order, with identical metas", function()
		eq(#metas, #schema.entries, "entry count")
		for i, want in ipairs(schema.entries) do
			local got = serde.decode("json", Json.encode(metas[i]))
			local ok, why = H.deepEq(got, want, want.name)
			truthy(ok, why)
		end
	end)

	it("reproduces schema/catalog.json byte-for-byte", function()
		local header = require("../../tools/catalog-header")
		local generated = Json.encode(Registry.document(header), 2) .. "\n"
		eq(#generated, #raw, "length")
		truthy(generated == raw, "catalog bytes differ")
	end)

	it("keeps metas consistent (default in contexts, actor values, unique names)", function()
		local seen = {}
		for _, m in ipairs(metas) do
			truthy(not seen[m.name], "duplicate " .. m.name)
			seen[m.name] = true
			truthy(table.find(m.contexts, m.default), m.name .. " default")
			truthy(m.actor == "required" or m.actor == "optional" or m.actor == "none", m.name .. " actor")
			truthy(m.kind == "action" or m.kind == "condition", m.name .. " kind")
		end
	end)

	it("every static entry has a run function; conditions only in condition entries", function()
		local reg = Registry.new("server")
		for _, e in ipairs(reg.static) do
			eq(type(e.run), "function", e.meta.name)
			if e.signals then
				eq(e.meta.kind, "condition", e.meta.name .. " has signals")
			end
		end
	end)

	it("returns no game.* entries without a hooks bridge", function()
		local reg = Registry.new("server")
		eq(#reg:catalog(), #metas)
		eq(reg:get("game.reset"), nil)
	end)

	it("lists game.* hooks from a bridge", function()
		local roblox = require("@lune/roblox")
		local game = Setup.dataModel()
		local rs = game:GetService("ReplicatedStorage")
		local folder = roblox.Instance.new("Folder")
		folder.Name = "StagehandHooks"
		folder.Parent = rs
		local bf = roblox.Instance.new("BindableFunction")
		bf.Name = "Invoke"
		bf.Parent = folder
		-- Lune instances cannot run OnInvoke; stand in for the bridge with a table
		local GameHooks = H.require(H.src.Actions.GameHooks)
		local original = GameHooks.bridge
		GameHooks.bridge = function()
			return {
				Invoke = function(_, req)
					if req.op == "list" then
						return {
							hooks = {
								{ name = "reset", desc = "Reset the match" },
								{ name = "inMatch", kind = "condition" },
							},
						}
					end
					return { ok = true, value = req.name == "inMatch" }
				end,
			}
		end
		local reg = Registry.new("server")
		local cat = reg:catalog()
		eq(#cat, #metas + 2)
		local inMatch = reg:get("game.inMatch")
		eq(inMatch.meta.kind, "condition")
		eq(inMatch.meta.source, "hook")
		eq(inMatch.meta.contexts[1], "server")
		eq(reg:get("game.reset").meta.summary, "Reset the match")
		local ok = inMatch.run({
			role = "server",
			player = function()
				return nil
			end,
		}, {})
		eq(ok, true)
		GameHooks.bridge = original
	end)

	it("hashes the catalog with sha1", function()
		local h = Registry.hash(metas)
		eq(#h, 40)
		eq(h, Registry.hash(table.clone(metas)))
	end)
end)

describe("Sha1 / Json", function()
	it("matches a reference sha1", function()
		for _, s in ipairs({ "", "abc", string.rep("a", 1000), "The quick brown fox jumps over the lazy dog" }) do
			eq(sha1(s), serde.hash("sha1", s), "sha1 of " .. #s .. " bytes")
		end
	end)
	it("encodes like Python json.dumps", function()
		eq(Json.encode({ a = 1, b = Json.array({}), c = Json.object({}) }), '{"a":1,"b":[],"c":{}}')
		eq(Json.encode('\u{2014}"\n'), '"\\u2014\\"\\n"')
		eq(Json.encode(Json.ordered({ "z", "a" }, { z = 1, a = Json.null })), '{"z":1,"a":null}')
		eq(Json.encode(0.5), "0.5")
		eq(Json.encode(1e20), "1e+20")
		eq(Json.encode({ 1, 2 }, 2), "[\n  1,\n  2\n]")
	end)
end)
