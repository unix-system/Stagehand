--!nonstrict
-- log.* conditions. scope "all" is evaluated by the daemon over every node's log events; when a node
-- receives the step anyway it evaluates over its own capture (same result for single-node sessions).

local Meta = if script then require(script.Parent.Parent.Meta) else require("../Meta")

local S = Meta.S
local ALL = { "edit", "server", "client" }

local SCOPE_DESC =
	"all = every node in the session (evaluated by the daemon over log events since run start); node = the resolved node only"

local function entries(ctx)
	local capture = ctx.node and ctx.node.logCapture
	if not capture then
		return {}
	end
	return capture:sinceRunStart()
end

local function logSignals(ctx)
	local capture = ctx.node and ctx.node.logCapture
	return if capture then { capture.added } else {}
end

return {
	entries = {
		Meta.define({
			name = "log.matches",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "Some captured Output line matches a Lua pattern.",
			actor = "none",
			params = S.params({
				{ "pattern", S.string() },
				{ "level", S.enum({ "any", "info", "warn", "error" }, "any") },
				{ "scope", S.enum({ "all", "node" }, "all", SCOPE_DESC) },
			}, { "pattern" }),
		}, {
			run = function(ctx, p)
				local list = entries(ctx)
				for _, e in ipairs(list) do
					if p.level == "any" or p.level == nil or e.level == p.level then
						local ok, m = pcall(string.match, e.message, p.pattern)
						if ok and m ~= nil then
							return true, { message = e.message, level = e.level }
						end
					end
				end
				return false, { lines = #list }
			end,
			signals = logSignals,
		}),

		Meta.define({
			name = "log.noErrors",
			kind = "condition",
			contexts = ALL,
			default = "server",
			summary = "No error-level Output captured since run start.",
			actor = "none",
			params = S.params({ { "scope", S.enum({ "all", "node" }, "all", SCOPE_DESC) } }, {}),
		}, {
			run = function(ctx, _p)
				local errs = {}
				for _, e in ipairs(entries(ctx)) do
					if e.level == "error" then
						table.insert(errs, e.message)
					end
				end
				return #errs == 0, { errors = errs }
			end,
			signals = logSignals,
		}),
	},
}
